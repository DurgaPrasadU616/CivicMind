import {
  StorageProvider,
  LocalStorageProvider,
  S3StorageProvider,
  ImageKitStorageProvider,
  validateStorageKey,
  getStorageProvider,
  _resetStorageProvider,
} from '../src/services/storage';
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  HeadObjectCommand,
} from '@aws-sdk/client-s3';
import fs from 'fs';
import path from 'path';

describe('Storage Key Validation & Path Traversal Prevention', () => {
  it('allows safe alphanumeric keys with nested directories', () => {
    expect(() => validateStorageKey('complaints/12/evidence.jpg')).not.toThrow();
    expect(() => validateStorageKey('images/2026/file-abc_123.png')).not.toThrow();
  });

  it('rejects empty, null, or non-string keys', () => {
    expect(() => validateStorageKey('')).toThrow(/Storage key must be a non-empty string/);
    expect(() => validateStorageKey(null as any)).toThrow();
    expect(() => validateStorageKey(undefined as any)).toThrow();
  });

  it('rejects keys containing path traversal patterns (..)', () => {
    expect(() => validateStorageKey('../secret.env')).toThrow(/Path traversal blocked/);
    expect(() => validateStorageKey('complaints/../../etc/passwd')).toThrow(/Path traversal blocked/);
    expect(() => validateStorageKey('a/b/../c')).toThrow(/Path traversal blocked/);
  });

  it('rejects keys with backslashes or leading slashes', () => {
    expect(() => validateStorageKey('\\windows\\system32')).toThrow(/Path traversal blocked/);
    expect(() => validateStorageKey('/root/secret')).toThrow(/Path traversal blocked/);
  });
});

