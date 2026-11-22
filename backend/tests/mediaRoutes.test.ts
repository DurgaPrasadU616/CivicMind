// backend/tests/mediaRoutes.test.ts
//
// Phase 3 — HTTP-level tests for the media API.
//
// Covers:
//   1. Authentication & ownership on file serving, attach, list and retry.
//   2. Upload validation (magic bytes, MIME allowlist, size, duration limit).
//   3. Reliability: visible failure, retry-in-place, duplicate suppression,
//      and complaint preservation when an attachment is rejected.
//   4. End-to-end image / audio / video analysis (real FFmpeg frames),
//      complaint-text enrichment and re-clustering.
//   5. AI output validation: malformed JSON → failed + human review;
//      low confidence → completed but flagged for human review.
//
// Design notes:
//   • The DB is mocked with a small stateful SQL router so multi-step flows
//     (attach → analyze → enrich → retry) behave like a real database and any
//     unhandled query fails loudly.
//   • Storage is REAL (OS temp dir, removed in afterAll) because duplicate
//     detection and file serving must operate on actual bytes.
//   • Gemini is mocked; FFmpeg/ffprobe are real (video tests skip if missing).

import request from 'supertest';
import jwt from 'jsonwebtoken';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';
import app from '../src/index';
import { pool } from '../src/config/db';
import { clusterComplaint } from '../src/services/clustering';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { getStorageProvider, _resetStorageProvider } from '../src/services/storage';
import { isFfmpegAvailable, isFfprobeAvailable } from '../src/utils/videoFrames';

// ─── Mocks ────────────────────────────────────────────────────────────────────

jest.mock('../src/config/db', () => ({
  pool: { query: jest.fn() },
  checkDbConnection: jest.fn(),
}));

