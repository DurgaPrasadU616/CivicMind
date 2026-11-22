// backend/tests/mediaJobReliability.test.ts
//
// Phase 2B.3 — Durable media-job reliability tests.
//
// The complaint_media row is the durable job record. These tests verify:
//   • duplicate delivery is idempotent (atomic claim)
//   • failures leave a retryable `failed` row and can recover
//   • status transitions pending → processing → completed/failed
//   • stale pending/processing rows are recovered
//   • QStash publish is used when configured, inline execution otherwise
//   • QStash webhook signatures are verified against the raw body

import crypto from 'crypto';
import jwt from 'jsonwebtoken';

jest.mock('../src/config/db', () => ({
  pool: { query: jest.fn() },
  checkDbConnection: jest.fn(),
}));

jest.mock('../src/services/storage', () => ({
  getStorageProvider: jest.fn(),
}));

jest.mock('../src/services/mediaAnalysis', () => ({
  analyzeMedia: jest.fn(),
  getMediaType: jest.fn((mime: string) => {
    if (mime.startsWith('image/')) return 'image';
    if (mime.startsWith('audio/')) return 'audio';
    return 'video';
  }),
  MAX_VIDEO_SIZE_BYTES: 50 * 1024 * 1024,
}));

jest.mock('../src/services/clustering', () => ({
  clusterComplaint: jest.fn(),
}));

