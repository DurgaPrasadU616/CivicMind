// backend/src/services/storage.ts
//
// Phase 3 & Phase 2A — Storage Provider Abstraction for Complaint Media
//
// Design: Provider-agnostic interface so the application never hardcodes a
// storage backend. The active provider is selected via MEDIA_STORAGE_PROVIDER env var.
//
// Supported providers:
//   local — stores files on the local filesystem under MEDIA_STORAGE_DIR
//           (default: ./uploads — suitable for local development and test runs)
//   r2 / s3 — Cloudflare R2 / AWS S3 compatible object storage via @aws-sdk/client-s3.
//             Keeps bucket private, serves media via presigned URLs with short TTL.
//
// Environment variables:
//   MEDIA_STORAGE_PROVIDER = 'local' | 'r2' | 's3' (default: 'local')
//   MEDIA_STORAGE_DIR      = './uploads' (local provider only)
//
// For Cloudflare R2:
//   R2_ACCOUNT_ID          = '<cloudflare_account_id>'
//   R2_ACCESS_KEY_ID       = '<r2_access_key_id>'
//   R2_SECRET_ACCESS_KEY   = '<r2_secret_access_key>'
//   R2_BUCKET_NAME         = '<r2_bucket_name>'
//   R2_PUBLIC_BASE_URL     = 'https://...' (optional)

import fs from 'fs';
import path from 'path';
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  HeadObjectCommand,
  CopyObjectCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { env } from '../config/env';
import logger from '../utils/logger';

// ── Interface ─────────────────────────────────────────────────────────────────

export interface StorageProvider {
  /**
   * Persist a file buffer under the given storage key.
   * Returns the storage key (may differ from input if provider adjusts it).
   */
  put(key: string, buffer: Buffer, mimeType: string): Promise<string>;

  /**
   * Retrieve the raw bytes of a stored file.
   * Throws if the file does not exist.
   */
  get(key: string): Promise<Buffer>;

  /**
   * Delete a stored file. Resolves silently if the file does not exist.
   */
  delete(key: string): Promise<void>;

  /**
   * Returns true if the file exists in storage.
   */
  exists(key: string): Promise<boolean>;

  /**
   * Returns a URL or path that can be used to serve the file to an
   * authenticated request. For local storage this is a relative backend route;
   * for R2/S3 this is a short-lived presigned GET URL (bucket stays private).
   */
  getServeUrl(key: string, ttlSeconds?: number): Promise<string>;

  /**
   * Generates a presigned PUT URL for direct browser uploads.
   * If unsupported by the provider (e.g. local storage in dev without external mock),
   * returns null or throws.
   */
  getPresignedUploadUrl?(
    key: string,
    mimeType: string,
    fileSizeBytes?: number,
    ttlSeconds?: number
  ): Promise<string>;

  /**
   * Inspects object metadata in storage (size, mime type).
   */
  getMetadata?(key: string): Promise<{ size: number; mimeType?: string } | null>;

  /**
   * Copies an object within the storage provider from sourceKey to destinationKey.
   */
  copy?(sourceKey: string, destinationKey: string): Promise<void>;
}

// ── Security Helper: Storage Key Validation ───────────────────────────────────

/**
 * Validates that an object key does not attempt path traversal or contain invalid characters.
 * Rejects absolute paths, backslashes, leading slashes, and '..' segments.
 */
export function validateStorageKey(key: string): void {
  if (!key || typeof key !== 'string') {
    throw new Error('[STORAGE] Storage key must be a non-empty string');
  }

  // Block path traversal and backslashes
  if (key.includes('..') || key.includes('\\') || key.startsWith('/')) {
    throw new Error(`[STORAGE] Path traversal blocked for key: ${key}`);
  }

  // Ensure normalized path matches original structure (no hidden navigation)
  const normalized = path.posix.normalize(key);
  if (normalized.startsWith('../') || normalized === '..' || normalized.startsWith('/')) {
    throw new Error(`[STORAGE] Path traversal blocked for key: ${key}`);
  }
}

// ── Local Filesystem Provider ─────────────────────────────────────────────────