jest.mock('../src/services/clustering', () => ({
  clusterComplaint: jest.fn(),
  recalculateClusterSeverity: jest.fn(),
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

// predictions.ts builds its Gemini client at import time, so the mock must be
// constructible before any beforeEach runs (implementations are re-set there).
jest.mock('@google/generative-ai', () => ({
  __esModule: true,
  GoogleGenerativeAI: jest.fn().mockImplementation(() => ({
    getGenerativeModel: jest.fn().mockReturnValue({ generateContent: jest.fn() }),
  })),
}));

const mockPool = pool as unknown as { query: jest.Mock };
const mockClusterComplaint = clusterComplaint as jest.Mock;
const mockGenerateContent = jest.fn();

// ─── Tokens ───────────────────────────────────────────────────────────────────

process.env.JWT_SECRET = process.env.JWT_SECRET || 'civicmind-super-secret-jwt-key-2026-secure';
const sign = (payload: { id: number; role: string }) =>
  jwt.sign(payload, process.env.JWT_SECRET!, { expiresIn: '1h' });

const ownerToken = sign({ id: 777, role: 'citizen' }); // complaint owner
const otherToken = sign({ id: 5, role: 'citizen' }); // unrelated citizen
const adminToken = sign({ id: 9, role: 'admin' });

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const jpegBuffer = Buffer.concat([
  Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
  Buffer.alloc(64, 0x41),
]);

const wavBuffer = Buffer.concat([
  Buffer.from('RIFF', 'ascii'),
  Buffer.from([0, 0, 0, 0]),
  Buffer.from('WAVE', 'ascii'),
  Buffer.alloc(32, 0),
]);

const pdfBuffer = Buffer.from('%PDF-1.7\n1 0 obj\n<<>>\nendobj\n');

const SUCCESS_ANALYSIS = {
  description: 'Large pothole in the middle of the road.',
  detectedCategory: 'infrastructure',
  severityIndicators: ['cracked pavement'],
  confidence: 0.92,
};

const geminiJson = (payload: unknown) => ({
  response: { text: () => JSON.stringify(payload) },
});

// ─── Test state ───────────────────────────────────────────────────────────────

interface ComplaintRow {
  id: number;
  meta_data: Record<string, unknown> | null;
  text: string;
  category: string;
  idempotency_key: string;
  latitude?: number | null;
  longitude?: number | null;
  status?: string;
  cluster_id?: number | null;
  created_at?: string;
}

interface MediaRow {
  id: number;
  complaint_id: number;
  media_type: string;
  storage_key: string;
  original_filename: string;
  mime_type: string;
  file_size: number;
  processing_status: string;
  extracted_description?: string | null;
  detected_category?: string | null;
  confidence_score?: number | null;
  needs_human_review?: boolean | null;
  error_message?: string | null;
  processed_at?: Date | null;
  created_at: Date;
  attempt_count?: number;
  next_retry_at?: Date | null;
  lease_until?: Date | null;
  lease_token?: string | null;
  manual_intervention?: boolean;
  failure_history?: any[];
}

interface TestState {
  complaint: ComplaintRow | null;
  media: Map<number, MediaRow>;
  nextMediaId: number;
  mediaInsertCount: number;
  agentLogCount: number;
  enrichedTexts: string[];
  queries: string[];
}

const makeComplaint = (overrides: Partial<ComplaintRow> = {}): ComplaintRow => ({
  id: 1,
  meta_data: { userId: 777 },
  text: 'Pothole on 1st cross',
  category: 'infrastructure',
  idempotency_key: 'idem-1',
  latitude: 12.9716,
  longitude: 77.5946,
  status: 'pending',
  cluster_id: null,
  created_at: '2026-11-18T00:00:00Z',
  ...overrides,
});

let state: TestState;

function freshState(): TestState {
  return {
    complaint: null,
    media: new Map(),
    nextMediaId: 1,
    mediaInsertCount: 0,
    agentLogCount: 0,
    enrichedTexts: [],
    queries: [],
  };
}

/**
 * Stateful SQL router. Ordered from most specific to least specific.
 * Throws on anything unexpected so a missing mock fails the test loudly.
 */
async function routeQuery(sqlValue: string, params: any[] = []): Promise<{ rows: any[]; rowCount?: number }> {
  const s = String(sqlValue).replace(/\s+/g, ' ').trim();
  state.queries.push(s);

  // complaint_media — check by storage_key (Phase 2B confirm direct upload)
  if (s.includes('FROM complaint_media WHERE storage_key = $1')) {
    const matches = [...state.media.values()].filter((m) => m.storage_key === params[0]);
    return {
      rows: matches.map((m) => ({
        id: m.id,
        processing_status: m.processing_status,
      })),
    };
  }

  // complaint_media — duplicate lookup
  if (s.includes('FROM complaint_media WHERE complaint_id = $1 AND original_filename = $2')) {
    const matches = [...state.media.values()].filter(
      (m) =>
        m.complaint_id === params[0] &&
        m.original_filename === params[1] &&
        m.file_size === params[2]
    );
    return {
      rows: matches.map((m) => ({
        id: m.id,
        storage_key: m.storage_key,
        processing_status: m.processing_status,
      })),
    };
  }

  // complaint_media — insert
  if (s.startsWith('INSERT INTO complaint_media')) {
    state.mediaInsertCount++;
    const id = state.nextMediaId++;
    state.media.set(id, {
      id,
      complaint_id: params[0],
      media_type: params[1],
      storage_key: params[2],
      original_filename: params[3],
      mime_type: params[4],
      file_size: params[5],
      processing_status: 'pending',
      created_at: new Date(),
      attempt_count: 0,
      next_retry_at: null,
      lease_until: null,
      lease_token: null,
      manual_intervention: false,
      failure_history: [],
    });
    return { rows: [{ id }] };
  }

  // complaint_media — persist analysis outcome (completed or failed)
  if (s.includes('extracted_description = $1')) {
    const leased = s.includes('lease_token = $7');
    const row = state.media.get(leased ? params[5] : params[4]);
    const token = leased ? params[6] : undefined;
    if (leased && (!row || row.lease_token !== token)) return { rows: [], rowCount: 0 };
    if (row) {
      row.extracted_description = params[0];
      row.detected_category = params[1];
      row.confidence_score = params[2];
      row.needs_human_review = params[3];
      row.processed_at = new Date();
      if (leased) {
        row.error_message = params[4] ?? null;
      } else if (s.includes("processing_status = 'failed'")) {
        row.processing_status = 'failed';
        row.error_message = params[5] ?? null;
      } else {
        row.processing_status = 'completed';
        row.error_message = null;
      }
    }
    return { rows: [], rowCount: row ? 1 : 0 };
  }

  // complaint_media — reset row before re-analysis (duplicate attach)
  if (s.includes('SET mime_type = $1, file_size = $2')) {
    const row = state.media.get(params[2]);
    if (row) {
      row.mime_type = params[0];
      row.file_size = params[1];
      row.processing_status = 'pending';
      row.error_message = null;
      row.processed_at = null;
    }
    return { rows: [] };
  }

  if (s.startsWith("UPDATE complaint_media SET processing_status = 'processing', failure_history = CASE")) {
    const [id, token, leaseSeconds] = params;
    const row = state.media.get(id);
    if (!row || !['pending', 'failed'].includes(row.processing_status)) return { rows: [] };
    row.processing_status = 'processing';
    row.attempt_count = (row.attempt_count || 0) + 1;
    row.lease_token = token;
    row.lease_until = new Date(Date.now() + leaseSeconds * 1000);
    return { rows: [{ ...row }] };
  }

  if (s.startsWith("UPDATE complaint_media SET processing_status = 'pending', attempt_count = 0")) {
    const row = state.media.get(params[0]);
    if (!row || !['failed', 'pending'].includes(row.processing_status)) return { rows: [] };
    row.processing_status = 'pending';
    row.attempt_count = 0;
    row.next_retry_at = null;
    row.lease_token = null;
    row.lease_until = null;
    row.manual_intervention = false;
    row.error_message = null;
    return { rows: [{ id: row.id }] };
  }

  if (s.includes("SET processing_status = 'processing'")) {
    const row = state.media.get(params[0]);
    const valid = row && (!params[1] || (row.lease_token === params[1] && !!row.lease_until && row.lease_until > new Date()));
    if (valid) row.processing_status = 'processing';
    return { rows: [], rowCount: valid ? 1 : 0 };
  }

  // complaint_media — hard failure inside the processing pipeline
  if (s.includes("SET processing_status = 'failed', error_message = $1")) {
    const row = state.media.get(params[1]);
    if (row) {
      row.processing_status = 'failed';
      row.error_message = params[0];
      row.processed_at = new Date();
    }
    return { rows: [] };
  }

  if (s.includes("SET processing_status = 'pending', error_message = NULL")) {
    const row = state.media.get(params[0]);
    if (row) {
      row.processing_status = 'pending';
      row.error_message = null;
      row.processed_at = null;
    }
    return { rows: [] };
  }

  if (s.startsWith('SELECT processing_status, error_message, next_retry_at, attempt_count, manual_intervention')) {
    const row = state.media.get(params[0]);
    return { rows: row ? [{
      processing_status: row.processing_status,
      error_message: row.error_message,
      next_retry_at: row.next_retry_at,
      attempt_count: row.attempt_count || 0,
      manual_intervention: row.manual_intervention || false,
    }] : [] };
  }

  if (s.startsWith('UPDATE complaint_media SET processing_status = $1, error_message = $2')) {
    const [status, error, retryAt, manual, _attempt, id, token] = params;
    const row = state.media.get(id);
    if (!row || row.lease_token !== token || !row.lease_until || row.lease_until <= new Date() || row.processing_status !== 'processing') return { rows: [], rowCount: 0 };
    row.processing_status = status;
    row.error_message = error;
    row.next_retry_at = retryAt;
    row.manual_intervention = manual;
    row.lease_token = null;
    row.lease_until = null;
    return { rows: [], rowCount: 1 };
  }

  // complaint_media — retry row lookup
  if (s.includes('FROM complaint_media WHERE id = $1 AND complaint_id = $2')) {
    const row = state.media.get(params[0]);
    if (!row || row.complaint_id !== params[1]) return { rows: [] };
    return {
      rows: [
        {
          id: row.id,
          media_type: row.media_type,
          storage_key: row.storage_key,
          mime_type: row.mime_type,
          processing_status: row.processing_status,
          error_message: row.error_message,
        },
      ],
    };
  }

  // complaint_media — list for a complaint
  if (s.includes('FROM complaint_media WHERE complaint_id = $1')) {
    return { rows: [...state.media.values()].filter((m) => m.complaint_id === params[0]) };
  }

  // complaint — GET /api/complaints/:id (joins source)
  if (s.includes('JOIN source s ON c.source_id = s.id')) {
    if (!state.complaint) return { rows: [] };
    return {
      rows: [{ ...state.complaint, source_name: 'citizen_portal', cluster_id: null }],
    };
  }

  // complaint — every lookup by id (meta_data / text+category / full row)
  if (s.includes('FROM complaint WHERE id = $1')) {
    if (!state.complaint || state.complaint.id !== params[0]) return { rows: [] };
    return { rows: [{ ...state.complaint }] };
  }

  // complaint — text enrichment
  if (s.startsWith('UPDATE complaint SET text')) {
    if (state.complaint) state.complaint.text = params[0];
    state.enrichedTexts.push(params[0]);
    return { rows: [] };
  }

  // agent execution log
  if (s.includes('INSERT INTO agent_execution_log')) {
    return { rows: [{ id: 9000 + state.agentLogCount++ }] };
  }

  throw new Error(`Unhandled SQL in mediaRoutes.test.ts: ${s.slice(0, 160)}`);
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

function attachRequest(
  buffer: Buffer,
  contentType: string,
  filename: string,
  token: string,
  complaintId = 1
) {
  return request(app)
    .post(`/api/complaints/${complaintId}/media`)
    .set(auth(token))
    .attach('file', buffer, { filename, contentType });
}

function seedFile(key: string, buffer: Buffer, contentType = 'image/jpeg') {
  return getStorageProvider().put(key, buffer, contentType);
}

// ─── Real test video (FFmpeg) ─────────────────────────────────────────────────

const ffmpegOk = isFfmpegAvailable() && isFfprobeAvailable();
/** Video tests need a real ffmpeg + ffprobe on PATH. */
const itVideo = ffmpegOk ? it : it.skip;
let realVideo: Buffer | null = null;

async function generateTestVideo(seconds: number): Promise<Buffer | null> {
  const outPath = path.join(os.tmpdir(), `civicmind_e2e_${Date.now()}.mp4`);
  const res = spawnSync(
    'ffmpeg',
    [
      '-hide_banner',
      '-loglevel', 'error',
      '-f', 'lavfi',
      '-i', `testsrc2=size=320x240:rate=15:duration=${seconds}`,
      '-pix_fmt', 'yuv420p',
      '-y', outPath,
    ],
    { windowsHide: true, stdio: 'ignore' }
  );
  if (res.status !== 0 || !fs.existsSync(outPath)) return null;
  const buf = await fs.promises.readFile(outPath);
  await fs.promises.unlink(outPath).catch(() => undefined);
  return buf;
}

// ─── Setup ────────────────────────────────────────────────────────────────────

const storageDir = path.join(os.tmpdir(), 'civicmind_media_routes_' + Date.now());

beforeAll(async () => {
  process.env.MEDIA_STORAGE_DIR = storageDir;
  process.env.MEDIA_STORAGE_PROVIDER = 'local';
  if (ffmpegOk) {
    realVideo = await generateTestVideo(4);
  }
});

afterAll(async () => {
  try {
    await fs.promises.rm(storageDir, { recursive: true, force: true });
  } catch {
    // best effort
  }
  delete process.env.MAX_VIDEO_DURATION_SECONDS;
});

beforeEach(() => {
  state = freshState();
  _resetStorageProvider();
  process.env.GEMINI_API_KEY = 'test-gemini-key';

  mockPool.query.mockImplementation(routeQuery);
  mockClusterComplaint.mockResolvedValue(301);
  mockGenerateContent.mockResolvedValue(geminiJson(SUCCESS_ANALYSIS));
  (GoogleGenerativeAI as unknown as jest.Mock).mockImplementation(() => ({
    getGenerativeModel: () => ({ generateContent: mockGenerateContent }),
  }));
});

// =============================================================================
// 1. Authentication & ownership
// =============================================================================

describe('1. Authentication & ownership', () => {
  beforeEach(() => {
    state.complaint = makeComplaint();
  });

  it('requires a token to download a stored file', async () => {
    await seedFile('complaints/1/evidence.jpg', jpegBuffer);
    const res = await request(app).get('/api/media/complaints/1/evidence.jpg');
    expect(res.status).toBe(401);
  });

  it('rejects a non-owner citizen downloading another user\'s file with 403', async () => {
    await seedFile('complaints/1/evidence.jpg', jpegBuffer);
    const res = await request(app)
      .get('/api/media/complaints/1/evidence.jpg')
      .set(auth(otherToken));
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/permission/i);
  });

  it('lets the owner download the file with the right bytes and content type', async () => {
    await seedFile('complaints/1/evidence.jpg', jpegBuffer);
    const res = await request(app)
      .get('/api/media/complaints/1/evidence.jpg')
      .set(auth(ownerToken));
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('image/jpeg');
    expect(res.headers['cache-control']).toContain('private');
    expect(Buffer.from(res.body).equals(jpegBuffer)).toBe(true);
  });

  it('lets staff (admin) download another user\'s file', async () => {
    await seedFile('complaints/1/evidence.jpg', jpegBuffer);
    const res = await request(app)
      .get('/api/media/complaints/1/evidence.jpg')
      .set(auth(adminToken));
    expect(res.status).toBe(200);
  });

  it('keeps legacy complaints (no recorded owner) readable by any authenticated user', async () => {
    state.complaint = makeComplaint({ id: 7, meta_data: {} });
    await seedFile('complaints/7/old.jpg', jpegBuffer);
    const res = await request(app)
      .get('/api/media/complaints/7/old.jpg')
      .set(auth(otherToken));
    expect(res.status).toBe(200);
  });

  it('returns 404 for a file that is not in storage', async () => {
    const res = await request(app)
      .get('/api/media/complaints/1/missing.jpg')
      .set(auth(ownerToken));
    expect(res.status).toBe(404);
  });

  it('rejects path traversal storage keys with 400', async () => {
    const res = await request(app)
      .get('/api/media/%2E%2E%2F%2E%2E%2Fsecret.txt')
      .set(auth(ownerToken));
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/invalid storage key/i);
  });

  it('does not expose stored files through any public static path', async () => {
    await seedFile('complaints/1/evidence.jpg', jpegBuffer);
    const res = await request(app).get('/uploads/complaints/1/evidence.jpg');
    expect(res.status).toBe(404);
  });

  it('requires a token to attach media', async () => {
    const res = await request(app)
      .post('/api/complaints/1/media')
      .attach('file', jpegBuffer, { filename: 'p.jpg', contentType: 'image/jpeg' });
    expect(res.status).toBe(401);
    expect(state.mediaInsertCount).toBe(0);
  });

  it('rejects attach from a non-owner with 403 and creates no record', async () => {
    const res = await attachRequest(jpegBuffer, 'image/jpeg', 'p.jpg', otherToken);
    expect(res.status).toBe(403);
    expect(state.mediaInsertCount).toBe(0);
  });

  it('requires a token to list media', async () => {
    const res = await request(app).get('/api/complaints/1/media');
    expect(res.status).toBe(401);
  });

  it('rejects listing media from a non-owner with 403', async () => {
    const res = await request(app).get('/api/complaints/1/media').set(auth(otherToken));
    expect(res.status).toBe(403);
  });

  it('requires a token to retry analysis', async () => {
    const res = await request(app).post('/api/complaints/1/media/1/retry');
    expect(res.status).toBe(401);
  });

  it('rejects retry from a non-owner with 403', async () => {
    const res = await request(app)
      .post('/api/complaints/1/media/1/retry')
      .set(auth(otherToken));
    expect(res.status).toBe(403);
  });

  it('returns 404 when attaching to a complaint that does not exist', async () => {
    const res = await attachRequest(jpegBuffer, 'image/jpeg', 'p.jpg', ownerToken, 999);
    expect(res.status).toBe(404);
    expect(state.mediaInsertCount).toBe(0);
  });
});

// =============================================================================
// 2. Upload validation
// =============================================================================

describe('2. Upload validation', () => {
  beforeEach(() => {
    state.complaint = makeComplaint();
  });

  it('rejects a file whose bytes do not match the declared MIME type', async () => {
    const res = await attachRequest(
      Buffer.from('this is definitely not a jpeg'),
      'image/jpeg',
      'fake.jpg',
      ownerToken
    );
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/does not match/i);
    expect(state.mediaInsertCount).toBe(0);
  });

  it('rejects an empty file', async () => {
    const res = await attachRequest(Buffer.alloc(0), 'image/jpeg', 'empty.jpg', ownerToken);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/empty/i);
  });

  it('rejects unsupported MIME types', async () => {
    const res = await attachRequest(pdfBuffer, 'application/pdf', 'doc.pdf', ownerToken);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/unsupported media type/i);
  });

  it('rejects images larger than the 10 MB limit', async () => {
    const oversized = Buffer.concat([jpegBuffer, Buffer.alloc(11 * 1024 * 1024, 0x42)]);
    const res = await attachRequest(oversized, 'image/jpeg', 'huge.jpg', ownerToken);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/10 MB/i);
    expect(state.mediaInsertCount).toBe(0);
  });

  itVideo(
    'rejects videos longer than MAX_VIDEO_DURATION_SECONDS with HTTP 400 (ffprobe)',
    async () => {
      process.env.MAX_VIDEO_DURATION_SECONDS = '1';
      try {
        const res = await attachRequest(realVideo!, 'video/mp4', 'long.mp4', ownerToken);
        expect(res.status).toBe(400);
        expect(res.body.error).toMatch(/exceeds the maximum allowed duration/i);
        expect(state.mediaInsertCount).toBe(0);
      } finally {
        delete process.env.MAX_VIDEO_DURATION_SECONDS;
      }
    }
  );

  it('POST /api/media/analyze works without a token for a valid image', async () => {
    const res = await request(app)
      .post('/api/media/analyze')
      .attach('file', jpegBuffer, { filename: 'preview.jpg', contentType: 'image/jpeg' });
    expect(res.status).toBe(200);
    expect(res.body.data.mediaType).toBe('image');
    expect(res.body.data.analysis.confidence).toBeCloseTo(0.92);
    expect(res.body.data.analysis.needsHumanReview).toBe(false);
  });

  it('POST /api/media/analyze rejects a spoofed file', async () => {
    const res = await request(app)
      .post('/api/media/analyze')
      .attach('file', Buffer.from('plain text'), { filename: 'fake.jpg', contentType: 'image/jpeg' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/does not match/i);
  });
});

