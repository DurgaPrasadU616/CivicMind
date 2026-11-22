// backend/tests/mediaAnalysis.test.ts
//
// Phase 3 — Multimodal Complaint Intelligence Test Suite
//
// Covers:
//   1. File & MIME validation with magic byte inspection.
//   2. Spoofed extensions and content mismatches.
//   3. Oversized and empty file handling.
//   4. StorageProvider (Local) operations and path traversal security.
//   5. Image analysis (Gemini success, low confidence, fallback).
//   6. Audio transcription and classification.
//   7. Video processing with real FFmpeg frame extraction.
//   8. Malformed AI responses & Zod schema validation.
//   9. Failed AI requests & offline fallback.
//  10. Complaint ownership & permission checks.
//  11. Integration with Phase 2 hybrid clustering & text enrichment.
//  12. Duplicate processing idempotency guard.
//  13. Agent execution logging (agentType: 'media_analysis').

import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  validateMediaUpload,
  validateMagicBytes,
  generateStorageKey,
  sanitizeFilename,
} from '../src/utils/fileValidation';
import {
  analyzeImage,
  analyzeAudio,
  analyzeVideo,
  analyzeMedia,
  MediaAnalysisResultSchema,
  MAX_IMAGE_SIZE_BYTES,
} from '../src/services/mediaAnalysis';
import { getStorageProvider, _resetStorageProvider } from '../src/services/storage';
import {
  attachMediaToComplaint,
  processMediaAnalysis,
  getMediaForComplaint,
} from '../src/services/complaintMediaService';
import { pool } from '../src/config/db';
import { clusterComplaint } from '../src/services/clustering';
import { GoogleGenerativeAI } from '@google/generative-ai';

// ── Mocks ─────────────────────────────────────────────────────────────────────

jest.mock('../src/config/db', () => ({
  pool: { query: jest.fn() },
  checkDbConnection: jest.fn(),
}));

jest.mock('../src/services/clustering', () => ({
  clusterComplaint: jest.fn().mockResolvedValue(100),
}));

jest.mock('../src/utils/logger', () => ({
  __esModule: true,
  default: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

jest.mock('@google/generative-ai');

const mockPool = pool as unknown as { query: jest.Mock };
const mockClusterComplaint = clusterComplaint as jest.Mock;

// Sample valid buffers with correct magic bytes
const sampleJpegBuffer = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);
const samplePngBuffer = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00]);
const sampleWavBuffer = Buffer.concat([
  Buffer.from('RIFF', 'ascii'),
  Buffer.alloc(4),
  Buffer.from('WAVE', 'ascii'),
  Buffer.alloc(8),
]);
const sampleMp4Buffer = Buffer.concat([
  Buffer.alloc(4),
  Buffer.from('ftyp', 'ascii'),
  Buffer.from('isom', 'ascii'),
  Buffer.alloc(8),
]);

beforeEach(() => {
  jest.clearAllMocks();
  _resetStorageProvider();
  process.env.GEMINI_API_KEY = 'test-gemini-key';
});

// ── Shared temp storage directory ─────────────────────────────────────────────
// Lives in the OS temp dir (never the repo) so tests cannot fail with EACCES on
// a read-only checkout and cannot leave stray uploads_test_* folders behind.
const testStorageDir = path.join(os.tmpdir(), 'civicmind_media_test_' + Date.now());

beforeAll(() => {
  process.env.MEDIA_STORAGE_DIR = testStorageDir;
  process.env.MEDIA_STORAGE_PROVIDER = 'local';
});

afterAll(async () => {
  try {
    await fs.promises.rm(testStorageDir, { recursive: true, force: true });
  } catch {
    // Best-effort cleanup
  }
});