export class LocalStorageProvider implements StorageProvider {
  private baseDir: string;

  constructor(baseDir: string) {
    this.baseDir = path.resolve(baseDir);
    // Ensure the directory exists at startup
    fs.mkdirSync(this.baseDir, { recursive: true });
    logger.info(`[STORAGE] LocalStorageProvider initialized at: ${this.baseDir}`);
  }

  private safePath(key: string): string {
    validateStorageKey(key);
    // Prevent path traversal: resolve the full path and assert it stays inside baseDir
    const resolved = path.resolve(this.baseDir, key);
    if (!resolved.startsWith(this.baseDir + path.sep) && resolved !== this.baseDir) {
      throw new Error(`[STORAGE] Path traversal blocked for key: ${key}`);
    }
    return resolved;
  }

  async put(key: string, buffer: Buffer, _mimeType: string): Promise<string> {
    const filePath = this.safePath(key);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    await fs.promises.writeFile(filePath, buffer);
    logger.debug(`[STORAGE] Written ${buffer.length} bytes to ${filePath}`);
    return key;
  }

  async get(key: string): Promise<Buffer> {
    const filePath = this.safePath(key);
    return fs.promises.readFile(filePath);
  }

  async delete(key: string): Promise<void> {
    const filePath = this.safePath(key);
    try {
      await fs.promises.unlink(filePath);
    } catch (err: any) {
      if (err.code !== 'ENOENT') throw err;
    }
  }

  async exists(key: string): Promise<boolean> {
    const filePath = this.safePath(key);
    try {
      await fs.promises.access(filePath);
      return true;
    } catch {
      return false;
    }
  }

  async getServeUrl(key: string, _ttlSeconds = 300): Promise<string> {
    validateStorageKey(key);
    return `/api/media/${encodeURIComponent(key)}`;
  }

  async getMetadata(key: string): Promise<{ size: number; mimeType?: string } | null> {
    const filePath = this.safePath(key);
    try {
      const stats = await fs.promises.stat(filePath);
      return { size: stats.size };
    } catch (err: any) {
      if (err.code === 'ENOENT') return null;
      throw err;
    }
  }

  async copy(sourceKey: string, destinationKey: string): Promise<void> {
    const srcPath = this.safePath(sourceKey);
    const destPath = this.safePath(destinationKey);
    fs.mkdirSync(path.dirname(destPath), { recursive: true });
    await fs.promises.copyFile(srcPath, destPath);
  }

  async getPresignedUploadUrl(
    key: string,
    _mimeType: string,
    _fileSizeBytes?: number,
    _ttlSeconds = 900
  ): Promise<string> {
    validateStorageKey(key);
    // For local development, presigned uploads can route to an upload handler or simulated endpoint
    return `/api/media/upload-local/${encodeURIComponent(key)}`;
  }
}

// ── Cloudflare R2 / AWS S3 Provider ───────────────────────────────────────────

export interface S3StorageProviderConfig {
  accountId?: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucketName: string;
  endpoint?: string;
  publicBaseUrl?: string;
  s3Client?: S3Client; // Injection point for testing / mocking
}

export class S3StorageProvider implements StorageProvider {
  private client: S3Client;
  private bucket: string;
  private publicBaseUrl?: string;

  constructor(config: S3StorageProviderConfig) {
    if (!config.bucketName) {
      throw new Error('[STORAGE] Missing required R2/S3 bucket name (R2_BUCKET_NAME)');
    }
    if (!config.accessKeyId || !config.secretAccessKey) {
      throw new Error('[STORAGE] Missing required R2/S3 credentials (R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY)');
    }

    this.bucket = config.bucketName;
    this.publicBaseUrl = config.publicBaseUrl;

    if (config.s3Client) {
      this.client = config.s3Client;
    } else {
      // Endpoint resolution for Cloudflare R2: https://<account_id>.r2.cloudflarestorage.com
      const endpoint =
        config.endpoint ||
        (config.accountId
          ? `https://${config.accountId}.r2.cloudflarestorage.com`
          : undefined);

      if (!endpoint) {
        throw new Error(
          '[STORAGE] Missing required R2_ACCOUNT_ID to construct Cloudflare R2 endpoint URL'
        );
      }

      this.client = new S3Client({
        region: 'auto',
        endpoint,
        credentials: {
          accessKeyId: config.accessKeyId,
          secretAccessKey: config.secretAccessKey,
        },
      });
    }

    logger.info(`[STORAGE] S3StorageProvider initialized for bucket: ${this.bucket}`);
  }

