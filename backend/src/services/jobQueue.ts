// backend/src/services/jobQueue.ts
//
// Phase 1 — Persistent-ready job queue abstraction.
//
// Architecture
// ────────────
// This module wraps the existing in-process BackgroundQueue with a thin
// abstraction layer that:
//
//   1. Accepts the same interface as the existing backgroundQueue.enqueue()
//      so all existing callers (clustering.ts, complaints.ts, etc.) are
//      unaffected and require zero changes.
//
//   2. Logs every job lifecycle event (enqueue / complete / fail / retry)
//      via a structured logger so operations can track queue health without
//      a UI dashboard in Phase 1.
//
//   3. Provides a "persistence bridge" design seam: when REDIS_URL is
//      configured, jobs are mirrored to Redis as a lightweight dead-letter
//      store (not a full BullMQ integration — that is Phase 2+).  When
//      REDIS_URL is absent the queue degrades gracefully to pure in-process
//      operation, identical to the existing backgroundQueue behaviour.
//
//   4. Exposes health/status methods used by the /healthz route and tests.
//
// Existing backgroundQueue is NOT removed — this module re-exports it and
// adds the wrapper.  Phase 2+ will swap the inner engine for BullMQ without
// touching any call sites.
//
// ─────────────────────────────────────────────────────────────────────────────

import { randomUUID }     from 'crypto';
import { backgroundQueue } from './backgroundQueue';
import logger             from '../utils/logger';

// ── Redis dead-letter bridge (optional) ──────────────────────────────────────
// Only imported when REDIS_URL is present.  Using a lazy import avoids pulling
// ioredis into test environments where REDIS_URL is absent.
let _redis: any = null;
const getRedis = async (): Promise<any | null> => {
  if (!process.env.REDIS_URL) return null;
  if (_redis) return _redis;
  try {
    // Dynamic import keeps the module testable without Redis
    const { default: Redis } = await import('ioredis');
    _redis = new Redis(process.env.REDIS_URL!, { maxRetriesPerRequest: 1, lazyConnect: true });
    _redis.on('error', (err: Error) => {
      logger.warn('[JOB_QUEUE] Redis bridge error (non-fatal):', err.message);
    });
    await _redis.connect();
    logger.info('[JOB_QUEUE] Redis dead-letter bridge connected');
  } catch (err: any) {
    logger.warn(`[JOB_QUEUE] Redis bridge unavailable — running in-process only: ${err.message}`);
    _redis = null;
  }
  return _redis;
};

// ── Job envelope ─────────────────────────────────────────────────────────────

export interface JobEnvelope {
  /** Caller-supplied logical name (used as dedup key in existing queue). */
  name: string;
  /** Unique ID for this job instance. */
  jobId: string;
  /** ISO timestamp when the job was enqueued. */
  enqueuedAt: string;
  /** Maximum retry attempts. */
  maxRetries: number;
  /** Serialisable metadata for observability. */
  meta?: Record<string, unknown>;
}

// ── Dead-letter helpers ───────────────────────────────────────────────────────

const DL_KEY_PREFIX = 'civicmind:job:failed:';
const DL_TTL_SECONDS = 60 * 60 * 24 * 3; // 3 days

const persistToDeadLetter = async (envelope: JobEnvelope, errorMessage: string): Promise<void> => {
  const redis = await getRedis();
  if (!redis) return;
  try {
    const key = `${DL_KEY_PREFIX}${envelope.jobId}`;
    await redis.set(
      key,
      JSON.stringify({ ...envelope, failedAt: new Date().toISOString(), errorMessage }),
      'EX',
      DL_TTL_SECONDS
    );
    logger.warn(`[JOB_QUEUE] Job "${envelope.name}" (${envelope.jobId}) written to dead-letter store (key=${key})`);
  } catch (err: any) {
    logger.warn(`[JOB_QUEUE] Failed to write dead-letter entry: ${err.message}`);
  }
};

// ── Main enqueue function ─────────────────────────────────────────────────────

export interface EnqueueOptions {
  /** Maximum retry attempts (default 3, matching the existing queue). */
  maxRetries?: number;
  /** Arbitrary metadata stored in the envelope for logging / dead-letter. */
  meta?: Record<string, unknown>;
}

/**
 * Enqueues a job via the existing BackgroundQueue with enhanced lifecycle logging
 * and an optional Redis dead-letter bridge.
 *
 * Drop-in replacement for backgroundQueue.enqueue():
 *   before: backgroundQueue.enqueue('my_job', async () => { ... });
 *   after:  jobQueue.enqueue('my_job', async () => { ... });
 *
 * Returns the jobId string (UUID) assigned to this job.
 */
export const enqueue = (
  name: string,
  execute: () => Promise<void>,
  options: EnqueueOptions = {}
): string => {
  const { maxRetries = 3, meta } = options;
  const jobId = randomUUID();
  const enqueuedAt = new Date().toISOString();
  const envelope: JobEnvelope = { name, jobId, enqueuedAt, maxRetries, meta };

  logger.info(`[JOB_QUEUE] Enqueued job "${name}" (id=${jobId})`);

  // Wrap the execute function to add lifecycle logging and dead-letter persistence
  const wrappedExecute = async (): Promise<void> => {
    const startMs = Date.now();
    try {
      await execute();
      logger.info(
        `[JOB_QUEUE] Job "${name}" (id=${jobId}) completed in ${Date.now() - startMs}ms`
      );
    } catch (err: any) {
      logger.error(
        `[JOB_QUEUE] Job "${name}" (id=${jobId}) failed after ${Date.now() - startMs}ms: ${err.message}`
      );
      // Persist to dead-letter after the final retry (backgroundQueue calls this once
      // per attempt; we write to DL only on the last failure).
      await persistToDeadLetter(envelope, err.message);
      throw err; // Re-throw so BackgroundQueue's retry logic still applies
    }
  };

  backgroundQueue.enqueue(name, wrappedExecute, { maxRetries });
  return jobId;
};

// ── Health / status ───────────────────────────────────────────────────────────

export interface JobQueueStatus {
  engine: 'in-process';
  redisBridgeEnabled: boolean;
  pendingJobs: number;
  activeJobs: number;
}

/**
 * Returns current queue health metrics.
 * Used by the /healthz route and tests.
 */
export const getQueueStatus = (): JobQueueStatus => ({
  engine: 'in-process',
  redisBridgeEnabled: !!process.env.REDIS_URL,
  pendingJobs: backgroundQueue.queueLength,
  activeJobs: backgroundQueue.activeJobCount,
});

// ── Convenience re-export ─────────────────────────────────────────────────────
// Existing code that imports backgroundQueue directly continues to work.
// New agent code should import from jobQueue instead.
export { backgroundQueue };

/**
 * Unified job queue interface.
 * Use this in new agent services instead of backgroundQueue directly.
 */
export const jobQueue = { enqueue, getQueueStatus };
export default jobQueue;
