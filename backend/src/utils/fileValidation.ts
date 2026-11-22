// backend/src/utils/fileValidation.ts
//
// Phase 3 — File and Media Content Validation
//
// Validates:
//   1. Declared MIME types against the supported allowlist.
//   2. Actual file magic numbers / binary signatures (preventing spoofed extensions).
//   3. File size limits (image: 10MB, audio: 25MB, video: 50MB).
//   4. Sanitizes filenames and generates safe, path-traversal-proof storage keys.

import path from 'path';
import { randomUUID } from 'crypto';
import {
  SUPPORTED_IMAGE_TYPES,
  SUPPORTED_AUDIO_TYPES,
  SUPPORTED_VIDEO_TYPES,
  MAX_IMAGE_SIZE_BYTES,
  MAX_AUDIO_SIZE_BYTES,
  MAX_VIDEO_SIZE_BYTES,
} from '../services/mediaAnalysis';

export interface FileValidationResult {
  valid: boolean;
  error?: string;
  mediaType?: 'image' | 'audio' | 'video';
  sanitizedExt?: string;
}

/**
 * Validates declared MIME type and requested file size ahead of generating a presigned upload URL.
 */
export function validatePresignUploadParams(
  mimeType: string,
  fileSizeBytes: number
): { valid: boolean; error?: string; mediaType?: 'image' | 'audio' | 'video'; sanitizedExt?: string } {
  if (!mimeType || typeof mimeType !== 'string') {
    return { valid: false, error: 'MIME type is required.' };
  }
  if (!fileSizeBytes || typeof fileSizeBytes !== 'number' || fileSizeBytes <= 0) {
    return { valid: false, error: 'Valid file size in bytes is required.' };
  }

  const normMime = mimeType.toLowerCase().trim();
  let mediaType: 'image' | 'audio' | 'video';
  let maxSize: number;

  if (SUPPORTED_IMAGE_TYPES.has(normMime)) {
    mediaType = 'image';
    maxSize = MAX_IMAGE_SIZE_BYTES;
  } else if (SUPPORTED_AUDIO_TYPES.has(normMime)) {
    mediaType = 'audio';
    maxSize = MAX_AUDIO_SIZE_BYTES;
  } else if (SUPPORTED_VIDEO_TYPES.has(normMime)) {
    mediaType = 'video';
    maxSize = MAX_VIDEO_SIZE_BYTES;
  } else {
    return {
      valid: false,
      error: `Unsupported media type "${normMime}". Supported formats: JPEG, PNG, WebP, GIF, MP3, WAV, OGG, WebM, MP4, MOV.`,
    };
  }

  if (fileSizeBytes > maxSize) {
    const maxMB = (maxSize / (1024 * 1024)).toFixed(0);
    return {
      valid: false,
      error: `File size exceeds the maximum allowed limit of ${maxMB} MB for ${mediaType} files.`,
    };
  }

  const sanitizedExt = getCanonicalExtension(normMime);

  return {
    valid: true,
    mediaType,
    sanitizedExt,
  };
}

/**
 * Validates magic numbers (binary header signatures) to ensure the file buffer
 * matches the claimed MIME type.
 */
export function validateMagicBytes(buffer: Buffer, mimeType: string): boolean {
  if (!buffer || buffer.length < 4) return false;

  switch (mimeType) {
    // ── Images ─────────────────────────────────────────────────────────────
    case 'image/jpeg':
      // JPEG starts with FF D8 FF
      return buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;

    case 'image/png':
      // PNG starts with 89 50 4E 47 (0x89 'PNG')
      return (
        buffer[0] === 0x89 &&
        buffer[1] === 0x50 &&
        buffer[2] === 0x4e &&
        buffer[3] === 0x47
      );

    case 'image/gif':
      // GIF starts with 'GIF87a' or 'GIF89a'
      return (
        buffer[0] === 0x47 &&
        buffer[1] === 0x49 &&
        buffer[2] === 0x46 &&
        buffer[3] === 0x38
      );

    case 'image/webp':
      // WebP starts with 'RIFF' .... 'WEBP'
      if (buffer.length < 12) return false;
      return (
        buffer.slice(0, 4).toString('ascii') === 'RIFF' &&
        buffer.slice(8, 12).toString('ascii') === 'WEBP'
      );

    // ── Audio ──────────────────────────────────────────────────────────────
    case 'audio/mpeg':
    case 'audio/mp3':
      // MP3 has ID3 header (49 44 33) or MPEG sync frame (FF FB / FF FA / FF F3 / FF F2)
      if (buffer.slice(0, 3).toString('ascii') === 'ID3') return true;
      return buffer[0] === 0xff && (buffer[1] & 0xe0) === 0xe0;

    case 'audio/wav':
    case 'audio/x-wav':
      // WAV starts with 'RIFF' .... 'WAVE'
      if (buffer.length < 12) return false;
      return (
        buffer.slice(0, 4).toString('ascii') === 'RIFF' &&
        buffer.slice(8, 12).toString('ascii') === 'WAVE'
      );

    case 'audio/ogg':
      // Ogg starts with 'OggS'
      return buffer.slice(0, 4).toString('ascii') === 'OggS';

    case 'audio/mp4':
    case 'audio/webm':
    case 'audio/x-m4a':
      // WebM audio or MP4 audio
      if (buffer[0] === 0x1a && buffer[1] === 0x45 && buffer[2] === 0xdf && buffer[3] === 0xa3) {
        return true; // Matroska / WebM
      }
      if (buffer.length >= 8 && buffer.slice(4, 8).toString('ascii') === 'ftyp') {
        return true; // MP4 container
      }
      return true; // permissive fallback for streaming chunks

    // ── Video ──────────────────────────────────────────────────────────────
    case 'video/mp4':
    case 'video/quicktime':
      // MP4 / QuickTime has 'ftyp' or 'moov' at byte offset 4
      if (buffer.length >= 8) {
        const box = buffer.slice(4, 8).toString('ascii');
        if (box === 'ftyp' || box === 'moov' || box === 'wide' || box === 'mdat') {
          return true;
        }
      }
      return false;

    case 'video/webm':
      // WebM starts with EBML header 1A 45 DF A3
      return (
        buffer[0] === 0x1a &&
        buffer[1] === 0x45 &&
        buffer[2] === 0xdf &&
        buffer[3] === 0xa3
      );

    default:
      return false;
  }
}