  async put(key: string, buffer: Buffer, mimeType: string): Promise<string> {
    validateStorageKey(key);

    const command = new PutObjectCommand({
      Bucket: this.bucket,
      Key: key,
      Body: buffer,
      ContentType: mimeType,
    });

    try {
      await this.client.send(command);
      logger.debug(`[STORAGE] Uploaded ${buffer.length} bytes to R2/S3: ${key}`);
      return key;
    } catch (err: any) {
      logger.error(`[STORAGE] R2/S3 put failed for key "${key}": ${err.message}`);
      throw err;
    }
  }

  async get(key: string): Promise<Buffer> {
    validateStorageKey(key);

    const command = new GetObjectCommand({
      Bucket: this.bucket,
      Key: key,
    });

    try {
      const response = await this.client.send(command);
      if (!response.Body) {
        throw new Error(`[STORAGE] Empty body returned for key: ${key}`);
      }

      // Convert stream to Buffer (AWS SDK v3 response.Body is a Readable stream in Node)
      const stream = response.Body as any;
      if (typeof stream.transformToByteArray === 'function') {
        const byteArray = await stream.transformToByteArray();
        return Buffer.from(byteArray);
      }

      const chunks: Buffer[] = [];
      for await (const chunk of stream) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      return Buffer.concat(chunks);
    } catch (err: any) {
      if (err.name === 'NoSuchKey' || err.$metadata?.httpStatusCode === 404) {
        const notFound: any = new Error(`File not found in storage: ${key}`);
        notFound.code = 'ENOENT';
        throw notFound;
      }
      logger.error(`[STORAGE] R2/S3 get failed for key "${key}": ${err.message}`);
      throw err;
    }
  }

  async delete(key: string): Promise<void> {
    validateStorageKey(key);

    const command = new DeleteObjectCommand({
      Bucket: this.bucket,
      Key: key,
    });

    try {
      await this.client.send(command);
      logger.debug(`[STORAGE] Deleted key from R2/S3: ${key}`);
    } catch (err: any) {
      // In S3, deleting a non-existent key returns 204/success, but if another error occurs:
      if (err.name === 'NoSuchKey' || err.$metadata?.httpStatusCode === 404) {
        return;
      }
      logger.error(`[STORAGE] R2/S3 delete failed for key "${key}": ${err.message}`);
      throw err;
    }
  }

  async exists(key: string): Promise<boolean> {
    validateStorageKey(key);

    const command = new HeadObjectCommand({
      Bucket: this.bucket,
      Key: key,
    });

    try {
      await this.client.send(command);
      return true;
    } catch (err: any) {
      if (
        err.name === 'NotFound' ||
        err.name === 'NoSuchKey' ||
        err.$metadata?.httpStatusCode === 404
      ) {
        return false;
      }
      logger.error(`[STORAGE] R2/S3 exists check encountered operational failure for key "${key}": ${err.message}`);
      throw err;
    }
  }

  async getMetadata(key: string): Promise<{ size: number; mimeType?: string } | null> {
    validateStorageKey(key);

    const command = new HeadObjectCommand({
      Bucket: this.bucket,
      Key: key,
    });

    try {
      const res = await this.client.send(command);
      return {
        size: res.ContentLength || 0,
        mimeType: res.ContentType,
      };
    } catch (err: any) {
      if (
        err.name === 'NotFound' ||
        err.name === 'NoSuchKey' ||
        err.$metadata?.httpStatusCode === 404
      ) {
        return null;
      }
      logger.error(`[STORAGE] R2/S3 getMetadata failed for key "${key}": ${err.message}`);
      throw err;
    }
  }