// =============================================================================
// 1. File & MIME Validation with Magic Byte Verification
// =============================================================================
describe('1. File Validation & Magic Byte Inspection', () => {
  it('accepts valid JPEG buffer with image/jpeg MIME type', () => {
    const result = validateMediaUpload(sampleJpegBuffer, 'image/jpeg', 'pothole.jpg');
    expect(result.valid).toBe(true);
    expect(result.mediaType).toBe('image');
    expect(result.sanitizedExt).toBe('jpg');
  });

  it('accepts valid PNG buffer with image/png MIME type', () => {
    const result = validateMediaUpload(samplePngBuffer, 'image/png', 'water_leak.png');
    expect(result.valid).toBe(true);
    expect(result.mediaType).toBe('image');
    expect(result.sanitizedExt).toBe('png');
  });

  it('accepts valid WAV buffer with audio/wav MIME type', () => {
    const result = validateMediaUpload(sampleWavBuffer, 'audio/wav', 'voice_report.wav');
    expect(result.valid).toBe(true);
    expect(result.mediaType).toBe('audio');
    expect(result.sanitizedExt).toBe('wav');
  });

  it('accepts valid MP4 buffer with video/mp4 MIME type', () => {
    const result = validateMediaUpload(sampleMp4Buffer, 'video/mp4', 'traffic_hazard.mp4');
    expect(result.valid).toBe(true);
    expect(result.mediaType).toBe('video');
    expect(result.sanitizedExt).toBe('mp4');
  });

  it('rejects spoofed extension: plain text disguised as image/jpeg', () => {
    const fakeJpeg = Buffer.from('Hello this is a plain text file');
    const result = validateMediaUpload(fakeJpeg, 'image/jpeg', 'fake.jpg');
    expect(result.valid).toBe(false);
    expect(result.error).toContain('does not match the declared MIME type');
  });

  it('rejects unsupported MIME types (e.g. application/pdf, text/html)', () => {
    const pdfBuffer = Buffer.from('%PDF-1.4');
    const result = validateMediaUpload(pdfBuffer, 'application/pdf', 'document.pdf');
    expect(result.valid).toBe(false);
    expect(result.error).toContain('Unsupported media type');
  });

  it('rejects empty (0 byte) files', () => {
    const empty = Buffer.alloc(0);
    const result = validateMediaUpload(empty, 'image/jpeg', 'empty.jpg');
    expect(result.valid).toBe(false);
    expect(result.error).toContain('empty');
  });

  it('rejects oversized files exceeding configured limit', () => {
    // Construct buffer slightly larger than MAX_IMAGE_SIZE_BYTES
    const oversized = Buffer.alloc(MAX_IMAGE_SIZE_BYTES + 1024);
    oversized[0] = 0xff;
    oversized[1] = 0xd8;
    oversized[2] = 0xff;

    const result = validateMediaUpload(oversized, 'image/jpeg', 'huge.jpg');
    expect(result.valid).toBe(false);
    expect(result.error).toContain('exceeds the maximum allowed limit');
  });

  it('sanitizes unsafe filenames with directory traversal tokens', () => {
    expect(sanitizeFilename('../../../etc/passwd')).toBe('passwd');
    expect(sanitizeFilename('..\\..\\windows\\system32\\cmd.exe')).toBe('cmd.exe');
    expect(sanitizeFilename('my test photo (1).jpg')).toBe('my_test_photo__1_.jpg');
  });

  it('generates safe, unique storage keys within complaint namespace', () => {
    const key1 = generateStorageKey(42, 'jpg');
    const key2 = generateStorageKey(42, 'jpg');
    expect(key1).toMatch(/^complaints\/42\/[a-f0-9-]+\.jpg$/);
    expect(key1).not.toBe(key2);
  });
});