// =============================================================================
// 3. Reliability: visible failure, retry, dedupe, complaint preservation
// =============================================================================

describe('3. Reliability: failure, retry, dedupe, complaint preservation', () => {
  beforeEach(() => {
    state.complaint = makeComplaint();
  });

  it('surfaces a failed AI analysis as processingStatus "failed" without enriching the complaint', async () => {
    mockGenerateContent.mockRejectedValue(new Error('Gemini unavailable'));

    const res = await attachRequest(jpegBuffer, 'image/jpeg', 'pothole.jpg', ownerToken);

    expect(res.status).toBe(201);
    expect(res.body.data.processingStatus).toBe('failed');
    expect(res.body.data.analysis.needsHumanReview).toBe(true);
    expect(res.body.data.analysis.analysisFailed).toBe(true);

    const row = [...state.media.values()][0];
    expect(row.processing_status).toBe('failed');
    expect(row.error_message).toBeTruthy();

    // The complaint itself is untouched — no AI text, no re-clustering
    expect(state.complaint!.text).toBe('Pothole on 1st cross');
    expect(state.enrichedTexts).toHaveLength(0);
    expect(mockClusterComplaint).not.toHaveBeenCalled();
  });

  it('retries a failed attachment in place: same record, no duplicate, enrichment happens once', async () => {
    mockGenerateContent.mockRejectedValueOnce(new Error('Gemini unavailable'));

    const first = await attachRequest(jpegBuffer, 'image/jpeg', 'pothole.jpg', ownerToken);
    expect(first.body.data.processingStatus).toBe('failed');
    const mediaId = first.body.data.mediaId as number;

    // Gemini is healthy again
    mockGenerateContent.mockResolvedValue(geminiJson(SUCCESS_ANALYSIS));

    const retry = await request(app)
      .post(`/api/complaints/1/media/${mediaId}/retry`)
      .set(auth(ownerToken));

    expect(retry.status).toBe(200);
    expect(retry.body.data.processingStatus).toBe('completed');
    expect(retry.body.data.analysis.confidence).toBeCloseTo(0.92);

    // Exactly one record, enriched exactly once
    expect(state.mediaInsertCount).toBe(1);
    expect(state.media.size).toBe(1);
    expect(state.enrichedTexts).toHaveLength(1);
    expect(state.complaint!.text).toContain('[Media Evidence Analysis (image #1)]:');
    expect(mockClusterComplaint).toHaveBeenCalledWith(1);
  });

  it('never duplicates records or re-analyzes when the identical file is attached twice', async () => {
    const first = await attachRequest(jpegBuffer, 'image/jpeg', 'pothole.jpg', ownerToken);
    expect(first.status).toBe(201);
    expect(state.mediaInsertCount).toBe(1);
    const geminiCalls = mockGenerateContent.mock.calls.length;

    const second = await attachRequest(jpegBuffer, 'image/jpeg', 'pothole.jpg', ownerToken);
    expect(second.status).toBe(201);
    expect(second.body.data.mediaId).toBe(first.body.data.mediaId);
    expect(second.body.data.processingStatus).toBe('completed');

    expect(state.mediaInsertCount).toBe(1);
    expect(state.media.size).toBe(1);
    // Completed media is never analyzed a second time
    expect(mockGenerateContent.mock.calls.length).toBe(geminiCalls);
    expect(state.enrichedTexts).toHaveLength(1);
  });

  it('keeps the complaint intact when the attachment is rejected', async () => {
    const res = await attachRequest(
      Buffer.from('plain text'),
      'image/jpeg',
      'fake.jpg',
      ownerToken
    );
    expect(res.status).toBe(400);
    expect(state.mediaInsertCount).toBe(0);

    const complaint = await request(app).get('/api/complaints/1');
    expect(complaint.status).toBe(200);
    expect(complaint.body.data.text).toBe('Pothole on 1st cross');
  });

  it('retry returns 404 for an unknown media id', async () => {
    const res = await request(app)
      .post('/api/complaints/1/media/4242/retry')
      .set(auth(ownerToken));
    expect(res.status).toBe(404);
  });

  it('retry returns 409 when the attachment already completed', async () => {
    const first = await attachRequest(jpegBuffer, 'image/jpeg', 'pothole.jpg', ownerToken);
    const mediaId = first.body.data.mediaId as number;

    const retry = await request(app)
      .post(`/api/complaints/1/media/${mediaId}/retry`)
      .set(auth(ownerToken));
    expect(retry.status).toBe(409);
    expect(retry.body.error).toMatch(/already been analyzed/i);
  });

  it('retry returns 410 when the stored file has gone missing', async () => {
    // A failed attachment is retryable — but only while its bytes still exist
    mockGenerateContent.mockRejectedValue(new Error('Gemini unavailable'));
    const first = await attachRequest(jpegBuffer, 'image/jpeg', 'pothole.jpg', ownerToken);
    expect(first.body.data.processingStatus).toBe('failed');
    const mediaId = first.body.data.mediaId as number;

    await getStorageProvider().delete(state.media.get(mediaId)!.storage_key);

    const retry = await request(app)
      .post(`/api/complaints/1/media/${mediaId}/retry`)
      .set(auth(ownerToken));
    expect(retry.status).toBe(410);
    expect(retry.body.error).toMatch(/missing/i);
  });
});