describe('LocalStorageProvider', () => {
  const testDir = path.resolve(__dirname, '../tmp/test_uploads');
  let provider: LocalStorageProvider;

  beforeAll(() => {
    provider = new LocalStorageProvider(testDir);
  });

  afterAll(() => {
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('puts, gets, verifies existence, and deletes a file', async () => {
    const key = 'test-folder/sample.txt';
    const content = Buffer.from('CivicMind local storage test data');

    await provider.put(key, content, 'text/plain');

    const exists = await provider.exists(key);
    expect(exists).toBe(true);

    const retrieved = await provider.get(key);
    expect(retrieved.equals(content)).toBe(true);

    const serveUrl = await provider.getServeUrl(key);
    expect(serveUrl).toBe(`/api/media/${encodeURIComponent(key)}`);

    await provider.delete(key);
    const existsAfterDelete = await provider.exists(key);
    expect(existsAfterDelete).toBe(false);
  });

  it('blocks path traversal on local storage operations', async () => {
    await expect(provider.get('../../etc/passwd')).rejects.toThrow(/Path traversal blocked/);
    await expect(provider.put('../outside.txt', Buffer.from('data'), 'text/plain')).rejects.toThrow(
      /Path traversal blocked/
    );
  });
});

describe('S3StorageProvider (Cloudflare R2 Compatibility)', () => {
  let mockSend: jest.Mock;
  let mockS3Client: S3Client;
  let provider: S3StorageProvider;

  beforeEach(() => {
    mockSend = jest.fn();
    const realClient = new S3Client({
      region: 'auto',
      endpoint: 'https://test-account.r2.cloudflarestorage.com',
      credentials: {
        accessKeyId: 'test-key-id',
        secretAccessKey: 'test-secret-key',
      },
    });
    mockS3Client = realClient;
    mockS3Client.send = mockSend as any;

    provider = new S3StorageProvider({
      accessKeyId: 'test-key-id',
      secretAccessKey: 'test-secret-key',
      bucketName: 'test-bucket',
      endpoint: 'https://test-account.r2.cloudflarestorage.com',
      s3Client: mockS3Client,
    });
  });

  it('validates required credentials and throws if missing', () => {
    expect(() => {
      new S3StorageProvider({
        accessKeyId: '',
        secretAccessKey: '',
        bucketName: 'test-bucket',
      });
    }).toThrow(/Missing required R2\/S3 credentials/);

    expect(() => {
      new S3StorageProvider({
        accessKeyId: 'key',
        secretAccessKey: 'sec',
        bucketName: '',
      });
    }).toThrow(/Missing required R2\/S3 bucket name/);

    expect(() => {
      new S3StorageProvider({
        accessKeyId: 'key',
        secretAccessKey: 'sec',
        bucketName: 'bucket',
      });
    }).toThrow(/Missing required R2_ACCOUNT_ID/);
  });

  it('puts object with correct bucket, key, and content type', async () => {
    mockSend.mockResolvedValueOnce({} as any);

    const key = 'complaints/101/image.png';
    const buffer = Buffer.from('fake-image-bytes');

    const result = await provider.put(key, buffer, 'image/png');
    expect(result).toBe(key);
    expect(mockSend).toHaveBeenCalledTimes(1);

    const command = mockSend.mock.calls[0][0];
    expect(command).toBeInstanceOf(PutObjectCommand);
    expect(command.input).toMatchObject({
      Bucket: 'test-bucket',
      Key: key,
      Body: buffer,
      ContentType: 'image/png',
    });
  });

  it('gets object and returns byte buffer', async () => {
    const fakeData = Buffer.from('r2-retrieved-bytes');
    mockSend.mockResolvedValueOnce({
      Body: {
        transformToByteArray: async () => new Uint8Array(fakeData),
      },
    } as any);

    const key = 'complaints/101/image.png';
    const result = await provider.get(key);

    expect(result.equals(fakeData)).toBe(true);
    const command = mockSend.mock.calls[0][0];
    expect(command).toBeInstanceOf(GetObjectCommand);
    expect(command.input).toMatchObject({
      Bucket: 'test-bucket',
      Key: key,
    });
  });

  it('handles NoSuchKey / 404 in get by throwing ENOENT', async () => {
    const error: any = new Error('NoSuchKey');
    error.name = 'NoSuchKey';
    mockSend.mockRejectedValueOnce(error);

    await expect(provider.get('missing/key.jpg')).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('checks object existence via HeadObjectCommand', async () => {
    mockSend.mockResolvedValueOnce({} as any);

    const exists = await provider.exists('complaints/101/image.png');
    expect(exists).toBe(true);

    const command = mockSend.mock.calls[0][0];
    expect(command).toBeInstanceOf(HeadObjectCommand);
  });

  it('returns false for exists only if HeadObject returns NotFound / 404', async () => {
    const error: any = new Error('Not Found');
    error.name = 'NotFound';
    error.$metadata = { httpStatusCode: 404 };
    mockSend.mockRejectedValueOnce(error);

    const exists = await provider.exists('nonexistent.png');
    expect(exists).toBe(false);
  });

  it('propagates authentication, permission, and network errors from exists()', async () => {
    const authError: any = new Error('Access Denied');
    authError.name = 'AccessDenied';
    authError.$metadata = { httpStatusCode: 403 };
    mockSend.mockRejectedValueOnce(authError);

    await expect(provider.exists('complaints/101/image.png')).rejects.toThrow('Access Denied');

    const netError: any = new Error('ETIMEDOUT');
    mockSend.mockRejectedValueOnce(netError);

    await expect(provider.exists('complaints/101/image.png')).rejects.toThrow('ETIMEDOUT');
  });

  it('inspects metadata via getMetadata and returns size and mimeType', async () => {
    mockSend.mockResolvedValueOnce({
      ContentLength: 4096,
      ContentType: 'image/png',
    } as any);

    const meta = await provider.getMetadata!('complaints/101/image.png');
    expect(meta).toEqual({ size: 4096, mimeType: 'image/png' });

    // When file does not exist (404), returns null
    const error: any = new Error('Not Found');
    error.name = 'NotFound';
    error.$metadata = { httpStatusCode: 404 };
    mockSend.mockRejectedValueOnce(error);

    const nullMeta = await provider.getMetadata!('complaints/101/missing.png');
    expect(nullMeta).toBeNull();
  });

  it('generates presigned PUT upload URL for direct browser uploads', async () => {
    const key = 'complaints/101/direct-upload.jpg';
    const uploadUrl = await provider.getPresignedUploadUrl!(key, 'image/jpeg', 2048, 600);
    expect(typeof uploadUrl).toBe('string');
    expect(uploadUrl).toContain('test-account.r2.cloudflarestorage.com');
    expect(uploadUrl).toContain('complaints/101/direct-upload.jpg');
    expect(uploadUrl).toContain('X-Amz-Signature');
  });

  it('deletes object via DeleteObjectCommand', async () => {
    mockSend.mockResolvedValueOnce({} as any);

    await provider.delete('complaints/101/old-image.png');
    expect(mockSend).toHaveBeenCalledTimes(1);

    const command = mockSend.mock.calls[0][0];
    expect(command).toBeInstanceOf(DeleteObjectCommand);
    expect(command.input).toMatchObject({
      Bucket: 'test-bucket',
      Key: 'complaints/101/old-image.png',
    });
  });

  it('surfaces network and operational failures properly', async () => {
    const networkError = new Error('Connection reset by peer');
    mockSend.mockRejectedValueOnce(networkError);

    await expect(provider.put('key.jpg', Buffer.from('abc'), 'image/jpeg')).rejects.toThrow(
      'Connection reset by peer'
    );
  });

  it('generates presigned serve URL keeping bucket private by default', async () => {
    const key = 'complaints/101/private-evidence.png';
    const serveUrl = await provider.getServeUrl(key, 600);
    expect(typeof serveUrl).toBe('string');
    expect(serveUrl).toContain('test-account.r2.cloudflarestorage.com');
    expect(serveUrl).toContain('complaints/101/private-evidence.png');
    expect(serveUrl).toContain('X-Amz-Signature');
  });

  it('uses publicBaseUrl when explicitly provided for CDN delivery', async () => {
    const cdnProvider = new S3StorageProvider({
      accessKeyId: 'test-key-id',
      secretAccessKey: 'test-secret-key',
      bucketName: 'test-bucket',
      endpoint: 'https://test-account.r2.cloudflarestorage.com',
      publicBaseUrl: 'https://media.civicmind.org',
      s3Client: mockS3Client,
    });

    const key = 'complaints/101/evidence.png';
    const serveUrl = await cdnProvider.getServeUrl(key);
    expect(serveUrl).toBe('https://media.civicmind.org/complaints/101/evidence.png');
  });
});

describe('ImageKitStorageProvider', () => {
  let mockFetch: jest.Mock;
  let provider: ImageKitStorageProvider;

  beforeEach(() => {
    mockFetch = jest.fn();
    provider = new ImageKitStorageProvider({
      publicKey: 'test-public-key',
      privateKey: 'test-private-key',
      urlEndpoint: 'https://ik.imagekit.io/test-endpoint',
      fetchFn: mockFetch as any,
    });
  });

  it('validates required credentials and throws if missing', () => {
    expect(() => {
      new ImageKitStorageProvider({
        publicKey: '',
        privateKey: 'key',
        urlEndpoint: 'https://ik.imagekit.io/endpoint',
      });
    }).toThrow(/Missing required ImageKit credentials/);

    expect(() => {
      new ImageKitStorageProvider({
        publicKey: 'pub',
        privateKey: '',
        urlEndpoint: 'https://ik.imagekit.io/endpoint',
      });
    }).toThrow(/Missing required ImageKit credentials/);

    expect(() => {
      new ImageKitStorageProvider({
        publicKey: 'pub',
        privateKey: 'priv',
        urlEndpoint: '',
      });
    }).toThrow(/Missing required ImageKit credentials/);
  });

  it('blocks path traversal on ImageKit storage operations', async () => {
    await expect(provider.get('../../etc/passwd')).rejects.toThrow(/Path traversal blocked/);
    await expect(provider.put('../outside.txt', Buffer.from('data'), 'text/plain')).rejects.toThrow(
      /Path traversal blocked/
    );
    await expect(provider.delete('/root/secret')).rejects.toThrow(/Path traversal blocked/);
    await expect(provider.exists('\\windows\\system32')).rejects.toThrow(/Path traversal blocked/);
  });

  it('puts object with correct endpoint, auth header, and FormData', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ fileId: 'img_123' }),
    });

    const key = 'complaints/101/image.png';
    const buffer = Buffer.from('fake-image-bytes');

    const result = await provider.put(key, buffer, 'image/png');
    expect(result).toBe(key);
    expect(mockFetch).toHaveBeenCalledTimes(1);

    const [url, options] = mockFetch.mock.calls[0];
    expect(url).toBe('https://upload.imagekit.io/api/v1/files/upload');
    expect(options.method).toBe('POST');
    expect(options.headers.Authorization).toBe(
      'Basic ' + Buffer.from('test-private-key:').toString('base64')
    );
    expect(options.body).toBeInstanceOf(FormData);
  });

  it('handles put error from ImageKit API', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 400,
      text: async () => 'Invalid file format',
    });

    await expect(
      provider.put('complaints/101/bad.xyz', Buffer.from('bad'), 'application/xyz')
    ).rejects.toThrow(/ImageKit upload failed with HTTP 400/);
  });

  it('gets object and returns byte buffer', async () => {
    const fakeData = Buffer.from('imagekit-retrieved-bytes');
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      arrayBuffer: async () => new Uint8Array(fakeData).buffer,
    });

    const key = 'complaints/101/image.png';
    const result = await provider.get(key);

    expect(result.equals(fakeData)).toBe(true);
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const calledUrl = mockFetch.mock.calls[0][0];
    expect(calledUrl).toContain('https://ik.imagekit.io/test-endpoint/complaints/101/image.png');
    expect(calledUrl).toContain('ik-t=');
    expect(calledUrl).toContain('ik-s=');
  });

  it('handles 404 in get by throwing ENOENT', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 404,
    });

    await expect(provider.get('missing/key.jpg')).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('checks object existence via exists()', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => [
        {
          fileId: 'file_1',
          name: 'image.png',
          filePath: '/complaints/101/image.png',
        },
      ],
    });

    const exists = await provider.exists('complaints/101/image.png');
    expect(exists).toBe(true);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('returns false for exists when file is not found (404 or empty list)', async () => {
    // 404 response
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 404,
    });
    expect(await provider.exists('nonexistent.png')).toBe(false);

    // Empty list response
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => [],
    });
    expect(await provider.exists('nonexistent.png')).toBe(false);
  });

  it('propagates authentication, permission, and server errors from exists()', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 401,
      text: async () => 'Unauthorized',
    });

    await expect(provider.exists('complaints/101/image.png')).rejects.toThrow(
      /ImageKit API query failed with HTTP 401/
    );

    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 500,
      text: async () => 'Internal Server Error',
    });

    await expect(provider.exists('complaints/101/image.png')).rejects.toThrow(
      /ImageKit API query failed with HTTP 500/
    );
  });

  it('inspects metadata via getMetadata and returns size and mimeType', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => [
        {
          fileId: 'file_1',
          name: 'image.png',
          filePath: '/complaints/101/image.png',
          size: 8192,
          mime: 'image/png',
        },
      ],
    });

    const meta = await provider.getMetadata!('complaints/101/image.png');
    expect(meta).toEqual({ size: 8192, mimeType: 'image/png' });

    // When file does not exist, returns null
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => [],
    });

    const nullMeta = await provider.getMetadata!('complaints/101/missing.png');
    expect(nullMeta).toBeNull();
  });

  it('deletes object by finding fileId and calling DELETE endpoint', async () => {
    // 1. List query returns file
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => [
        {
          fileId: 'file_del_999',
          name: 'old-image.png',
          filePath: '/complaints/101/old-image.png',
        },
      ],
    });
    // 2. Delete request succeeds
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
    });

    await provider.delete('complaints/101/old-image.png');
    expect(mockFetch).toHaveBeenCalledTimes(2);

    const [deleteUrl, deleteOptions] = mockFetch.mock.calls[1];
    expect(deleteUrl).toBe('https://api.imagekit.io/v1/files/file_del_999');
    expect(deleteOptions.method).toBe('DELETE');
  });

  it('resolves silently on delete when file does not exist', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => [],
    });

    await expect(provider.delete('complaints/101/nonexistent.png')).resolves.toBeUndefined();
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('copies object using /v1/files/copy', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
    });

    await provider.copy!(
      'staging/complaints/101/file.png',
      'complaints/101/file.png'
    );
    expect(mockFetch).toHaveBeenCalledTimes(1);

    const [copyUrl, copyOptions] = mockFetch.mock.calls[0];
    expect(copyUrl).toBe('https://api.imagekit.io/v1/files/copy');
    expect(copyOptions.method).toBe('POST');
    expect(JSON.parse(copyOptions.body)).toEqual({
      sourceFilePath: '/staging/complaints/101/file.png',
      destinationPath: '/complaints/101/',
      includeFileVersions: false,
    });
  });

  it('generates signed serve URL with HMAC-SHA1 signature and ik-t timestamp', async () => {
    const key = 'complaints/101/private-evidence.png';
    const serveUrl = await provider.getServeUrl(key, 600);
    expect(typeof serveUrl).toBe('string');
    expect(serveUrl).toContain('https://ik.imagekit.io/test-endpoint/complaints/101/private-evidence.png');
    expect(serveUrl).toContain('ik-t=');
    expect(serveUrl).toContain('ik-s=');
  });

  it('generates presigned upload URL for direct browser uploads', async () => {
    const key = 'staging/complaints/101/direct-upload.jpg';
    const uploadUrl = await provider.getPresignedUploadUrl!(key, 'image/jpeg', 2048, 600);
    expect(typeof uploadUrl).toBe('string');
    expect(uploadUrl).toContain('https://upload.imagekit.io/api/v1/files/upload');
    expect(uploadUrl).toContain('token=');
    expect(uploadUrl).toContain('expire=');
    expect(uploadUrl).toContain('signature=');
    expect(uploadUrl).toContain('publicKey=test-public-key');
    expect(uploadUrl).toContain('fileName=direct-upload.jpg');
    expect(uploadUrl).toContain('folder=%2Fstaging%2Fcomplaints%2F101');
  });
});