  async copy(sourceKey: string, destinationKey: string): Promise<void> {
    validateStorageKey(sourceKey);
    validateStorageKey(destinationKey);

    const command = new CopyObjectCommand({
      Bucket: this.bucket,
      CopySource: `${this.bucket}/${sourceKey}`,
      Key: destinationKey,
    });

    try {
      await this.client.send(command);
      logger.debug(`[STORAGE] Copied object in R2/S3 from "${sourceKey}" to "${destinationKey}"`);
    } catch (err: any) {
      logger.error(`[STORAGE] R2/S3 copy failed from "${sourceKey}" to "${destinationKey}": ${err.message}`);
      throw err;
    }
  }

  async getPresignedUploadUrl(
    key: string,
    mimeType: string,
    fileSizeBytes?: number,
    ttlSeconds = 900 // 15 minutes default
  ): Promise<string> {
    validateStorageKey(key);

    const command = new PutObjectCommand({
      Bucket: this.bucket,
      Key: key,
      ContentType: mimeType,
      ...(fileSizeBytes ? { ContentLength: fileSizeBytes } : {}),
    });

    try {
      return await getSignedUrl(this.client, command, { expiresIn: ttlSeconds });
    } catch (err: any) {
      logger.error(`[STORAGE] Failed to generate presigned upload URL for key "${key}": ${err.message}`);
      throw err;
    }
  }

  async getServeUrl(key: string, ttlSeconds = 300): Promise<string> {
    validateStorageKey(key);

    // If a custom public CDN base URL is configured, use it (only if bucket public access is explicitly desired)
    if (this.publicBaseUrl) {
      const baseUrl = this.publicBaseUrl.replace(/\/+$/, '');
      return `${baseUrl}/${encodeURI(key)}`;
    }

    // Default private security model: Generate a short-lived presigned GET URL
    const command = new GetObjectCommand({
      Bucket: this.bucket,
      Key: key,
    });

    try {
      return await getSignedUrl(this.client, command, { expiresIn: ttlSeconds });
    } catch (err: any) {
      logger.error(`[STORAGE] Failed to generate presigned GET URL for key "${key}": ${err.message}`);
      throw err;
    }
  }
}

// ── Provider Registry ─────────────────────────────────────────────────────────

let _provider: StorageProvider | null = null;

export function getStorageProvider(): StorageProvider {
  if (_provider) return _provider;

  const providerName = (process.env.MEDIA_STORAGE_PROVIDER || env.MEDIA_STORAGE_PROVIDER || 'local').toLowerCase();

  switch (providerName) {
    case 'r2':
    case 's3': {
      const accountId = process.env.R2_ACCOUNT_ID || env.R2_ACCOUNT_ID;
      const accessKeyId = process.env.R2_ACCESS_KEY_ID || env.R2_ACCESS_KEY_ID;
      const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY || env.R2_SECRET_ACCESS_KEY;
      const bucketName = process.env.R2_BUCKET_NAME || env.R2_BUCKET_NAME;
      const publicBaseUrl = process.env.R2_PUBLIC_BASE_URL || env.R2_PUBLIC_BASE_URL;

      if (!bucketName || !accessKeyId || !secretAccessKey) {
        logger.error(
          '[STORAGE] Cloudflare R2 requested but required environment variables (R2_BUCKET_NAME, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY) are missing.'
        );
        throw new Error('Cloudflare R2 storage credentials not configured.');
      }

      _provider = new S3StorageProvider({
        accountId,
        accessKeyId,
        secretAccessKey,
        bucketName,
        publicBaseUrl,
      });
      break;
    }

    case 'local': {
      const dir = process.env.MEDIA_STORAGE_DIR || env.MEDIA_STORAGE_DIR || './uploads';
      _provider = new LocalStorageProvider(dir);
      break;
    }

    default:
      logger.warn(`[STORAGE] Unknown MEDIA_STORAGE_PROVIDER="${providerName}", falling back to local`);
      _provider = new LocalStorageProvider(process.env.MEDIA_STORAGE_DIR || env.MEDIA_STORAGE_DIR || './uploads');
  }

  return _provider;
}

/** Reset provider singleton (for testing). */
export function _resetStorageProvider(): void {
  _provider = null;
}