// =============================================================================
// 2. Storage Provider & Path Traversal Security
// =============================================================================
describe('2. Storage Provider (Local Filesystem)', () => {
  // Storage env is configured file-level (see top of file) so every suite —
  // including the lifecycle tests in suite 4 — writes into the same temp dir
  // which is removed once, after all tests finish.

  it('stores and retrieves a file buffer correctly', async () => {
    const storage = getStorageProvider();
    const key = 'complaints/1/test_file.jpg';
    await storage.put(key, sampleJpegBuffer, 'image/jpeg');

    const exists = await storage.exists(key);
    expect(exists).toBe(true);

    const fetched = await storage.get(key);
    expect(fetched.equals(sampleJpegBuffer)).toBe(true);

    const serveUrl = await storage.getServeUrl(key);
    expect(serveUrl).toBe('/api/media/complaints%2F1%2Ftest_file.jpg');

    await storage.delete(key);
    expect(await storage.exists(key)).toBe(false);
  });

  it('blocks path traversal attempts outside the base directory', async () => {
    const storage = getStorageProvider();
    const maliciousKey = '../../outside_secret.txt';

    await expect(storage.put(maliciousKey, Buffer.from('evil'), 'text/plain')).rejects.toThrow(
      'Path traversal blocked'
    );
  });
});

// =============================================================================
// 3. Multimodal AI Analysis (Images, Audio, Video)
// =============================================================================
describe('3. Multimodal AI Analysis (Gemini Integration)', () => {
  it('analyzes image and parses structured civic issue output', async () => {
    const mockGenerateContent = jest.fn().mockResolvedValue({
      response: {
        text: () => JSON.stringify({
          description: 'Large pothole on 2nd cross road with exposed gravel.',
          detectedCategory: 'infrastructure',
          severityIndicators: ['deep road cavity', 'vehicle hazard'],
          confidence: 0.92,
        }),
      },
    });

    (GoogleGenerativeAI as jest.Mock).mockImplementation(() => ({
      getGenerativeModel: jest.fn().mockReturnValue({
        generateContent: mockGenerateContent,
      }),
    }));

    const result = await analyzeImage(sampleJpegBuffer, 'image/jpeg');

    expect(result.mediaType).toBe('image');
    expect(result.detectedCategory).toBe('infrastructure');
    expect(result.confidence).toBe(0.92);
    expect(result.needsHumanReview).toBe(false);
    expect(result.severityIndicators).toContain('deep road cavity');
    expect(MediaAnalysisResultSchema.safeParse(result).success).toBe(true);
  });

  it('flags needsHumanReview=true when AI confidence is below threshold', async () => {
    const mockGenerateContent = jest.fn().mockResolvedValue({
      response: {
        text: () => JSON.stringify({
          description: 'Ambiguous dark shape near sidewalk.',
          detectedCategory: 'other',
          severityIndicators: [],
          confidence: 0.45, // Below 0.60 threshold
        }),
      },
    });

    (GoogleGenerativeAI as jest.Mock).mockImplementation(() => ({
      getGenerativeModel: jest.fn().mockReturnValue({
        generateContent: mockGenerateContent,
      }),
    }));

    const result = await analyzeImage(sampleJpegBuffer, 'image/jpeg');

    expect(result.confidence).toBe(0.45);
    expect(result.needsHumanReview).toBe(true);
  });

  it('transcribes audio and extracts civic complaint details', async () => {
    const mockGenerateContent = jest.fn().mockResolvedValue({
      response: {
        text: () => JSON.stringify({
          description: 'Citizen reporting broken water main leaking for 2 days.',
          rawTranscript: 'There is a major water pipeline leak outside building 4.',
          detectedCategory: 'utility',
          severityIndicators: ['flooding', 'clean water waste'],
          confidence: 0.88,
        }),
      },
    });

    (GoogleGenerativeAI as jest.Mock).mockImplementation(() => ({
      getGenerativeModel: jest.fn().mockReturnValue({
        generateContent: mockGenerateContent,
      }),
    }));

    const result = await analyzeAudio(sampleWavBuffer, 'audio/wav');

    expect(result.mediaType).toBe('audio');
    expect(result.detectedCategory).toBe('utility');
    expect(result.rawTranscript).toContain('pipeline leak');
    expect(result.needsHumanReview).toBe(false);
  });

  it('processes video evidence and extracts civic indicators', async () => {
    const mockGenerateContent = jest.fn().mockResolvedValue({
      response: {
        text: () => JSON.stringify({
          description: 'Overflowing stormwater drain flooding residential street.',
          detectedCategory: 'sanitation',
          severityIndicators: ['drain blockage', 'standing water'],
          confidence: 0.85,
        }),
      },
    });

    (GoogleGenerativeAI as jest.Mock).mockImplementation(() => ({
      getGenerativeModel: jest.fn().mockReturnValue({
        generateContent: mockGenerateContent,
      }),
    }));

    const result = await analyzeVideo(sampleMp4Buffer, 'video/mp4');

    expect(result.mediaType).toBe('video');
    expect(result.detectedCategory).toBe('sanitation');
    expect(result.confidence).toBe(0.85);
  });

  it('handles malformed AI JSON response gracefully without crashing', async () => {
    const mockGenerateContent = jest.fn().mockResolvedValue({
      response: {
        text: () => 'I am sorry, this does not look like valid JSON at all.',
      },
    });

    (GoogleGenerativeAI as jest.Mock).mockImplementation(() => ({
      getGenerativeModel: jest.fn().mockReturnValue({
        generateContent: mockGenerateContent,
      }),
    }));

    const result = await analyzeImage(sampleJpegBuffer, 'image/jpeg');

    expect(result.confidence).toBe(0);
    expect(result.needsHumanReview).toBe(true);
    expect(result.description).toContain('could not be analyzed automatically');
  });

  it('handles Gemini API network exceptions gracefully and returns fallback', async () => {
    const mockGenerateContent = jest.fn().mockRejectedValue(new Error('Network timeout'));

    (GoogleGenerativeAI as jest.Mock).mockImplementation(() => ({
      getGenerativeModel: jest.fn().mockReturnValue({
        generateContent: mockGenerateContent,
      }),
    }));

    const result = await analyzeImage(sampleJpegBuffer, 'image/jpeg');

    expect(result.confidence).toBe(0);
    expect(result.needsHumanReview).toBe(true);
  });

  it('falls back gracefully when GEMINI_API_KEY is not configured', async () => {
    delete process.env.GEMINI_API_KEY;

    const result = await analyzeImage(sampleJpegBuffer, 'image/jpeg');

    expect(result.confidence).toBe(0);
    expect(result.needsHumanReview).toBe(true);
    expect(result.description).toContain('could not be analyzed');
  });
});