jest.mock('../src/utils/agentLogger', () => ({
  startAgentRun: jest.fn(() => ({ log: jest.fn().mockResolvedValue(undefined) })),
  logAgentStep: jest.fn(),
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

import { pool } from '../src/config/db';
import { getStorageProvider } from '../src/services/storage';
import { analyzeMedia } from '../src/services/mediaAnalysis';
import { startAgentRun } from '../src/utils/agentLogger';
import {
  runMediaAnalysisJob,
  recoverStaleMediaJobs,
  dispatchMediaAnalysisJob,
  MAX_MEDIA_ANALYSIS_ATTEMPTS,
} from '../src/services/complaintMediaService';
import { verifyQStashSignature } from '../src/services/qstash';

const mockPool = pool as unknown as { query: jest.Mock };
const mockGetStorageProvider = getStorageProvider as jest.Mock;
const mockAnalyzeMedia = analyzeMedia as jest.Mock;
const mockStartAgentRun = startAgentRun as jest.Mock;

interface MediaRow {
  id: number;
  complaint_id: number;
  storage_key: string;
  mime_type: string;
  processing_status: 'pending' | 'processing' | 'completed' | 'failed' | 'skipped';
  error_message: string | null;
  created_at: Date;
  attempt_count: number;
  next_retry_at: Date | null;
  lease_until: Date | null;
  lease_token: string | null;
  manual_intervention: boolean;
  failure_history: any[];
}

let rows: Map<number, MediaRow>;
let failFinalizeOnce = false;
let storage: {
  exists: jest.Mock;
  get: jest.Mock;
  getServeUrl: jest.Mock;
};

const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x41, 0x42]);

function seedRow(overrides: Partial<MediaRow> = {}): MediaRow {
  const row: MediaRow = {
    id: 1,
    complaint_id: 1,
    storage_key: 'complaints/1/evidence.jpg',
    mime_type: 'image/jpeg',
    processing_status: 'pending',
    error_message: null,
    created_at: new Date(Date.now() - 10 * 60 * 1000),
    attempt_count: 0,
    next_retry_at: null,
    lease_until: null,
    lease_token: null,
    manual_intervention: false,
    failure_history: [],
    ...overrides,
  };
  rows.set(row.id, row);
  return row;
}

async function routeQuery(sqlValue: string, params: any[] = []): Promise<{ rows: any[]; rowCount?: number }> {
  const s = String(sqlValue).replace(/\s+/g, ' ').trim();

  // Atomic per-job claim with durable lease and retry eligibility checks.
  if (s.startsWith('UPDATE complaint_media SET processing_status = \'processing\', failure_history = CASE')) {
    const [id, token, leaseSeconds, maxAttempts] = params;
    const row = rows.get(id);
    const eligible = row && row.attempt_count < maxAttempts && (
      row.processing_status === 'pending' ||
      (row.processing_status === 'failed' && !row.manual_intervention &&
        (!row.lease_until || row.lease_until <= new Date()) &&
        (!row.next_retry_at || row.next_retry_at <= new Date())) ||
      (row.processing_status === 'processing' && !!row.lease_until && row.lease_until <= new Date())
    );
    if (!eligible || !row) return { rows: [] };
    row.failure_history.push({ status: 'retry_claimed', error: row.error_message });
    row.processing_status = 'processing';
    row.attempt_count++;
    row.next_retry_at = null;
    row.lease_token = token;
    row.lease_until = new Date(Date.now() + leaseSeconds * 1000);
    row.error_message = null;
    return { rows: [{ ...row }] };
  }

  // Exhausted attempts are closed for automatic processing.
  if (s.startsWith('UPDATE complaint_media SET manual_intervention = TRUE')) {
    const byId = s.includes('WHERE id = $1');
    const id = byId ? params[0] : undefined;
    const maxAttempts = byId ? params[1] : params[0];
    const targets = id ? [rows.get(id)].filter(Boolean) as MediaRow[] : [...rows.values()];
    const updated: MediaRow[] = [];
    for (const row of targets) {
      const exhausted = row.attempt_count >= maxAttempts && !row.manual_intervention &&
        ((row.processing_status === 'failed' && (!row.lease_until || row.lease_until <= new Date())) ||
         (row.processing_status === 'processing' && !!row.lease_until && row.lease_until <= new Date()));
      if (exhausted) {
        row.manual_intervention = true;
        row.next_retry_at = null;
        row.lease_token = null;
        row.lease_until = null;
        row.error_message ||= 'Maximum media-analysis attempts exhausted.';
        updated.push(row);
      }
    }
    return { rows: updated.map((row) => ({ id: row.id })) };
  }

  if (s.startsWith('SELECT processing_status, error_message, next_retry_at, attempt_count, manual_intervention')) {
    const row = rows.get(params[0]);
    return { rows: row ? [{
      processing_status: row.processing_status,
      error_message: row.error_message,
      next_retry_at: row.next_retry_at,
      attempt_count: row.attempt_count,
      manual_intervention: row.manual_intervention,
    }] : [] };
  }

  if (s.includes("SET processing_status = 'failed', error_message = $1")) {
    const row = rows.get(params[1]);
    if (row && (!params[2] || row.lease_token === params[2])) {
      row.processing_status = 'failed';
      row.error_message = params[0];
    }
    return { rows: [], rowCount: row ? 1 : 0 };
  }

  // Atomic SKIP LOCKED recovery claim. Updating to processing and setting a
  // new lease happens in the same statement in the real PostgreSQL query.
  if (s.startsWith('WITH candidates AS')) {
    const [maxAttempts, pendingCutoff, token, leaseSeconds] = params;
    const matches = [...rows.values()]
      .filter((row) => row.attempt_count < maxAttempts && (
        (row.processing_status === 'pending' && row.created_at <= pendingCutoff) ||
        (row.processing_status === 'failed' && !row.manual_intervention &&
          (!row.lease_until || row.lease_until <= new Date()) &&
          (!row.next_retry_at || row.next_retry_at <= new Date())) ||
        (row.processing_status === 'processing' && !!row.lease_until && row.lease_until <= new Date())
      ))
      .sort((a, b) => a.id - b.id)
      .slice(0, 1);
    for (const row of matches) {
      row.failure_history.push({ status: 'retry_claimed', error: row.error_message });
      row.processing_status = 'processing';
      row.attempt_count++;
      row.next_retry_at = null;
      row.lease_token = token;
      row.lease_until = new Date(Date.now() + leaseSeconds * 1000);
      row.error_message = null;
    }
    return { rows: matches.map((row) => ({ ...row })) };
  }

  // processMediaAnalysis marks processing
  if (s.includes("SET processing_status = 'processing' WHERE id = $1")) {
    const row = rows.get(params[0]);
    const valid = row && (!params[1] || (row.lease_token === params[1] && !!row.lease_until && row.lease_until > new Date()));
    if (valid) row.processing_status = 'processing';
    return { rows: [], rowCount: valid ? 1 : 0 };
  }

  if (s.startsWith('UPDATE complaint_media SET extracted_description = $1')) {
    const row = rows.get(params[5]);
    const valid = row && row.lease_token === params[6] && !!row.lease_until && row.lease_until > new Date();
    if (valid) row.error_message = params[4];
    return { rows: [], rowCount: valid ? 1 : 0 };
  }

  // processMediaAnalysis persists success
  if (s.includes("SET processing_status = 'completed'")) {
    const row = rows.get(params[4]);
    if (row && (!params[5] || row.lease_token === params[5])) {
      row.processing_status = 'completed';
      row.error_message = null;
    }
    return { rows: [], rowCount: row ? 1 : 0 };
  }

  // processMediaAnalysis persists AI failure
  if (s.includes("SET processing_status = 'failed'") && s.includes('extracted_description')) {
    const row = rows.get(params[4]);
    if (row && (!params[6] || row.lease_token === params[6])) {
      row.processing_status = 'failed';
      row.error_message = params[5] ?? null;
    }
    return { rows: [], rowCount: row ? 1 : 0 };
  }

  // Persist terminal job result and attempt history under the active lease.
  if (s.startsWith('UPDATE complaint_media SET processing_status = $1, error_message = $2')) {
    if (failFinalizeOnce) {
      failFinalizeOnce = false;
      throw new Error('temporary database outage while finalizing');
    }
    const [status, error, retryAt, manual, _attempt, id, token] = params;
    const row = rows.get(id);
    if (row && row.lease_token === token) {
      row.processing_status = status;
      row.error_message = error;
      row.next_retry_at = retryAt;
      row.manual_intervention = manual;
      row.lease_token = null;
      row.lease_until = null;
      row.failure_history.push({ status, error, retryAt, manual });
      return { rows: [], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  }

  if (s.startsWith('UPDATE complaint_media SET error_message = COALESCE')) {
    const row = rows.get(params[1]);
    const valid = row && row.lease_token === params[2] && !!row.lease_until && row.lease_until > new Date();
    if (valid) row.error_message = params[0] || 'Media analysis finished but finalization must be retried.';
    return { rows: [], rowCount: valid ? 1 : 0 };
  }

  if (s.includes('SELECT text, category, idempotency_key FROM complaint WHERE id = $1')) {
    return { rows: [{ text: 'Pothole on 1st cross', category: 'infrastructure', idempotency_key: 'idem-1' }] };
  }

  if (s.startsWith('UPDATE complaint SET text')) {
    return { rows: [] };
  }

  if (s.includes('INSERT INTO agent_execution_log')) {
    return { rows: [{ id: 1 }] };
  }

  throw new Error(`Unhandled SQL in mediaJobReliability.test.ts: ${s.slice(0, 180)}`);
}

beforeEach(() => {
  rows = new Map();
  failFinalizeOnce = false;
  storage = {
    exists: jest.fn().mockResolvedValue(true),
    get: jest.fn().mockResolvedValue(jpeg),
    getServeUrl: jest.fn().mockResolvedValue('http://storage.local/evidence.jpg'),
  };
  mockGetStorageProvider.mockReturnValue(storage);
  mockPool.query.mockImplementation(routeQuery);
  mockStartAgentRun.mockReturnValue({ log: jest.fn().mockResolvedValue(undefined) });
  mockAnalyzeMedia.mockReset();
  mockAnalyzeMedia.mockResolvedValue({
    mediaType: 'image',
    description: 'Pothole in the road',
    detectedCategory: 'infrastructure',
    severityIndicators: [],
    confidence: 0.9,
    needsHumanReview: false,
  });

  delete process.env.QSTASH_TOKEN;
  delete process.env.QSTASH_CURRENT_SIGNING_KEY;
  delete process.env.QSTASH_NEXT_SIGNING_KEY;
  delete process.env.PUBLIC_BASE_URL;
  delete process.env.QSTASH_MEDIA_JOB_URL;
});

afterEach(() => {
  delete process.env.QSTASH_TOKEN;
  delete process.env.QSTASH_CURRENT_SIGNING_KEY;
  delete process.env.QSTASH_NEXT_SIGNING_KEY;
  delete process.env.PUBLIC_BASE_URL;
  delete process.env.QSTASH_MEDIA_JOB_URL;
  delete (global as any).fetch;
});

describe('runMediaAnalysisJob — duplicate delivery and failure recovery', () => {
  it('skips a duplicate delivery after the first job completes', async () => {
    const row = seedRow({ processing_status: 'pending' });

    const first = await runMediaAnalysisJob({
      mediaId: row.id,
      complaintId: row.complaint_id,
      storageKey: row.storage_key,
      mimeType: row.mime_type,
    });
    const second = await runMediaAnalysisJob({
      mediaId: row.id,
      complaintId: row.complaint_id,
      storageKey: row.storage_key,
      mimeType: row.mime_type,
    });

    expect(first.status).toBe('completed');
    expect(second.status).toBe('completed');
    expect(second.skipped).toBe(true);
    expect(mockAnalyzeMedia).toHaveBeenCalledTimes(1);
    expect(row.processing_status).toBe('completed');
  });

  it('leaves a failed row retryable and recovers on the next run', async () => {
    const row = seedRow({ processing_status: 'pending' });
    mockAnalyzeMedia.mockRejectedValueOnce(new Error('temporary Gemini outage'));

    const first = await runMediaAnalysisJob({
      mediaId: row.id,
      complaintId: row.complaint_id,
      storageKey: row.storage_key,
      mimeType: row.mime_type,
    });
    expect(first.status).toBe('failed');
    expect(row.processing_status).toBe('failed');
    expect(row.error_message).toContain('temporary Gemini outage');

    mockAnalyzeMedia.mockResolvedValueOnce({
      mediaType: 'image',
      description: 'Pothole in the road',
      detectedCategory: 'infrastructure',
      severityIndicators: [],
      confidence: 0.9,
      needsHumanReview: false,
    });
    row.next_retry_at = new Date(Date.now() - 1000);

    const retry = await runMediaAnalysisJob({
      mediaId: row.id,
      complaintId: row.complaint_id,
      storageKey: row.storage_key,
      mimeType: row.mime_type,
    });
    expect(retry.status).toBe('completed');
    expect(row.processing_status).toBe('completed');
    expect(mockAnalyzeMedia).toHaveBeenCalledTimes(2);
  });

  it('transitions pending → processing → completed around analysis', async () => {
    const row = seedRow({ processing_status: 'pending' });
    let statusDuringAnalysis = '';

    mockAnalyzeMedia.mockImplementationOnce(async () => {
      statusDuringAnalysis = row.processing_status;
      return {
        mediaType: 'image',
        description: 'Pothole in the road',
        detectedCategory: 'infrastructure',
        severityIndicators: [],
        confidence: 0.9,
        needsHumanReview: false,
      };
    });

    const result = await runMediaAnalysisJob({
      mediaId: row.id,
      complaintId: row.complaint_id,
      storageKey: row.storage_key,
      mimeType: row.mime_type,
    });

    expect(statusDuringAnalysis).toBe('processing');
    expect(result.status).toBe('completed');
    expect(row.processing_status).toBe('completed');
  });

  it('marks the row failed when the stored file is missing', async () => {
    const row = seedRow({ storage_key: 'complaints/1/missing.jpg' });
    storage.exists.mockImplementation(async (key: string) => key !== 'complaints/1/missing.jpg');

    const result = await runMediaAnalysisJob({
      mediaId: row.id,
      complaintId: row.complaint_id,
      storageKey: row.storage_key,
      mimeType: row.mime_type,
    });

    expect(result.status).toBe('failed');
    expect(row.processing_status).toBe('failed');
    expect(row.error_message).toContain('missing');
    expect(mockAnalyzeMedia).not.toHaveBeenCalled();
    expect(row.manual_intervention).toBe(true);
  });

  it('does not immediately repeat a retryable failure before its backoff expires', async () => {
    const row = seedRow();
    mockAnalyzeMedia.mockRejectedValueOnce(new Error('temporary Gemini outage'));

    const first = await runMediaAnalysisJob({
      mediaId: row.id, complaintId: row.complaint_id, storageKey: row.storage_key, mimeType: row.mime_type,
    });
    const duplicate = await runMediaAnalysisJob({
      mediaId: row.id, complaintId: row.complaint_id, storageKey: row.storage_key, mimeType: row.mime_type,
    });

    expect(first.retryAt).toBeTruthy();
    expect(row.next_retry_at!.getTime()).toBeGreaterThan(Date.now());
    expect(duplicate.skipped).toBe(true);
    expect(mockAnalyzeMedia).toHaveBeenCalledTimes(1);
  });

  it('marks a permanently invalid media job for manual intervention without retrying', async () => {
    const row = seedRow();
    mockAnalyzeMedia.mockResolvedValueOnce({
      mediaType: 'image',
      description: 'Media could not be analyzed.',
      detectedCategory: null,
      severityIndicators: [],
      confidence: 0,
      needsHumanReview: true,
      analysisFailed: true,
      failureReason: 'Unsupported MIME type: application/octet-stream',
    });

    const first = await runMediaAnalysisJob({
      mediaId: row.id, complaintId: row.complaint_id, storageKey: row.storage_key, mimeType: row.mime_type,
    });
    const retry = await runMediaAnalysisJob({
      mediaId: row.id, complaintId: row.complaint_id, storageKey: row.storage_key, mimeType: row.mime_type,
    });

    expect(first.manualIntervention).toBe(true);
    expect(row.manual_intervention).toBe(true);
    expect(retry.skipped).toBe(true);
    expect(mockAnalyzeMedia).toHaveBeenCalledTimes(1);
  });

  it('stops automatically after the maximum attempt count', async () => {
    const row = seedRow();
    mockAnalyzeMedia.mockResolvedValue({
      mediaType: 'image',
      description: 'Temporary analysis failure.',
      detectedCategory: null,
      severityIndicators: [],
      confidence: 0,
      needsHumanReview: true,
      analysisFailed: true,
      failureReason: 'temporary Gemini outage',
    });

    for (let attempt = 0; attempt < MAX_MEDIA_ANALYSIS_ATTEMPTS; attempt++) {
      if (row.processing_status === 'failed') row.next_retry_at = new Date(Date.now() - 1000);
      await runMediaAnalysisJob({
        mediaId: row.id, complaintId: row.complaint_id, storageKey: row.storage_key, mimeType: row.mime_type,
      });
    }
    const afterLimit = await runMediaAnalysisJob({
      mediaId: row.id, complaintId: row.complaint_id, storageKey: row.storage_key, mimeType: row.mime_type,
    });

    expect(row.attempt_count).toBe(MAX_MEDIA_ANALYSIS_ATTEMPTS);
    expect(row.manual_intervention).toBe(true);
    expect(afterLimit.manualIntervention).toBe(true);
    expect(mockAnalyzeMedia).toHaveBeenCalledTimes(MAX_MEDIA_ANALYSIS_ATTEMPTS);
  });
});

describe('recoverStaleMediaJobs — no permanent pending rows', () => {
  it('recovers stale pending rows and fails rows whose file is missing', async () => {
    const healthy = seedRow({ id: 1, storage_key: 'complaints/1/healthy.jpg' });
    const missing = seedRow({ id: 2, storage_key: 'complaints/1/gone.jpg' });
    storage.exists.mockImplementation(async (key: string) => key !== missing.storage_key);

    const summary = await recoverStaleMediaJobs(10, 300);

    expect(summary.scanned).toBe(2);
    expect(summary.recovered).toBe(1);
    expect(summary.failed).toBe(0);
    expect(summary.exhausted).toBe(1);
    expect(healthy.processing_status).toBe('completed');
    expect(missing.processing_status).toBe('failed');
  });

  it('reclaims a stale processing row', async () => {
    const row = seedRow({
      processing_status: 'processing',
      created_at: new Date(),
      attempt_count: 1,
      lease_until: new Date(Date.now() - 1000),
    });

    const summary = await recoverStaleMediaJobs(10, 300);

    expect(summary.scanned).toBe(1);
    expect(summary.recovered).toBe(1);
    expect(row.processing_status).toBe('completed');
    expect(row.lease_token).toBeNull();
  });

  it('recovers an eligible failed job after its queued delivery retries have ended', async () => {
    const row = seedRow({
      processing_status: 'failed',
      attempt_count: 1,
      error_message: 'temporary Gemini outage',
      next_retry_at: new Date(Date.now() - 1000),
    });

    const summary = await recoverStaleMediaJobs(5, 300);

    expect(summary.scanned).toBe(1);
    expect(summary.recovered).toBe(1);
    expect(row.processing_status).toBe('completed');
    expect(row.failure_history.some((event) => event.error === 'temporary Gemini outage')).toBe(true);
  });

  it('serializes two concurrent recovery requests against the same eligible job', async () => {
    const row = seedRow({ processing_status: 'failed', next_retry_at: new Date(Date.now() - 1000) });

    const summaries = await Promise.all([
      recoverStaleMediaJobs(5, 300),
      recoverStaleMediaJobs(5, 300),
    ]);

    expect(summaries.reduce((sum, item) => sum + item.scanned, 0)).toBe(1);
    expect(row.processing_status).toBe('completed');
    expect(mockAnalyzeMedia).toHaveBeenCalledTimes(1);
  });

  it('allows only one of two independent serverless job deliveries to claim a row', async () => {
    const row = seedRow();
    const input = {
      mediaId: row.id, complaintId: row.complaint_id, storageKey: row.storage_key, mimeType: row.mime_type,
    };

    const results = await Promise.all([
      runMediaAnalysisJob(input),
      runMediaAnalysisJob(input),
    ]);

    expect(results.filter((result) => result.skipped !== true)).toHaveLength(1);
    expect(row.processing_status).toBe('completed');
    expect(mockAnalyzeMedia).toHaveBeenCalledTimes(1);
  });

  it('reclaims a crashed worker after its database lease expires', async () => {
    const row = seedRow({
      processing_status: 'processing',
      attempt_count: 1,
      lease_token: 'crashed-worker',
      lease_until: new Date(Date.now() - 1000),
    });

    const summary = await recoverStaleMediaJobs(5, 300);

    expect(summary.recovered).toBe(1);
    expect(row.attempt_count).toBe(2);
    expect(row.processing_status).toBe('completed');
    expect(row.lease_token).toBeNull();
  });

  it('retries safely when database failure interrupts failure finalization', async () => {
    const row = seedRow();
    mockAnalyzeMedia.mockRejectedValueOnce(new Error('temporary Gemini outage'));
    failFinalizeOnce = true;

    await runMediaAnalysisJob({
      mediaId: row.id, complaintId: row.complaint_id, storageKey: row.storage_key, mimeType: row.mime_type,
    });
    expect(row.processing_status).toBe('processing');
    row.lease_until = new Date(Date.now() - 1000);

    const summary = await recoverStaleMediaJobs(5, 300);

    expect(summary.recovered).toBe(1);
    expect(row.processing_status).toBe('completed');
    expect(mockAnalyzeMedia).toHaveBeenCalledTimes(2);
  });

  it('does not reclaim a failed job while its previous worker still holds a live lease', async () => {
    const row = seedRow({
      processing_status: 'failed',
      attempt_count: 2,
      lease_token: 'still-working',
      lease_until: new Date(Date.now() + 60_000),
      next_retry_at: new Date(Date.now() - 60_000),
    });

    const summary = await recoverStaleMediaJobs(5, 0);

    expect(summary.scanned).toBe(0);
    expect(row.lease_token).toBe('still-working');
    expect(mockAnalyzeMedia).not.toHaveBeenCalled();
  });

  it('reclaims a failed job with an expired lease only after backoff is due', async () => {
    const row = seedRow({
      processing_status: 'failed',
      attempt_count: 2,
      lease_token: 'expired-worker',
      lease_until: new Date(Date.now() - 60_000),
      next_retry_at: new Date(Date.now() + 60_000),
    });

    const tooEarly = await recoverStaleMediaJobs(5, 0);
    expect(tooEarly.scanned).toBe(0);
    expect(row.lease_token).toBe('expired-worker');

    row.next_retry_at = new Date(Date.now() - 1000);
    const due = await recoverStaleMediaJobs(5, 0);
    expect(due.scanned).toBe(1);
    expect(row.processing_status).toBe('completed');
  });

  it('does not exhaust a failed job or clear its active lease', async () => {
    const row = seedRow({
      processing_status: 'failed',
      attempt_count: MAX_MEDIA_ANALYSIS_ATTEMPTS,
      lease_token: 'active-finalizer',
      lease_until: new Date(Date.now() + 60_000),
      next_retry_at: null,
    });

    const summary = await recoverStaleMediaJobs(5, 0);
    const duplicate = await runMediaAnalysisJob({
      mediaId: row.id, complaintId: row.complaint_id, storageKey: row.storage_key, mimeType: row.mime_type,
    });

    expect(summary.exhausted).toBe(0);
    expect(summary.scanned).toBe(0);
    expect(row.manual_intervention).toBe(false);
    expect(row.lease_token).toBe('active-finalizer');
    expect(duplicate.manualIntervention).toBe(false);
  });

  it('claims recovery jobs sequentially so later rows get fresh leases only after earlier processing', async () => {
    const first = seedRow({ id: 1 });
    const second = seedRow({ id: 2 });
    let releaseFirst!: () => void;
    const firstAnalysis = new Promise<void>((resolve) => { releaseFirst = resolve; });
    mockAnalyzeMedia.mockImplementationOnce(async () => {
      expect(first.processing_status).toBe('processing');
      expect(second.processing_status).toBe('pending');
      expect(second.lease_token).toBeNull();
      await firstAnalysis;
      return {
        mediaType: 'image', description: 'First', detectedCategory: 'infrastructure',
        severityIndicators: [], confidence: 0.9, needsHumanReview: false,
      };
    });

    const recovery = recoverStaleMediaJobs(2, 300);
    await new Promise((resolve) => setImmediate(resolve));
    expect(second.lease_token).toBeNull();
    releaseFirst();
    const summary = await recovery;

    expect(summary.scanned).toBe(2);
    expect(first.processing_status).toBe('completed');
    expect(second.processing_status).toBe('completed');
  });

  it('does not let a stale worker finalize after another worker replaces its lease', async () => {
    const row = seedRow();
    mockAnalyzeMedia.mockImplementationOnce(async () => {
      row.lease_token = 'newer-worker-token';
      row.lease_until = new Date(Date.now() + 60_000);
      return {
        mediaType: 'image', description: 'Old result', detectedCategory: 'infrastructure',
        severityIndicators: [], confidence: 0.9, needsHumanReview: false,
      };
    });

    const result = await runMediaAnalysisJob({
      mediaId: row.id, complaintId: row.complaint_id, storageKey: row.storage_key, mimeType: row.mime_type,
    });

    expect(result.status).toBe('skipped');
    expect(result.leaseLost).toBe(true);
    expect(row.processing_status).toBe('processing');
    expect(row.lease_token).toBe('newer-worker-token');
  });

  it('reports a zero-row finalization as a safe skipped lease-loss result', async () => {
    const row = seedRow();
    const originalQuery = mockPool.query.getMockImplementation()!;
    mockPool.query.mockImplementation(async (sql: string, params: any[] = []) => {
      if (/SET\s+processing_status = \$1,\s+error_message = \$2/.test(String(sql))) {
        return { rows: [], rowCount: 0 };
      }
      return originalQuery(sql, params);
    });

    const result = await runMediaAnalysisJob({
      mediaId: row.id, complaintId: row.complaint_id, storageKey: row.storage_key, mimeType: row.mime_type,
    });

    expect(result.status).toBe('skipped');
    expect(result.skipped).toBe(true);
    expect(result.leaseLost).toBe(true);
    expect(row.processing_status).toBe('processing');
  });

  it('ignores fresh pending rows', async () => {
    const row = seedRow({ processing_status: 'pending', created_at: new Date() });

    const summary = await recoverStaleMediaJobs(10, 300);

    expect(summary.scanned).toBe(0);
    expect(row.processing_status).toBe('pending');
    expect(mockAnalyzeMedia).not.toHaveBeenCalled();
  });
});

describe('dispatchMediaAnalysisJob — QStash vs inline', () => {
  it('runs inline when QStash is not configured (no fire-and-forget)', async () => {
    const row = seedRow({ processing_status: 'pending' });

    const result = await dispatchMediaAnalysisJob({
      mediaId: row.id,
      complaintId: row.complaint_id,
      storageKey: row.storage_key,
      mimeType: row.mime_type,
    });

    expect(result.status).toBe('completed');
    expect(result.queued).not.toBe(true);
    expect(mockAnalyzeMedia).toHaveBeenCalledTimes(1);
  });

  it('publishes to QStash and leaves the row pending when configured', async () => {
    process.env.QSTASH_TOKEN = 'qstash-test-token';
    process.env.QSTASH_CURRENT_SIGNING_KEY = 'current-signing-key';
    process.env.PUBLIC_BASE_URL = 'https://civicmind.example.com';

    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => ({ messageId: 'msg_123' }),
      text: async () => '',
    });
    (global as any).fetch = fetchMock;

    const row = seedRow({ processing_status: 'pending' });

    const result = await dispatchMediaAnalysisJob({
      mediaId: row.id,
      complaintId: row.complaint_id,
      storageKey: row.storage_key,
      mimeType: row.mime_type,
    });

    expect(result.status).toBe('pending');
    expect(result.queued).toBe(true);
    expect(row.processing_status).toBe('pending');
    expect(mockAnalyzeMedia).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toContain('https://qstash.upstash.io/v2/publish/');
    expect(init.headers.Authorization).toBe('Bearer qstash-test-token');
    const body = JSON.parse(init.body);
    expect(body).toMatchObject({
      mediaId: row.id,
      complaintId: row.complaint_id,
      storageKey: row.storage_key,
      mimeType: row.mime_type,
    });
  });
});

describe('QStash webhook signature verification', () => {
  const signingKey = 'test-signing-key';

  function sign(rawBody: string): string {
    const hash = crypto.createHash('sha256').update(rawBody).digest('base64url');
    return jwt.sign(
      { iss: 'Upstash', body: hash, sub: 'https://civicmind.example.com/api/internal/jobs/media-analysis' },
      signingKey,
      { algorithm: 'HS256', expiresIn: '5m' }
    );
  }

  it('accepts a signature matching the raw body', () => {
    process.env.QSTASH_CURRENT_SIGNING_KEY = signingKey;
    const raw = JSON.stringify({ mediaId: 1, complaintId: 1, storageKey: 'k', mimeType: 'image/jpeg' });
    expect(verifyQStashSignature(sign(raw), Buffer.from(raw))).toBe(true);
  });

  it('rejects a signature when the body was tampered with', () => {
    process.env.QSTASH_CURRENT_SIGNING_KEY = signingKey;
    const raw = JSON.stringify({ mediaId: 1, complaintId: 1, storageKey: 'k', mimeType: 'image/jpeg' });
    const tampered = JSON.stringify({ mediaId: 2, complaintId: 1, storageKey: 'k', mimeType: 'image/jpeg' });
    expect(verifyQStashSignature(sign(raw), Buffer.from(tampered))).toBe(false);
  });

  it('rejects when no signing key is configured', () => {
    delete process.env.QSTASH_CURRENT_SIGNING_KEY;
    const raw = '{}';
    expect(verifyQStashSignature(sign(raw), Buffer.from(raw))).toBe(false);
  });
});