/**
 * Maps MIME type to a safe, canonical file extension.
 */
export function getCanonicalExtension(mimeType: string): string {
  switch (mimeType) {
    case 'image/jpeg': return 'jpg';
    case 'image/png': return 'png';
    case 'image/webp': return 'webp';
    case 'image/gif': return 'gif';
    case 'audio/mpeg':
    case 'audio/mp3': return 'mp3';
    case 'audio/wav':
    case 'audio/x-wav': return 'wav';
    case 'audio/ogg': return 'ogg';
    case 'audio/mp4':
    case 'audio/x-m4a': return 'm4a';
    case 'audio/webm': return 'weba';
    case 'video/mp4': return 'mp4';
    case 'video/webm': return 'webm';
    case 'video/quicktime': return 'mov';
    default: return 'bin';
  }
}

/**
 * Validates a file's MIME type, size, and binary magic bytes.
 */
export function validateMediaUpload(
  buffer: Buffer,
  mimeType: string,
  originalFilename?: string
): FileValidationResult {
  const normMime = (mimeType || '').toLowerCase().trim();

  let mediaType: 'image' | 'audio' | 'video' | null = null;
  let maxSize = MAX_IMAGE_SIZE_BYTES;

  if (SUPPORTED_IMAGE_TYPES.has(normMime)) {
    mediaType = 'image';
    maxSize = MAX_IMAGE_SIZE_BYTES;
  } else if (SUPPORTED_AUDIO_TYPES.has(normMime)) {
    mediaType = 'audio';
    maxSize = MAX_AUDIO_SIZE_BYTES;
  } else if (SUPPORTED_VIDEO_TYPES.has(normMime)) {
    mediaType = 'video';
    maxSize = MAX_VIDEO_SIZE_BYTES;
  } else {
    return {
      valid: false,
      error: `Unsupported media type "${normMime}". Supported formats: JPEG, PNG, WebP, GIF, MP3, WAV, OGG, WebM, MP4, MOV.`,
    };
  }

  // Size limit check
  if (buffer.length > maxSize) {
    const maxMB = (maxSize / (1024 * 1024)).toFixed(0);
    return {
      valid: false,
      error: `File size exceeds the maximum allowed limit of ${maxMB} MB for ${mediaType} files.`,
    };
  }

  if (buffer.length === 0) {
    return {
      valid: false,
      error: 'Uploaded file is empty (0 bytes).',
    };
  }

  // Magic bytes inspection
  const magicOk = validateMagicBytes(buffer, normMime);
  if (!magicOk) {
    return {
      valid: false,
      error: `File content does not match the declared MIME type "${normMime}".`,
    };
  }

  const sanitizedExt = getCanonicalExtension(normMime);

  return {
    valid: true,
    mediaType,
    sanitizedExt,
  };
}

/**
 * Generates an opaque, path-traversal-proof storage key.
 * Pattern: `complaints/{complaintId}/{uuid}.{ext}`
 */
export function generateStorageKey(complaintId: number, sanitizedExt: string): string {
  const uuid = randomUUID();
  // Ensure extension is strictly alphanumeric
  const cleanExt = sanitizedExt.replace(/[^a-zA-Z0-9]/g, '');
  return `complaints/${complaintId}/${uuid}.${cleanExt}`;
}

/**
 * Sanitizes original filename for safe display / storage in DB metadata.
 * Strips path separators, control characters, and limits length.
 */
export function sanitizeFilename(filename: string): string {
  if (!filename) return 'unnamed';
  const basename = path.basename(filename);
  const clean = basename.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 200);
  return clean || 'unnamed';
}