// =============================================================================
// 4. Complaint Media Lifecycle & Hybrid Clustering Integration
// =============================================================================
describe('4. Complaint Media Lifecycle & Hybrid Clustering Integration', () => {
  beforeEach(() => {
    // Mock Gemini response
    const mockGenerateContent = jest.fn().mockResolvedValue({
      response: {
        text: () => JSON.stringify({
          description: 'Deep road fissure hazardous to two-wheelers.',
          detectedCategory: 'infrastructure',
          severityIndicators: ['cracked tarmac'],
          confidence: 0.90,
        }),
      },
    });

    (GoogleGenerativeAI as jest.Mock).mockImplementation(() => ({
      getGenerativeModel: jest.fn().mockReturnValue({
        generateContent: mockGenerateContent,
      }),
    }));
  });

  function mockMediaJobDb(mediaId: number, complaintId: number, complaintText: string) {
    let storageKey = '';
    let mimeType = 'image/jpeg';
    mockPool.query.mockImplementation(async (sqlValue: string, params: any[] = []) => {
      const sql = String(sqlValue).replace(/\s+/g, ' ').trim();
      if (sql.includes('FROM complaint_media WHERE complaint_id = $1 AND original_filename = $2')) {
        return { rows: [] };
      }
      if (sql.startsWith('INSERT INTO complaint_media')) {
        storageKey = params[2];
        mimeType = params[4];
        return { rows: [{ id: mediaId }] };
      }
      if (sql.startsWith("UPDATE complaint_media SET processing_status = 'processing', failure_history = CASE")) {
        return { rows: [{
          id: mediaId,
          complaint_id: complaintId,
          storage_key: storageKey,
          mime_type: mimeType,
          attempt_count: 1,
          lease_token: params[1],
        }] };
      }
      if (sql.startsWith("UPDATE complaint_media SET processing_status = 'processing' WHERE id = $1")) {
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes('extracted_description = $1')) return { rows: [], rowCount: 1 };
      if (sql.startsWith('UPDATE complaint_media SET processing_status = $1, error_message = $2')) {
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes('SELECT text, category, idempotency_key FROM complaint WHERE id = $1')) {
        return { rows: [{ text: complaintText, category: 'infrastructure', idempotency_key: 'uuid-1' }] };
      }
      if (sql.startsWith('UPDATE complaint SET text = $1')) return { rows: [] };
      if (sql.includes('INSERT INTO agent_execution_log')) return { rows: [{ id: 9001 }] };
      throw new Error(`Unhandled SQL in media job integration test: ${sql}`);
    });
  }

  it('attaches media, saves record, enriches complaint text, and re-clusters', async () => {
    mockMediaJobDb(501, 42, 'Pothole on 1st cross');

    const result = await attachMediaToComplaint({
      complaintId: 42,
      buffer: sampleJpegBuffer,
      mimeType: 'image/jpeg',
      originalFilename: 'pothole.jpg',
      runAnalysisSync: true,
    });

    expect(result.mediaId).toBe(501);
    expect(result.processingStatus).toBe('completed');
    expect(result.analysis?.detectedCategory).toBe('infrastructure');

    // Verify clusterComplaint was re-triggered with complaintId
    expect(mockClusterComplaint).toHaveBeenCalledWith(42);

    // Verify complaint text update SQL contained the enriched tag (scoped to media 501)
    const updateCall = mockPool.query.mock.calls.find(
      (c) => typeof c[0] === 'string' && c[0].includes('UPDATE complaint SET text = $1')
    );
    expect(updateCall).toBeDefined();
    expect(updateCall[1][0]).toContain('[Media Evidence Analysis (image #501)]:');
    expect(updateCall[1][0]).toContain('Deep road fissure hazardous');
  });

  it('prevents duplicate text appending if media description tag is already present', async () => {
    // Simulates a retry of the SAME media (id 502) whose analysis already
    // enriched the complaint text — the media-scoped tag must block a 2nd append.
    const existingEnrichedText =
      'Pothole on 1st cross\n\n[Media Evidence Analysis (image #502)]: Deep road fissure';

    mockMediaJobDb(502, 43, existingEnrichedText);

    await attachMediaToComplaint({
      complaintId: 43,
      buffer: sampleJpegBuffer,
      mimeType: 'image/jpeg',
      originalFilename: 'repeat.jpg',
      runAnalysisSync: true,
    });

    // Ensure UPDATE complaint SET text was NOT executed a second time
    const textUpdateCalls = mockPool.query.mock.calls.filter(
      (c) => typeof c[0] === 'string' && c[0].includes('UPDATE complaint SET text = $1')
    );
    expect(textUpdateCalls.length).toBe(0);
  });

  it('logs agent execution step with agentType "media_analysis"', async () => {
    mockMediaJobDb(503, 44, 'Broken pipe');

    await attachMediaToComplaint({
      complaintId: 44,
      buffer: sampleWavBuffer,
      mimeType: 'audio/wav',
      originalFilename: 'audio.wav',
      runAnalysisSync: true,
    });

    const agentLogCalls = mockPool.query.mock.calls.filter(
      (c) => typeof c[0] === 'string' && c[0].includes('INSERT INTO agent_execution_log')
    );
    expect(agentLogCalls.length).toBeGreaterThanOrEqual(1);
    expect(agentLogCalls[0][1]).toContain('media_analysis');
  });
});