// =============================================================================
// 4. End-to-end analysis (image / audio / video), enrichment, AI validation
// =============================================================================

describe('4. End-to-end analysis, enrichment and AI validation', () => {
  beforeEach(() => {
    state.complaint = makeComplaint();
  });

  it('image: analyzes, enriches the complaint, re-clusters and serves the file', async () => {
    const res = await attachRequest(jpegBuffer, 'image/jpeg', 'pothole.jpg', ownerToken);

    expect(res.status).toBe(201);
    expect(res.body.data.mediaType).toBe('image');
    expect(res.body.data.processingStatus).toBe('completed');
    expect(res.body.data.analysis.detectedCategory).toBe('infrastructure');
    expect(res.body.data.analysis.needsHumanReview).toBe(false);

    const mediaId = res.body.data.mediaId as number;
    const row = state.media.get(mediaId)!;
    expect(row.processing_status).toBe('completed');
    expect(row.extracted_description).toContain('pothole');
    expect(row.confidence_score).toBeCloseTo(0.92);
    expect(row.needs_human_review).toBe(false);

    // Enrichment + re-clustering
    expect(state.enrichedTexts).toHaveLength(1);
    expect(state.complaint!.text).toContain(`[Media Evidence Analysis (image #${mediaId})]:`);
    expect(mockClusterComplaint).toHaveBeenCalledWith(1);

    // Agent audit trail
    const agentLogs = state.queries.filter((q) => q.includes('INSERT INTO agent_execution_log'));
    expect(agentLogs.length).toBeGreaterThanOrEqual(1);

    // Authenticated download round-trip
    expect(res.body.data.serveUrl).toContain('/api/media/');
    const download = await request(app)
      .get(res.body.data.serveUrl)
      .set(auth(ownerToken));
    expect(download.status).toBe(200);
    expect(Buffer.from(download.body).equals(jpegBuffer)).toBe(true);
  });

  it('audio: transcribes and classifies the recording', async () => {
    mockGenerateContent.mockResolvedValue(
      geminiJson({
        description: 'Citizen reports a burst water pipeline flooding the street.',
        rawTranscript: 'There is a pipeline leak near the bus stop.',
        detectedCategory: 'utility',
        severityIndicators: ['standing water'],
        confidence: 0.88,
      })
    );

    const res = await attachRequest(wavBuffer, 'audio/wav', 'leak.wav', ownerToken);

    expect(res.status).toBe(201);
    expect(res.body.data.mediaType).toBe('audio');
    expect(res.body.data.processingStatus).toBe('completed');
    expect(res.body.data.analysis.rawTranscript).toContain('pipeline leak');
    expect(state.complaint!.text).toContain('[Media Evidence Analysis (audio #1)]:');
  });

  itVideo(
    'video: sends real FFmpeg-extracted JPEG frames to Gemini (never raw byte slices)',
    async () => {
      const res = await attachRequest(realVideo!, 'video/mp4', 'road.mp4', ownerToken);

      expect(res.status).toBe(201);
      expect(res.body.data.mediaType).toBe('video');
      expect(res.body.data.processingStatus).toBe('completed');
      expect(res.body.data.analysis.detectedCategory).toBe('infrastructure');

      const parts = mockGenerateContent.mock.calls[0][0] as any[];
      expect(Array.isArray(parts)).toBe(true);

      const imageParts = parts.filter((p) => p && p.inlineData);
      expect(imageParts.length).toBeGreaterThan(0);
      expect(imageParts.length).toBeLessThanOrEqual(3);

      for (const part of imageParts) {
        expect(part.inlineData.mimeType).toBe('image/jpeg');
        const bytes = Buffer.from(part.inlineData.data, 'base64');
        // Real JPEGs decoded by FFmpeg start with FF D8 FF
        expect(bytes[0]).toBe(0xff);
        expect(bytes[1]).toBe(0xd8);
        expect(bytes[2]).toBe(0xff);
        // Must not be a raw slice of the mp4 container (ftyp box)
        expect(bytes.slice(4, 8).toString('ascii')).not.toBe('ftyp');
      }

      expect(res.body.data.analysis.frameCount).toBeGreaterThan(0);
      expect(state.complaint!.text).toContain('[Media Evidence Analysis (video #1)]:');
      expect(mockClusterComplaint).toHaveBeenCalledWith(1);
    }
  );

  it('marks the attachment failed (and skips enrichment) when the AI returns malformed JSON', async () => {
    mockGenerateContent.mockResolvedValue({
      response: { text: () => 'Sorry, I cannot produce JSON right now.' },
    });

    const res = await attachRequest(jpegBuffer, 'image/jpeg', 'broken.jpg', ownerToken);

    expect(res.status).toBe(201);
    expect(res.body.data.processingStatus).toBe('failed');
    expect(res.body.data.analysis.needsHumanReview).toBe(true);
    expect(state.media.get(1)!.processing_status).toBe('failed');
    expect(state.enrichedTexts).toHaveLength(0);
    expect(mockClusterComplaint).not.toHaveBeenCalled();
  });

  it('keeps a valid low-confidence result as completed but flagged for human review', async () => {
    mockGenerateContent.mockResolvedValue(
      geminiJson({
        description: 'Possibly a damaged road surface.',
        detectedCategory: 'infrastructure',
        severityIndicators: [],
        confidence: 0.4,
      })
    );

    const res = await attachRequest(jpegBuffer, 'image/jpeg', 'uncertain.jpg', ownerToken);

    expect(res.status).toBe(201);
    expect(res.body.data.processingStatus).toBe('completed');
    expect(res.body.data.analysis.needsHumanReview).toBe(true);
    expect(res.body.data.analysis.analysisFailed).toBeFalsy();
    // A real (low-confidence) description still enriches the complaint
    expect(state.enrichedTexts).toHaveLength(1);
    expect(mockClusterComplaint).toHaveBeenCalledWith(1);
  });

  it('lists attachments for the owner with serve URLs and status', async () => {
    await attachRequest(jpegBuffer, 'image/jpeg', 'pothole.jpg', ownerToken);

    const res = await request(app).get('/api/complaints/1/media').set(auth(ownerToken));
    expect(res.status).toBe(200);
    expect(res.body.meta.count).toBe(1);
    expect(res.body.data[0]).toMatchObject({
      mediaType: 'image',
      processingStatus: 'completed',
      originalFilename: 'pothole.jpg',
    });
    expect(res.body.data[0].serveUrl).toContain('/api/media/');
  });

  describe('6. Direct Browser-to-Storage Presign and Confirmation (Phase 2B)', () => {
    it('requires a bearer token to request a presigned upload URL', async () => {
      const res = await request(app)
        .post('/api/complaints/1/media/presign')
        .send({ mimeType: 'image/jpeg', fileSizeBytes: 1024, filename: 'road.jpg' });
      expect(res.status).toBe(401);
    });

    it('rejects presign request from a non-owner with 403', async () => {
      const res = await request(app)
        .post('/api/complaints/1/media/presign')
        .set(auth(otherToken))
        .send({ mimeType: 'image/jpeg', fileSizeBytes: 1024, filename: 'road.jpg' });
      expect(res.status).toBe(403);
    });

    it('rejects presign for invalid or unsupported MIME type', async () => {
      const res = await request(app)
        .post('/api/complaints/1/media/presign')
        .set(auth(ownerToken))
        .send({ mimeType: 'application/x-executable', fileSizeBytes: 1024, filename: 'bad.exe' });
      expect(res.status).toBe(400);
      expect(res.body.error).toContain('Unsupported media type');
    });

    it('rejects presign for oversized files exceeding format limit', async () => {
      const res = await request(app)
        .post('/api/complaints/1/media/presign')
        .set(auth(ownerToken))
        .send({ mimeType: 'image/jpeg', fileSizeBytes: 15 * 1024 * 1024, filename: 'giant.jpg' });
      expect(res.status).toBe(400);
      expect(res.body.error).toContain('exceeds the maximum allowed limit');
    });

    it('generates a presigned upload URL and staging storage key for owner', async () => {
      const res = await request(app)
        .post('/api/complaints/1/media/presign')
        .set(auth(ownerToken))
        .send({ mimeType: 'image/jpeg', fileSizeBytes: 1024 * 50, filename: 'pothole.jpg' });

      expect(res.status).toBe(200);
      expect(res.body.uploadUrl).toBeDefined();
      expect(res.body.storageKey).toMatch(/^staging\/complaints\/1\/[a-f0-9-]+\.jpg$/);
      expect(res.body.expiresInSeconds).toBe(300);
    });

    it('rejects confirmation with staging key if ticket was not issued by presign', async () => {
      const res = await request(app)
        .post('/api/complaints/1/media/confirm')
        .set(auth(ownerToken))
        .send({
          storageKey: 'staging/complaints/1/unissued-key.jpg',
          mimeType: 'image/jpeg',
          originalFilename: 'pothole.jpg',
        });

      expect(res.status).toBe(403);
      expect(res.body.error).toContain('Storage key was not issued by presign');
    });

    it('rejects confirmation when storageKey does not belong to the complaint (wrong complaint prefix)', async () => {
      const res = await request(app)
        .post('/api/complaints/1/media/confirm')
        .set(auth(ownerToken))
        .send({
          storageKey: 'complaints/999/other-file.jpg',
          mimeType: 'image/jpeg',
          originalFilename: 'pothole.jpg',
        });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('must strictly belong to complaint 1');
    });

    it('returns 404 on confirmation when object does not exist in storage', async () => {
      const res = await request(app)
        .post('/api/complaints/1/media/confirm')
        .set(auth(ownerToken))
        .send({
          storageKey: 'complaints/1/missing-uuid.jpg',
          mimeType: 'image/jpeg',
          originalFilename: 'pothole.jpg',
        });

      expect(res.status).toBe(404);
      expect(res.body.error).toContain('Media file not found in storage');
    });

    it('promotes staging upload to finalized key, preventing presigned PUT reuse and overwrite', async () => {
      // 1. Request presigned URL
      const presignRes = await request(app)
        .post('/api/complaints/1/media/presign')
        .set(auth(ownerToken))
        .send({ mimeType: 'image/jpeg', fileSizeBytes: jpegBuffer.length, filename: 'pothole.jpg' });

      const stagingKey = presignRes.body.storageKey;
      expect(stagingKey).toMatch(/^staging\/complaints\/1\//);

      // 2. Simulate browser uploading to the staging key
      const storage = getStorageProvider();
      await storage.put(stagingKey, jpegBuffer, 'image/jpeg');

      // 3. Confirm upload
      const confirmRes = await request(app)
        .post('/api/complaints/1/media/confirm')
        .set(auth(ownerToken))
        .send({
          storageKey: stagingKey,
          mimeType: 'image/jpeg',
          originalFilename: 'pothole.jpg',
        });

      expect(confirmRes.status).toBe(201);
      // Key is promoted to finalized key (no staging/ prefix)
      expect(confirmRes.body.data.storageKey).toMatch(/^complaints\/1\/[a-f0-9-]+\.jpg$/);
      expect(confirmRes.body.data.storageKey).not.toContain('staging/');

      // Verify the staging object was removed (cannot be overwritten or reused)
      const stagingExists = await storage.exists(stagingKey);
      expect(stagingExists).toBe(false);

      // Verify finalized object exists
      const finalizedExists = await storage.exists(confirmRes.body.data.storageKey);
      expect(finalizedExists).toBe(true);
    });

    it('rejects confirmation and deletes oversized files based on getMetadata check', async () => {
      const storage = getStorageProvider();
      const stagingKey = 'complaints/1/huge-image.jpg';
      // Put 12 MB file (limit is 10 MB for images)
      const hugeBuffer = Buffer.alloc(12 * 1024 * 1024);
      await storage.put(stagingKey, hugeBuffer, 'image/jpeg');

      const res = await request(app)
        .post('/api/complaints/1/media/confirm')
        .set(auth(ownerToken))
        .send({
          storageKey: stagingKey,
          mimeType: 'image/jpeg',
          originalFilename: 'huge.jpg',
        });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('exceeds allowed limit');
      const existsAfter = await storage.exists(stagingKey);
      expect(existsAfter).toBe(false);
    });

    it('confirms direct upload, inspects storage bytes, enriches complaint, and executes analysis', async () => {
      const storage = getStorageProvider();
      const storageKey = 'complaints/1/direct-valid-evidence.jpg';
      await storage.put(storageKey, jpegBuffer, 'image/jpeg');

      const res = await request(app)
        .post('/api/complaints/1/media/confirm')
        .set(auth(ownerToken))
        .send({
          storageKey,
          mimeType: 'image/jpeg',
          originalFilename: 'evidence.jpg',
        });

      expect(res.status).toBe(201);
      expect(res.body.data.processingStatus).toBe('completed');
      expect(res.body.data.storageKey).toBe(storageKey);
      expect(res.body.data.mediaType).toBe('image');
      expect(res.body.data.analysis.description).toBe('Large pothole in the middle of the road.');
      expect(state.media.size).toBe(1);
    });

    it('rejects confirmation and deletes corrupted or spoofed file content from storage', async () => {
      const storage = getStorageProvider();
      const storageKey = 'complaints/1/spoofed-upload.jpg';
      // Write fake plain-text bytes claiming to be JPEG
      await storage.put(storageKey, Buffer.from('NOT_A_REAL_JPEG_IMAGE_HEADER'), 'image/jpeg');

      const res = await request(app)
        .post('/api/complaints/1/media/confirm')
        .set(auth(ownerToken))
        .send({
          storageKey,
          mimeType: 'image/jpeg',
          originalFilename: 'malicious.jpg',
        });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('File content does not match the declared MIME type');
      // Verify object was deleted from storage
      const existsAfter = await storage.exists(storageKey);
      expect(existsAfter).toBe(false);
    });

    it('enforces atomic single-use ticket consumption preventing concurrent confirmation races', async () => {
      // 1. Request presigned ticket
      const presignRes = await request(app)
        .post('/api/complaints/1/media/presign')
        .set(auth(ownerToken))
        .send({ mimeType: 'image/jpeg', fileSizeBytes: jpegBuffer.length, filename: 'race.jpg' });

      const stagingKey = presignRes.body.storageKey;
      const storage = getStorageProvider();
      await storage.put(stagingKey, jpegBuffer, 'image/jpeg');

      // 2. Fire two confirmation requests simultaneously
      const [res1, res2] = await Promise.all([
        request(app)
          .post('/api/complaints/1/media/confirm')
          .set(auth(ownerToken))
          .send({ storageKey: stagingKey, mimeType: 'image/jpeg', originalFilename: 'race.jpg' }),
        request(app)
          .post('/api/complaints/1/media/confirm')
          .set(auth(ownerToken))
          .send({ storageKey: stagingKey, mimeType: 'image/jpeg', originalFilename: 'race.jpg' }),
      ]);

      // Exactly one request successfully confirms the staging ticket (201)
      // The second request either gets 201 (via DB idempotency of finalized key) or 403 (ticket already consumed)
      const statuses = [res1.status, res2.status];
      expect(statuses).toContain(201);
      // DB has exactly 1 row recorded for this media
      expect(state.media.size).toBe(1);
    });

    it('retries confirmation after a temporary database failure without losing the staging upload', async () => {
      const presignRes = await request(app)
        .post('/api/complaints/1/media/presign')
        .set(auth(ownerToken))
        .send({ mimeType: 'image/jpeg', fileSizeBytes: jpegBuffer.length, filename: 'retry-db.jpg' });

      const stagingKey = presignRes.body.storageKey;
      const storage = getStorageProvider();
      await storage.put(stagingKey, jpegBuffer, 'image/jpeg');

      let failedOnce = false;
      mockPool.query.mockImplementation(async (sql: string, params: any[]) => {
        if (!failedOnce && String(sql).includes('INSERT INTO complaint_media')) {
          failedOnce = true;
          throw new Error('temporary database outage');
        }
        return routeQuery(sql, params);
      });

      const first = await request(app)
        .post('/api/complaints/1/media/confirm')
        .set(auth(ownerToken))
        .send({ storageKey: stagingKey, mimeType: 'image/jpeg', originalFilename: 'retry-db.jpg' });

      expect(first.status).toBe(503);
      expect(state.media.size).toBe(0);
      // The uploaded bytes are preserved so the client can retry safely.
      expect(await storage.exists(stagingKey)).toBe(true);

      mockPool.query.mockImplementation(routeQuery);

      const second = await request(app)
        .post('/api/complaints/1/media/confirm')
        .set(auth(ownerToken))
        .send({ storageKey: stagingKey, mimeType: 'image/jpeg', originalFilename: 'retry-db.jpg' });

      expect(second.status).toBe(201);
      expect(second.body.data.storageKey).toMatch(/^complaints\/1\//);
      expect(state.media.size).toBe(1);
      expect(await storage.exists(stagingKey)).toBe(false);
    });

    it('rejects confirmation when ticket has expired', async () => {
      const storageKey = 'staging/complaints/1/expired-ticket.jpg';
      const storage = getStorageProvider();
      await storage.put(storageKey, jpegBuffer, 'image/jpeg');

      // Manually register an expired ticket
      const { registerPresignedTicket } = await import('../src/routes/media');
      await registerPresignedTicket(storageKey, {
        complaintId: 1,
        userId: 777,
        mimeType: 'image/jpeg',
        fileSizeBytes: jpegBuffer.length,
        expiresAt: Date.now() - 1000, // already expired
        confirmed: false,
      });

      const res = await request(app)
        .post('/api/complaints/1/media/confirm')
        .set(auth(ownerToken))
        .send({
          storageKey,
          mimeType: 'image/jpeg',
          originalFilename: 'expired.jpg',
        });

      expect(res.status).toBe(410);
      expect(res.body.error).toContain('Upload ticket has expired');
    });
  });
});