describe('Provider Selection Registry', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.resetModules();
    process.env = { ...originalEnv };
    _resetStorageProvider();
  });

  afterAll(() => {
    process.env = originalEnv;
    _resetStorageProvider();
  });

  it('defaults to LocalStorageProvider when MEDIA_STORAGE_PROVIDER is not set', () => {
    delete process.env.MEDIA_STORAGE_PROVIDER;
    const provider = getStorageProvider();
    expect(provider).toBeInstanceOf(LocalStorageProvider);
  });

  it('selects LocalStorageProvider when MEDIA_STORAGE_PROVIDER=local', () => {
    process.env.MEDIA_STORAGE_PROVIDER = 'local';
    const provider = getStorageProvider();
    expect(provider).toBeInstanceOf(LocalStorageProvider);
  });

  it('throws helpful configuration error if MEDIA_STORAGE_PROVIDER=r2 but env vars are missing', () => {
    process.env.MEDIA_STORAGE_PROVIDER = 'r2';
    delete process.env.R2_BUCKET_NAME;
    delete process.env.R2_ACCESS_KEY_ID;
    delete process.env.R2_SECRET_ACCESS_KEY;

    expect(() => getStorageProvider()).toThrow(/Cloudflare R2 storage credentials not configured/);
  });

  it('instantiates S3StorageProvider when MEDIA_STORAGE_PROVIDER=r2 and credentials are present', () => {
    process.env.MEDIA_STORAGE_PROVIDER = 'r2';
    process.env.R2_ACCOUNT_ID = 'test-account-123';
    process.env.R2_BUCKET_NAME = 'test-bucket-name';
    process.env.R2_ACCESS_KEY_ID = 'test-access-key';
    process.env.R2_SECRET_ACCESS_KEY = 'test-secret-key';

    const provider = getStorageProvider();
    expect(provider).toBeInstanceOf(S3StorageProvider);
  });

  it('throws helpful configuration error if MEDIA_STORAGE_PROVIDER=imagekit but env vars are missing', () => {
    process.env.MEDIA_STORAGE_PROVIDER = 'imagekit';
    delete process.env.IMAGEKIT_PUBLIC_KEY;
    delete process.env.IMAGEKIT_PRIVATE_KEY;
    delete process.env.IMAGEKIT_URL_ENDPOINT;

    expect(() => getStorageProvider()).toThrow(/ImageKit storage credentials not configured/);
  });

  it('instantiates ImageKitStorageProvider when MEDIA_STORAGE_PROVIDER=imagekit and credentials are present', () => {
    process.env.MEDIA_STORAGE_PROVIDER = 'imagekit';
    process.env.IMAGEKIT_PUBLIC_KEY = 'test-pub-key';
    process.env.IMAGEKIT_PRIVATE_KEY = 'test-priv-key';
    process.env.IMAGEKIT_URL_ENDPOINT = 'https://ik.imagekit.io/test-id';

    const provider = getStorageProvider();
    expect(provider).toBeInstanceOf(ImageKitStorageProvider);
  });
});
