// backend/src/services/complaintMediaService.ts
//
// Phase 3 — Complaint Media Lifecycle and Integration Service
//
// Responsibilities:
//   1. Persist media metadata in PostgreSQL (table `complaint_media`).
//   2. Upload binary payload to the active `StorageProvider`.
//   3. Execute multimodal analysis pipeline (image, audio, video).
//   4. Combine extracted description with the complaint text and re-trigger
//      Phase 2 hybrid clustering (`clusterComplaint`).
//   5. Record structured audit steps using `agentLogger` (type: 'media_analysis').
//   6. Ensure idempotency and avoid duplicate processing or duplicate text appending.
//   7. Never allow AI to automatically change official complaint status or trigger government action.

import { pool } from '../config/db';
import { getStorageProvider } from './storage';
import {
  analyzeMedia,
  MediaAnalysisResult,
  getMediaType,
} from './mediaAnalysis';
import { clusterComplaint } from './clustering';
import { startAgentRun, logAgentStep } from '../utils/agentLogger';
import {
  validateMediaUpload,
  generateStorageKey,
  sanitizeFilename,
} from '../utils/fileValidation';
import { enforceVideoDurationLimit } from '../utils/videoFrames';
import logger from '../utils/logger';
import { getMediaJobUrl, isQStashConfigured, publishQStashJob } from './qstash';
import { randomUUID } from 'crypto';

export const MAX_MEDIA_ANALYSIS_ATTEMPTS = 5;
export const MEDIA_JOB_LEASE_SECONDS = 30 * 60;
const MEDIA_RETRY_BASE_SECONDS = 60;
const MEDIA_RETRY_MAX_SECONDS = 60 * 60;

export function getMediaRetryDelaySeconds(attemptCount: number): number {
  return Math.min(
    MEDIA_RETRY_BASE_SECONDS * 2 ** Math.max(0, attemptCount - 1),
    MEDIA_RETRY_MAX_SECONDS
  );
}

function isPermanentMediaFailure(reason: string): boolean {
  return /stored media file is missing|unsupported mime type|gemini_api_key not configured|video could not be decoded|invalid media|unsupported media/i.test(
    reason
  );
}

function safeMediaError(value: unknown): string {
  const raw = String((value as any)?.message || value || 'Media analysis failed.');
  return raw
    .replace(/Bearer\s+\S+/gi, 'Bearer [redacted]')
    .replace(/AIza[0-9A-Za-z_-]{20,}/g, '[redacted-key]')
    .replace(/\bAKIA[0-9A-Z]{16}\b/g, '[redacted-key]')
    .replace(/\b(authorization|api[_ -]?key|access[_ -]?key|secret|password|token)\b\s*[:=]\s*[^\s,;]+/gi, '$1=[redacted]')
    .replace(/https?:\/\/[^\s"'<>]+/gi, '[external-url]')
    .slice(0, 1000);
}

export interface AttachMediaInput {
  complaintId: number;
  buffer: Buffer;
  mimeType: string;
  originalFilename: string;
  triggeredBy?: string;
  runAnalysisSync?: boolean; // if false, analysis runs in background
}

export interface AttachMediaResult {
  mediaId: number;
  storageKey: string;
  mediaType: 'image' | 'audio' | 'video';
  processingStatus: 'pending' | 'processing' | 'completed' | 'failed' | 'skipped';
  serveUrl: string;
  analysis?: MediaAnalysisResult;
}

export interface ConfirmDirectUploadInput {
  complaintId: number;
  storageKey: string;
  originalFilename: string;
  mimeType: string;
  triggeredBy?: string;
  runAnalysisSync?: boolean;
  /** Size bound recorded in the presigned upload ticket, when available. */
  expectedFileSizeBytes?: number;
}

/**
 * Confirms a direct browser upload after the browser writes to the presigned R2 PUT URL.
 *
 * Verifies:
 * 1. Strict key validation and complaint scoping.
 * 2. Queries metadata (size, existence) BEFORE downloading any object bytes (rejects oversized uploads).
 * 3. Atomic staging-to-finalized promotion: copies staging/complaints/{id}/{uuid}.{ext} to
 *    complaints/{id}/{uuid}.{ext} and deletes the staging object so the presigned PUT URL
 *    cannot overwrite the finalized file.
 * 4. Inspects real file bytes/magic numbers and validates content.
 * 5. Handles video files safely: returns 'pending' status without blocking HTTP request on heavy video decoding.
 */
export async function confirmDirectMediaUpload(
  input: ConfirmDirectUploadInput
): Promise<AttachMediaResult> {
  const {
    complaintId,
    storageKey,
    originalFilename,
    mimeType,
    triggeredBy = 'system',
    runAnalysisSync = true,
    expectedFileSizeBytes,
  } = input;

  // 1. Strict key validation and complaint scoping
  const isStaging = storageKey.startsWith('staging/');
  const normalizedKey = isStaging ? storageKey.slice('staging/'.length) : storageKey;
  const expectedPrefix = `complaints/${complaintId}/`;

  if (!normalizedKey.startsWith(expectedPrefix)) {
    const err: any = new Error(
      `Invalid storage key. Key must strictly belong to complaint ${complaintId}.`
    );
    err.statusCode = 400;
    throw err;
  }

  const storage = getStorageProvider();

  // 2. Prevent duplicate confirmations: check if the finalized key or stagingKey was already confirmed
  const finalizedKey = normalizedKey;
  if (pool) {
    const existingRow = await pool.query(
      'SELECT id, processing_status, storage_key, mime_type FROM complaint_media WHERE storage_key = $1 OR storage_key = $2',
      [finalizedKey, storageKey]
    );
    if (existingRow.rows.length > 0) {
      const row = existingRow.rows[0];
      const existingKey = row.storage_key || finalizedKey;
      const existingMime = row.mime_type || mimeType;
      const serveUrl = await storage.getServeUrl(existingKey);

      // A row left pending by a failed dispatch is re-dispatched on retry.
      // The atomic job claim makes this safe even under duplicate deliveries.
      if (row.processing_status === 'pending') {
        const dispatch = await dispatchMediaAnalysisJob({
          mediaId: row.id,
          complaintId,
          storageKey: existingKey,
          mimeType: existingMime,
          triggeredBy,
        });
        return {
          mediaId: row.id,
          storageKey: existingKey,
          mediaType: getMediaType(existingMime),
          processingStatus:
            dispatch.status === 'completed'
              ? 'completed'
              : dispatch.status === 'failed'
              ? 'failed'
              : 'pending',
          serveUrl,
          analysis: dispatch.analysis,
        };
      }

      return {
        mediaId: row.id,
        storageKey: existingKey,
        mediaType: getMediaType(existingMime),
        processingStatus: row.processing_status,
        serveUrl,
      };
    }
  }

  // 3. Inspect metadata BEFORE downloading (enforces size bounds and existence without memory load)
  let metadata = null;
  if (storage.getMetadata) {
    metadata = await storage.getMetadata(storageKey);
  } else if (!(await storage.exists(storageKey))) {
    metadata = null;
  } else {
    metadata = { size: 1 }; // fallback placeholder if getMetadata is not implemented
  }

  if (!metadata) {
    const err: any = new Error(
      'Media file not found in storage. Upload may have failed, expired, or been aborted.'
    );
    err.statusCode = 404;
    throw err;
  }

  if (
    expectedFileSizeBytes !== undefined &&
    Number(metadata.size) !== expectedFileSizeBytes
  ) {
    const err: any = new Error('Uploaded file size does not match the issued upload ticket.');
    err.statusCode = 400;
    throw err;
  }

  const mediaType = getMediaType(mimeType);
  const maxAllowedBytes =
    mediaType === 'image'
      ? 10 * 1024 * 1024
      : mediaType === 'audio'
      ? 25 * 1024 * 1024
      : 50 * 1024 * 1024;

  if (metadata.size > maxAllowedBytes) {
    // Delete the oversized object from storage
    try {
      await storage.delete(storageKey);
    } catch {}
    const err: any = new Error(
      `Uploaded file size (${(metadata.size / (1024 * 1024)).toFixed(1)} MB) exceeds allowed limit for ${mediaType} files.`
    );
    err.statusCode = 400;
    throw err;
  }

  // 4. Staging -> Finalized Promotion (Part 1: Object Immutability)
  // Copy the staging key to the finalized key. The staging object is only
  // deleted AFTER the complaint_media row is persisted, so a transient DB
  // failure can be retried without losing the uploaded bytes.
  let activeKey = storageKey;
  if (isStaging && storage.copy) {
    try {
      await storage.copy(storageKey, finalizedKey);
      activeKey = finalizedKey;
    } catch (copyErr: any) {
      logger.error(`[MEDIA_SERVICE] Staging promotion failed for ${storageKey}: ${copyErr.message}`);
      throw copyErr;
    }
  }

  // 5. Download buffer for content validation
  // For video files on Vercel: if video is large (> 15 MB), we avoid synchronous decoding to prevent memory exhaustion
  const buffer = await storage.get(activeKey);
  const safeFilename = sanitizeFilename(originalFilename);

  const validation = validateMediaUpload(buffer, mimeType, safeFilename);
  if (!validation.valid || !validation.mediaType) {
    try {
      await storage.delete(activeKey);
      if (isStaging && activeKey !== storageKey) {
        await storage.delete(storageKey);
      }
    } catch {}
    const valErr: any = new Error(validation.error || 'Invalid media content.');
    valErr.statusCode = 400;
    throw valErr;
  }

  // 6. Insert record in complaint_media table BEFORE removing the staging
  // object. A failed insert is a retryable infrastructure error: keep the
  // staging upload intact and surface a 503 so the client can retry.
  let mediaId = 0;
  if (!pool) {
    const dbUnavailable: any = new Error('Database service is unavailable.');
    dbUnavailable.statusCode = 503;
    dbUnavailable.retryable = true;
    throw dbUnavailable;
  }

  try {
    const insertRes = await pool.query(
      `INSERT INTO complaint_media 
         (complaint_id, media_type, storage_key, original_filename, mime_type, file_size, processing_status)
       VALUES ($1, $2, $3, $4, $5, $6, 'pending')
       RETURNING id`,
      [complaintId, mediaType, activeKey, safeFilename, mimeType, buffer.length]
    );
    mediaId = insertRes.rows[0]?.id || 0;
  } catch (dbErr: any) {
    // Remove the finalized copy so retry can redo the promotion cleanly.
    if (isStaging && activeKey !== storageKey) {
      try {
        await storage.delete(activeKey);
      } catch {}
    }
    logger.error(`[MEDIA_SERVICE] Failed to insert complaint_media row: ${dbErr.message}`);
    const persistError: any = new Error(
      'Media record could not be persisted. Please retry the confirmation.'
    );
    persistError.statusCode = 503;
    persistError.retryable = true;
    throw persistError;
  }

  if (mediaId <= 0) {
    if (isStaging && activeKey !== storageKey) {
      try {
        await storage.delete(activeKey);
      } catch {}
    }
    const persistError: any = new Error(
      'Media record could not be persisted. Please retry the confirmation.'
    );
    persistError.statusCode = 503;
    persistError.retryable = true;
    throw persistError;
  }

  // The DB row now durably references the finalized object; the staging object
  // can be removed so the presigned PUT URL cannot overwrite the evidence.
  if (isStaging && activeKey !== storageKey) {
    try {
      await storage.delete(storageKey);
    } catch (cleanupErr: any) {
      logger.warn(`[MEDIA_SERVICE] Could not delete staging object ${storageKey}: ${cleanupErr.message}`);
    }
  }

  const serveUrl = await storage.getServeUrl(activeKey);

  // 7. Video confirmation & Serverless safety (Part 3)
  // Large video files or async query param return 'pending' immediately to prevent Vercel Lambda HTTP timeout
  const isLargeVideo = mediaType === 'video' && buffer.length > 15 * 1024 * 1024;
  const shouldRunAsync = !runAnalysisSync || isLargeVideo;

  if (shouldRunAsync) {
    // Durable dispatch when QStash is configured; otherwise run inline rather
    // than relying on an unawaitable setImmediate() callback.
    const dispatch = await dispatchMediaAnalysisJob({
      mediaId,
      complaintId,
      storageKey: activeKey,
      mimeType,
      triggeredBy,
    });

    return {
      mediaId,
      storageKey: activeKey,
      mediaType,
      processingStatus:
        dispatch.status === 'completed'
          ? 'completed'
          : dispatch.status === 'failed'
          ? 'failed'
          : 'pending',
      serveUrl,
      analysis: dispatch.analysis,
    };
  }

  // Synchronous work still takes a persisted lease so a crashed invocation
  // is recoverable by the same database-backed sweeper.
  const outcome = await runMediaAnalysisJob({
    mediaId,
    complaintId,
    storageKey: activeKey,
    mimeType,
    triggeredBy,
  });

  return {
    mediaId,
    storageKey: activeKey,
    mediaType,
    processingStatus: outcome.status === 'completed'
      ? 'completed'
      : outcome.status === 'failed'
      ? 'failed'
      : outcome.status === 'processing'
      ? 'processing'
      : 'pending',
    serveUrl,
    analysis: outcome.analysis,
  };
}

/**
 * Checks if the complaint_media table exists in the connected database.
 */
export async function checkMediaTableExists(): Promise<boolean> {
  if (!pool) return false;
  try {
    const res = await pool.query(
      `SELECT EXISTS (
         SELECT 1 FROM information_schema.tables 
         WHERE table_name = 'complaint_media'
       ) as exists`
    );
    return res.rows[0]?.exists === true;
  } catch {
    return false;
  }
}

/**
 * Executes AI multimodal analysis for a media record, enriches the parent complaint,
 * re-clusters using the hybrid clustering engine, and records structured audit logs.
 *
 * Returns the analysis result plus the persisted processing status so callers can
 * surface real failures ('failed') instead of assuming success.
 */
export interface ProcessMediaAnalysisOutcome {
  analysis: MediaAnalysisResult;
  status: 'completed' | 'failed';
  failureReason?: string;
}

export async function processMediaAnalysis(
  complaintId: number,
  mediaId: number,
  buffer: Buffer,
  mimeType: string,
  triggeredBy = 'system',
  jobLeaseToken?: string
): Promise<ProcessMediaAnalysisOutcome> {
  const startTime = Date.now();
  const mediaType = getMediaType(mimeType);

  const run = startAgentRun('media_analysis', {
    complaintId,
    triggeredBy,
  });

  // Step 1: Update status to processing
  if (pool) {
    try {
      const processingUpdate = await pool.query(
        `UPDATE complaint_media 
         SET processing_status = 'processing' 
         WHERE id = $1${jobLeaseToken ? ' AND lease_token = $2 AND lease_until > NOW()' : ''}`,
        jobLeaseToken ? [mediaId, jobLeaseToken] : [mediaId]
      );
      if (jobLeaseToken && processingUpdate.rowCount !== 1) {
        return {
          analysis: {
            mediaType,
            description: 'Media analysis was superseded by a newer worker.',
            detectedCategory: null,
            severityIndicators: [],
            confidence: 0,
            needsHumanReview: true,
            analysisFailed: true,
          },
          status: 'failed',
          failureReason: 'Media job lease was lost before processing started.',
        };
      }
    } catch (err: any) {
      if (jobLeaseToken) {
        logger.error(`[MEDIA_SERVICE] Could not validate lease for media ${mediaId} (${err?.name || 'Error'}).`);
        return {
          analysis: {
            mediaType,
            description: 'Media analysis could not be started.',
            detectedCategory: null,
            severityIndicators: [],
            confidence: 0,
            needsHumanReview: true,
            analysisFailed: true,
          },
          status: 'failed',
          failureReason: 'Media job lease could not be validated.',
        };
      }
      logger.warn(`[MEDIA_SERVICE] Could not update processing status to 'processing': ${err.message}`);
    }
  }

  let analysisResult: MediaAnalysisResult;

  try {
    // Step 2: Run multimodal analysis
    analysisResult = await analyzeMedia(buffer, mimeType);

    const analysisDurationMs = Date.now() - startTime;

    // A fallback result means the AI pipeline itself failed (Gemini down,
    // malformed output, no API key). Persist 'failed' so the record is
    // retryable and the citizen sees a visible failure instead of an empty
    // description. A valid low-confidence result is NOT a failure.
    const aiFailed = analysisResult.analysisFailed === true;
    const finalStatus: 'completed' | 'failed' = aiFailed ? 'failed' : 'completed';

    // Store analysis fields while leaving a leased job in processing. The job
    // finalizer is the only code that may move a leased row to a terminal state.
    if (pool && jobLeaseToken) {
      const analysisUpdate = await pool.query(
        `UPDATE complaint_media
         SET extracted_description = $1,
             detected_category = $2,
             confidence_score = $3,
             needs_human_review = $4,
             error_message = $5
         WHERE id = $6 AND lease_token = $7 AND lease_until > NOW()
           AND processing_status = 'processing'`,
        [
          analysisResult.description,
          analysisResult.detectedCategory,
          analysisResult.confidence,
          analysisResult.needsHumanReview,
          aiFailed
            ? safeMediaError(analysisResult.failureReason || 'AI analysis could not be completed. Retry to re-run analysis.')
            : null,
          mediaId,
          jobLeaseToken,
        ]
      );
      if (analysisUpdate.rowCount !== 1) {
        return {
          analysis: analysisResult,
          status: 'failed',
          failureReason: 'Media job lease was lost before analysis results could be saved.',
        };
      }
    } else if (pool) {
      try {
        if (aiFailed) {
          const persisted = await pool.query(
            `UPDATE complaint_media 
             SET processing_status = 'failed',
                 extracted_description = $1,
                 detected_category = $2,
                 confidence_score = $3,
                 needs_human_review = $4,
                 processed_at = NOW(),
                 error_message = $6
             WHERE id = $5${jobLeaseToken ? ' AND lease_token = $7' : ''}`,
            [
              analysisResult.description,
              analysisResult.detectedCategory,
              analysisResult.confidence,
              analysisResult.needsHumanReview,
              mediaId,
              safeMediaError(analysisResult.failureReason || 'AI analysis could not be completed. Retry to re-run analysis.'),
              ...(jobLeaseToken ? [jobLeaseToken] : []),
            ]
          );
          if (jobLeaseToken && persisted.rowCount === 0) {
            return {
              analysis: analysisResult,
              status: 'failed',
              failureReason: 'Media job lease was lost before completion.',
            };
          }
        } else {
          const persisted = await pool.query(
            `UPDATE complaint_media 
             SET processing_status = 'completed',
                 extracted_description = $1,
                 detected_category = $2,
                 confidence_score = $3,
                 needs_human_review = $4,
                 processed_at = NOW(),
                 error_message = NULL
             WHERE id = $5${jobLeaseToken ? ' AND lease_token = $6' : ''}`,
            [
              analysisResult.description,
              analysisResult.detectedCategory,
              analysisResult.confidence,
              analysisResult.needsHumanReview,
              mediaId,
              ...(jobLeaseToken ? [jobLeaseToken] : []),
            ]
          );
          if (jobLeaseToken && persisted.rowCount === 0) {
            return {
              analysis: analysisResult,
              status: 'failed',
              failureReason: 'Media job lease was lost before completion.',
            };
          }
        }
      } catch (dbErr: any) {
        logger.error(`[MEDIA_SERVICE] Failed to update complaint_media ${mediaId}: ${dbErr.message}`);
      }
    }

    // Step 4: Integrate with hybrid clustering
    // Combine extracted description with the citizen's complaint text, then re-cluster
    // (skipped when the AI failed — there is no real description to enrich with)
    if (pool && analysisResult.description && !aiFailed) {
      try {
        const complaintRes = await pool.query(
          'SELECT text, category, idempotency_key FROM complaint WHERE id = $1',
          [complaintId]
        );

        if (complaintRes.rows.length > 0) {
          const currentText = complaintRes.rows[0].text || '';
          // The tag is scoped to this specific media record so that:
          //   • re-running analysis for the SAME media never duplicates text, and
          //   • a SECOND attachment can still enrich the complaint once.
          const tag =
            mediaId > 0
              ? `[Media Evidence Analysis (${mediaType} #${mediaId})]:`
              : `[Media Evidence Analysis (${mediaType})]:`;

          // Idempotency: avoid repeatedly appending if already present
          if (!currentText.includes(tag)) {
            const combinedText = `${currentText}\n\n${tag} ${analysisResult.description}`;
            await pool.query(
              'UPDATE complaint SET text = $1 WHERE id = $2',
              [combinedText, complaintId]
            );

            logger.info(
              `[MEDIA_SERVICE] Appended AI media analysis to Complaint ${complaintId}. Re-triggering hybrid clustering.`
            );

            // Re-run hybrid clustering using the updated complaint text
            await clusterComplaint(complaintId);
          } else {
            logger.debug(
              `[MEDIA_SERVICE] Media description already present in Complaint ${complaintId} text. Skipping text update.`
            );
          }
        }
      } catch (clusterErr: any) {
        logger.error(`[MEDIA_SERVICE] Failed to re-cluster complaint ${complaintId} after media analysis: ${clusterErr.message}`);
      }
    }

    // Step 5: Log successful agent step (or a failed one when the AI fell back)
    await run.log({
      stepName: 'multimodal_evidence_analysis',
      status: aiFailed ? 'failed' : 'success',
      ...(aiFailed
        ? { errorMessage: 'AI analysis could not be completed.' }
        : {}),
      modelUsed: process.env.MEDIA_ANALYSIS_MODEL || 'gemini-2.0-flash',
      durationMs: analysisDurationMs,
      inputData: {
        complaintId,
        mediaId,
        mediaType,
        mimeType,
        fileSizeBytes: buffer.length,
      },
      outputData: {
        description: analysisResult.description,
        detectedCategory: analysisResult.detectedCategory,
        confidence: analysisResult.confidence,
        needsHumanReview: analysisResult.needsHumanReview,
        severityIndicators: analysisResult.severityIndicators,
      },
    });

    const { failureReason, ...publicAnalysis } = analysisResult;
    return {
      analysis: publicAnalysis as MediaAnalysisResult,
      status: finalStatus,
      failureReason: aiFailed ? failureReason || analysisResult.description : undefined,
    };
  } catch (err: any) {
    const errorDurationMs = Date.now() - startTime;
    const safeError = safeMediaError(err);
    logger.error(`[MEDIA_SERVICE] Media processing pipeline failed for media ${mediaId} (${err?.name || 'Error'}).`);

    if (pool && !jobLeaseToken) {
      try {
        await pool.query(
          `UPDATE complaint_media 
           SET processing_status = 'failed',
               error_message = $1,
               processed_at = NOW()
           WHERE id = $2${jobLeaseToken ? ' AND lease_token = $3' : ''}`,
          jobLeaseToken ? [safeError, mediaId, jobLeaseToken] : [safeError, mediaId]
        );
      } catch {
        // Ignore secondary DB error
      }
    }

    await run.log({
      stepName: 'multimodal_evidence_analysis',
      status: 'failed',
      durationMs: errorDurationMs,
      errorMessage: err.message,
      inputData: {
        complaintId,
        mediaId,
        mediaType,
      },
    });

    // Return safe fallback (persisted status is 'failed')
    return {
      analysis: {
        mediaType,
        description: 'Media analysis could not be completed.',
        detectedCategory: null,
        severityIndicators: [],
        confidence: 0,
        needsHumanReview: true,
        analysisFailed: true,
      },
      status: 'failed',
      failureReason: safeError,
    };
  }
}

/**
 * Durable media-analysis job contract.
 *
 * The `complaint_media` row itself is the durable job record: status is moved
 * pending → processing → completed/failed atomically. QStash is only the
 * delivery mechanism; a duplicate delivery is skipped because the atomic claim
 * finds the row already processing/completed.
 */
export interface MediaAnalysisJobInput {
  mediaId: number;
  complaintId: number;
  storageKey: string;
  mimeType: string;
  triggeredBy?: string;
  jobId?: string;
}

export interface MediaAnalysisJobResult {
  status: 'pending' | 'processing' | 'completed' | 'failed' | 'skipped' | 'missing';
  analysis?: MediaAnalysisResult;
  queued?: boolean;
  skipped?: boolean;
  error?: string;
  retryAt?: string | null;
  attemptCount?: number;
  manualIntervention?: boolean;
  leaseLost?: boolean;
  finalizationPending?: boolean;
}

interface ClaimedMediaJob {
  id: number;
  complaint_id: number;
  storage_key: string;
  mime_type: string;
  attempt_count: number;
  lease_token: string;
}

function retryDateForAttempt(attemptCount: number): Date | null {
  if (attemptCount >= MAX_MEDIA_ANALYSIS_ATTEMPTS) return null;
  return new Date(Date.now() + getMediaRetryDelaySeconds(attemptCount) * 1000);
}

async function finalizeMediaJob(
  row: ClaimedMediaJob,
  status: 'completed' | 'failed',
  error: string | null,
  permanentFailure = false
): Promise<MediaAnalysisJobResult> {
  const exhausted = status === 'failed' && row.attempt_count >= MAX_MEDIA_ANALYSIS_ATTEMPTS;
  const manualIntervention = status === 'failed' && (permanentFailure || exhausted);
  const retryAt = status === 'failed' && !manualIntervention
    ? retryDateForAttempt(row.attempt_count)
    : null;

  try {
    const finalized = await pool!.query(
      `UPDATE complaint_media
       SET processing_status = $1,
           error_message = $2,
           processed_at = NOW(),
           next_retry_at = $3,
           manual_intervention = $4,
           lease_token = NULL,
           lease_until = NULL,
           failure_history = failure_history || jsonb_build_array(
             jsonb_build_object(
               'attempt', $5,
               'at', NOW(),
               'status', $1,
               'error', $2,
               'retryAt', $3,
               'manualIntervention', $4
             )
           )
       WHERE id = $6 AND lease_token = $7 AND lease_until > NOW()
         AND processing_status = 'processing'`,
      [status, error, retryAt, manualIntervention, row.attempt_count, row.id, row.lease_token]
    );
    if (finalized.rowCount !== 1) {
      logger.warn(`[MEDIA_SERVICE] Media job ${row.id} finalization skipped because its lease is no longer valid.`);
      return {
        status: 'skipped',
        skipped: true,
        leaseLost: true,
        error: 'media_job_lease_lost',
        attemptCount: row.attempt_count,
      };
    }
  } catch (err: any) {
    // If finalization fails, an expired lease remains a durable recovery path.
    logger.error(`[MEDIA_SERVICE] Could not finalize media job ${row.id} (${err?.name || 'Error'}).`);
    try {
      await pool!.query(
        `UPDATE complaint_media
         SET error_message = COALESCE($1, 'Media analysis finished but finalization must be retried.')
         WHERE id = $2 AND lease_token = $3 AND lease_until > NOW()
           AND processing_status = 'processing'`,
        [error, row.id, row.lease_token]
      );
    } catch {
      // The lease still expires and the next recovery sweep remains authoritative.
    }
    return {
      status: 'processing',
      skipped: true,
      finalizationPending: true,
      error: 'media_job_finalization_pending',
      attemptCount: row.attempt_count,
    };
  }

  return {
    status,
    error: error || undefined,
    retryAt: retryAt?.toISOString() || null,
    attemptCount: row.attempt_count,
    manualIntervention,
  };
}

async function executeClaimedMediaJob(
  row: ClaimedMediaJob,
  input: MediaAnalysisJobInput
): Promise<MediaAnalysisJobResult> {
  const storage = getStorageProvider();
  try {
    if (!(await storage.exists(row.storage_key))) {
      const message = 'Stored media file is missing; re-upload required.';
      return finalizeMediaJob(row, 'failed', message, true);
    }

    const buffer = await storage.get(row.storage_key);
    const outcome = await processMediaAnalysis(
      row.complaint_id,
      row.id,
      buffer,
      row.mime_type || input.mimeType,
      input.triggeredBy || 'system',
      row.lease_token
    );
    const error = outcome.status === 'failed'
      ? outcome.failureReason || outcome.analysis.failureReason || outcome.analysis.description
      : null;
    const safeError = error ? safeMediaError(error) : null;
    const permanent = Boolean(safeError && isPermanentMediaFailure(safeError));
    const result = await finalizeMediaJob(row, outcome.status, safeError, permanent);
    return { ...result, analysis: outcome.analysis };
  } catch (err: any) {
    const message = safeMediaError(err);
    logger.error(`[MEDIA_SERVICE] Media analysis job failed for media ${row.id} (${err?.name || 'Error'}).`);
    const permanent =
      [400, 404, 410].includes(Number(err?.statusCode)) || isPermanentMediaFailure(message);
    return finalizeMediaJob(row, 'failed', message, permanent);
  }
}

async function claimMediaJob(
  mediaId: number,
  leaseToken: string
): Promise<ClaimedMediaJob | null> {
  const claimed = await pool!.query(
    `UPDATE complaint_media
     SET processing_status = 'processing',
         failure_history = CASE WHEN processing_status IN ('failed', 'processing') AND error_message IS NOT NULL
           THEN failure_history || jsonb_build_array(jsonb_build_object(
             'attempt', attempt_count, 'at', NOW(), 'status', 'retry_claimed', 'error', error_message
           ))
           ELSE failure_history END,
         attempt_count = attempt_count + 1,
         next_retry_at = NULL,
         lease_token = $2,
         lease_until = NOW() + ($3 * INTERVAL '1 second'),
         error_message = NULL
     WHERE id = $1 AND attempt_count < $4 AND (
       processing_status = 'pending'
       OR (processing_status = 'failed' AND manual_intervention = FALSE
           AND (lease_until IS NULL OR lease_until <= NOW())
           AND (next_retry_at IS NULL OR next_retry_at <= NOW()))
       OR (processing_status = 'processing' AND lease_until <= NOW())
     )
     RETURNING id, complaint_id, storage_key, mime_type, attempt_count, lease_token`,
    [mediaId, leaseToken, MEDIA_JOB_LEASE_SECONDS, MAX_MEDIA_ANALYSIS_ATTEMPTS]
  );
  return claimed.rows[0] || null;
}

/** Claims a job atomically; completed or actively leased jobs are never rerun. */
export async function runMediaAnalysisJob(
  input: MediaAnalysisJobInput
): Promise<MediaAnalysisJobResult> {
  if (!pool) {
    const err: any = new Error('Database service is unavailable.');
    err.statusCode = 503;
    throw err;
  }

  const leaseToken = randomUUID();
  const claimed = await claimMediaJob(input.mediaId, leaseToken);
  if (claimed) return executeClaimedMediaJob(claimed, input);

  const exhausted = await pool.query(
    `UPDATE complaint_media
     SET manual_intervention = TRUE,
         next_retry_at = NULL,
         lease_token = NULL,
         lease_until = NULL,
         error_message = COALESCE(error_message, 'Maximum media-analysis attempts exhausted.'),
         failure_history = failure_history || jsonb_build_array(
           jsonb_build_object('at', NOW(), 'status', 'manual_intervention', 'reason', 'attempt_limit')
         )
     WHERE id = $1 AND manual_intervention = FALSE AND attempt_count >= $2
       AND ((processing_status = 'failed' AND (lease_until IS NULL OR lease_until <= NOW())) OR
            (processing_status = 'processing' AND lease_until <= NOW()))
     RETURNING id`,
    [input.mediaId, MAX_MEDIA_ANALYSIS_ATTEMPTS]
  );
  if (exhausted.rows.length) {
    return { status: 'failed', skipped: true, manualIntervention: true, error: 'attempt_limit' };
  }

  const existing = await pool.query(
    `SELECT processing_status, error_message, next_retry_at, attempt_count, manual_intervention
     FROM complaint_media WHERE id = $1`,
    [input.mediaId]
  );
  if (!existing.rows.length) return { status: 'missing', error: 'media_not_found' };
  const row = existing.rows[0];
  return {
    status: row.processing_status as MediaAnalysisJobResult['status'],
    skipped: true,
    error: row.error_message || undefined,
    retryAt: row.next_retry_at ? new Date(row.next_retry_at).toISOString() : null,
    attemptCount: Number(row.attempt_count),
    manualIntervention: row.manual_intervention === true,
  };
}

/**
 * Dispatches a media-analysis job.
 *
 * - QStash configured → publish and return `pending` (durable delivery).
 * - Otherwise → run inline (never fire-and-forget with setImmediate).
 *
 * If QStash publishing itself fails, the job falls back to inline execution;
 * the DB row is already `pending`, so the recovery sweep can retry it later.
 */
export async function dispatchMediaAnalysisJob(
  input: MediaAnalysisJobInput
): Promise<MediaAnalysisJobResult> {
  if (isQStashConfigured()) {
    const destination = getMediaJobUrl();
    if (destination) {
      try {
        const { messageId } = await publishQStashJob(destination, {
          mediaId: input.mediaId,
          complaintId: input.complaintId,
          storageKey: input.storageKey,
          mimeType: input.mimeType,
          triggeredBy: input.triggeredBy || 'system',
          jobId: input.jobId || `${input.mediaId}-${Date.now()}`,
        });
        logger.info(
          `[MEDIA_SERVICE] Media analysis job queued via QStash for media ${input.mediaId} (messageId=${messageId || 'unknown'})`
        );
        return { status: 'pending', queued: true };
      } catch (err: any) {
        logger.error(
          `[MEDIA_SERVICE] QStash publish failed for media ${input.mediaId}; falling back to inline processing: ${err.message}`
        );
      }
    }
  } else {
    logger.warn(
      `[MEDIA_SERVICE] QStash is not configured; processing media ${input.mediaId} inline. ` +
        'Configure QSTASH_TOKEN + signing keys + PUBLIC_BASE_URL for durable background jobs.'
    );
  }

  return runMediaAnalysisJob(input);
}

/**
 * Recovery sweep for media records that could otherwise remain pending or
 * stuck in `processing` forever after a serverless invocation was frozen or
 * killed. Callable from a protected internal endpoint / Vercel Cron.
 */
export async function recoverStaleMediaJobs(
  limit = 10,
  pendingAgeSeconds = 300
): Promise<{ scanned: number; recovered: number; skipped: number; failed: number; exhausted: number }> {
  if (!pool) {
    const err: any = new Error('Database service is unavailable.');
    err.statusCode = 503;
    throw err;
  }

  const pendingCutoff = new Date(Date.now() - pendingAgeSeconds * 1000);
  const exhausted = await pool.query(
    `UPDATE complaint_media
     SET manual_intervention = TRUE,
         next_retry_at = NULL,
         lease_token = NULL,
         lease_until = NULL,
         error_message = COALESCE(error_message, 'Maximum media-analysis attempts exhausted.'),
         failure_history = failure_history || jsonb_build_array(
           jsonb_build_object('at', NOW(), 'status', 'manual_intervention', 'reason', 'attempt_limit')
         )
     WHERE manual_intervention = FALSE AND attempt_count >= $1 AND (
       (processing_status = 'failed' AND (lease_until IS NULL OR lease_until <= NOW())) OR
       (processing_status = 'processing' AND lease_until <= NOW())
     )
     RETURNING id`,
    [MAX_MEDIA_ANALYSIS_ATTEMPTS]
  );

  // Claim and finish one job at a time so each lease starts immediately before
  // processing instead of expiring while later jobs wait in an in-memory batch.
  const summary = {
    scanned: 0,
    recovered: 0,
    skipped: 0,
    failed: 0,
    exhausted: exhausted.rows.length,
  };

  for (let index = 0; index < limit; index++) {
    const leaseToken = randomUUID();
    const claimed = await pool.query(
      `WITH candidates AS (
       SELECT id
       FROM complaint_media
       WHERE attempt_count < $1 AND (
         (processing_status = 'pending' AND created_at <= $2)
         OR (processing_status = 'failed' AND manual_intervention = FALSE
             AND (lease_until IS NULL OR lease_until <= NOW())
             AND (next_retry_at IS NULL OR next_retry_at <= NOW()))
         OR (processing_status = 'processing' AND lease_until <= NOW())
       )
       ORDER BY COALESCE(next_retry_at, created_at), id
       FOR UPDATE SKIP LOCKED
       LIMIT 1
     )
     UPDATE complaint_media AS media
     SET processing_status = 'processing',
         failure_history = CASE WHEN media.processing_status IN ('failed', 'processing') AND media.error_message IS NOT NULL
           THEN media.failure_history || jsonb_build_array(jsonb_build_object(
             'attempt', media.attempt_count, 'at', NOW(), 'status', 'retry_claimed', 'error', media.error_message
           ))
           ELSE media.failure_history END,
         attempt_count = media.attempt_count + 1,
         next_retry_at = NULL,
         lease_token = $3,
         lease_until = NOW() + ($4 * INTERVAL '1 second'),
         error_message = NULL
     FROM candidates
     WHERE media.id = candidates.id
     RETURNING media.id, media.complaint_id, media.storage_key, media.mime_type,
               media.attempt_count, media.lease_token`,
      [MAX_MEDIA_ANALYSIS_ATTEMPTS, pendingCutoff, leaseToken, MEDIA_JOB_LEASE_SECONDS]
    );
    const row = claimed.rows[0] as ClaimedMediaJob | undefined;
    if (!row) break;
    summary.scanned++;
    const outcome = await executeClaimedMediaJob(row, {
      mediaId: row.id,
      complaintId: row.complaint_id,
      storageKey: row.storage_key,
      mimeType: row.mime_type,
      triggeredBy: 'recovery',
    });
    if (outcome.status === 'completed') summary.recovered++;
    else if (outcome.manualIntervention) summary.exhausted++;
    else if (outcome.status === 'failed') summary.failed++;
    else summary.skipped++;
  }

  return summary;
}


/**
 * Finds an existing complaint_media row for the same complaint that already
 * stores byte-identical content (same filename + size, verified by reading the
 * stored file). Used to make attach idempotent — retries and double-submits
 * never create duplicate media records.
 */
async function findExistingEquivalentMedia(
  complaintId: number,
  safeFilename: string,
  buffer: Buffer,
  storage: ReturnType<typeof getStorageProvider>
): Promise<{ id: number; storageKey: string; processingStatus: string } | null> {
  if (!pool) return null;
  try {
    const res = await pool.query(
      `SELECT id, storage_key, processing_status
       FROM complaint_media
       WHERE complaint_id = $1 AND original_filename = $2 AND file_size = $3
       ORDER BY id ASC
       LIMIT 5`,
      [complaintId, safeFilename, buffer.length]
    );

    for (const row of res.rows) {
      try {
        if (!(await storage.exists(row.storage_key))) {
          // Row exists but file is missing — reuse the row and rewrite the file
          return { id: row.id, storageKey: row.storage_key, processingStatus: row.processing_status };
        }
        const existing = await storage.get(row.storage_key);
        if (existing.equals(buffer)) {
          return { id: row.id, storageKey: row.storage_key, processingStatus: row.processing_status };
        }
      } catch {
        // Ignore per-row storage errors and keep checking
      }
    }
  } catch (err: any) {
    logger.warn(`[MEDIA_SERVICE] Duplicate media lookup failed: ${err.message}`);
  }
  return null;
}

/**
 * Handles uploading a media file, storing it, inserting the DB record,
 * and kicking off analysis (sync or async).
 *
 * Idempotency: if an equivalent file is already attached to this complaint the
 * existing record is reused (no duplicate rows). A record that is already
 * `completed` is returned as-is so AI analysis and complaint-text enrichment
 * are never executed twice for the same media.
 */
export async function attachMediaToComplaint(
  input: AttachMediaInput
): Promise<AttachMediaResult> {
  const {
    complaintId,
    buffer,
    mimeType,
    originalFilename,
    triggeredBy = 'system',
    runAnalysisSync = true,
  } = input;

  // 1. Validate file content and mime type
  const validation = validateMediaUpload(buffer, mimeType, originalFilename);
  if (!validation.valid || !validation.mediaType || !validation.sanitizedExt) {
    const validationError: any = new Error(validation.error || 'Invalid media upload');
    validationError.statusCode = 400;
    throw validationError;
  }

  const { mediaType, sanitizedExt } = validation;
  const safeFilename = sanitizeFilename(originalFilename);

  // 1b. Enforce the video duration limit (ffprobe). Throws
  //     VideoDurationLimitError (HTTP 400) when the clip is too long.
  if (mediaType === 'video') {
    await enforceVideoDurationLimit(buffer, mimeType);
  }

  const storage = getStorageProvider();

  // 2. Idempotency: reuse an equivalent existing record instead of duplicating
  const existing = await findExistingEquivalentMedia(
    complaintId,
    safeFilename,
    buffer,
    storage
  );

  let storageKey: string;
  let mediaId: number;

  if (existing) {
    storageKey = existing.storageKey;
    mediaId = existing.id;
    logger.info(
      `[MEDIA_SERVICE] Equivalent media already attached to Complaint ${complaintId} ` +
        `(media ${mediaId}) — reusing record, no duplicate created.`
    );

    // Overwrite the stored bytes (keeps a single file per record)
    await storage.put(storageKey, buffer, mimeType);

    // Already analyzed successfully → never re-analyze (prevents duplicate
    // enrichment and duplicate AI spend). Return the existing record as-is.
    if (existing.processingStatus === 'completed') {
      const serveUrl = await storage.getServeUrl(storageKey);
      return {
        mediaId,
        storageKey,
        mediaType,
        processingStatus: 'completed',
        serveUrl,
      };
    }

    // Previous attempt did not complete → reset for re-analysis
    if (pool) {
      try {
        await pool.query(
          `UPDATE complaint_media
           SET mime_type = $1, file_size = $2, processing_status = 'pending',
               error_message = NULL, processed_at = NULL
           WHERE id = $3`,
          [mimeType, buffer.length, mediaId]
        );
      } catch (dbErr: any) {
        logger.warn(`[MEDIA_SERVICE] Could not reset media row ${mediaId}: ${dbErr.message}`);
      }
    }
  } else {
    // 3. Generate unique storage key and write to storage provider
    storageKey = generateStorageKey(complaintId, sanitizedExt);
    await storage.put(storageKey, buffer, mimeType);

    // 4. Insert record in complaint_media table
    mediaId = 0;
    if (pool) {
      try {
        const insertRes = await pool.query(
          `INSERT INTO complaint_media 
             (complaint_id, media_type, storage_key, original_filename, mime_type, file_size, processing_status)
           VALUES ($1, $2, $3, $4, $5, $6, 'pending')
           RETURNING id`,
          [complaintId, mediaType, storageKey, safeFilename, mimeType, buffer.length]
        );
        mediaId = insertRes.rows[0]?.id || 0;
      } catch (dbErr: any) {
        logger.warn(`[MEDIA_SERVICE] Failed to insert complaint_media row (schema may not be migrated): ${dbErr.message}`);
      }
    }
  }

  const serveUrl = await storage.getServeUrl(storageKey);

  // 5. Run multimodal analysis
  if (runAnalysisSync) {
    const outcome = mediaId > 0
      ? await runMediaAnalysisJob({ mediaId, complaintId, storageKey, mimeType, triggeredBy })
      : await processMediaAnalysis(complaintId, mediaId, buffer, mimeType, triggeredBy);

    return {
      mediaId,
      storageKey,
      mediaType,
      processingStatus: outcome.status === 'completed'
        ? 'completed'
        : outcome.status === 'failed'
        ? 'failed'
        : outcome.status === 'processing'
        ? 'processing'
        : 'pending',
      serveUrl,
      analysis: outcome.analysis,
    };
  } else {
    // Durable dispatch when QStash is configured; otherwise run inline.
    const dispatch = await dispatchMediaAnalysisJob({
      mediaId,
      complaintId,
      storageKey,
      mimeType,
      triggeredBy,
    });

    return {
      mediaId,
      storageKey,
      mediaType,
      processingStatus:
        dispatch.status === 'completed'
          ? 'completed'
          : dispatch.status === 'failed'
          ? 'failed'
          : 'pending',
      serveUrl,
      analysis: dispatch.analysis,
    };
  }
}

/**
 * Retries AI analysis for an existing media record without creating a new
 * record or re-uploading the file. Used by POST /api/complaints/:id/media/:mediaId/retry.
 *
 * Guarantees:
 *   • No duplicate complaint_media rows.
 *   • No duplicate complaint-text enrichment (tag guard is media-scoped).
 *   • The complaint itself is never modified or deleted on failure.
 */
export async function retryMediaAnalysis(
  complaintId: number,
  mediaId: number,
  triggeredBy = 'system',
  runAnalysisSync = true
): Promise<AttachMediaResult> {
  if (!pool) {
    const err: any = new Error('Database service is unavailable.');
    err.statusCode = 503;
    throw err;
  }

  const rowRes = await pool.query(
    `SELECT id, media_type, storage_key, mime_type, processing_status, error_message
     FROM complaint_media
     WHERE id = $1 AND complaint_id = $2`,
    [mediaId, complaintId]
  );

  if (rowRes.rows.length === 0) {
    const err: any = new Error(`Media attachment ${mediaId} not found for this complaint.`);
    err.statusCode = 404;
    throw err;
  }

  const row = rowRes.rows[0];

  if (row.processing_status === 'completed') {
    const err: any = new Error('This attachment has already been analyzed successfully.');
    err.statusCode = 409;
    throw err;
  }

  const storage = getStorageProvider();
  if (!(await storage.exists(row.storage_key))) {
    const err: any = new Error(
      'The stored file for this attachment is missing. Please upload the evidence again.'
    );
    err.statusCode = 410;
    throw err;
  }

  const serveUrl = await storage.getServeUrl(row.storage_key);

  // A manual retry explicitly starts a new bounded retry lifecycle while
  // preserving the prior attempt history. Never reset a live worker's lease.
  const reset = await pool.query(
    `UPDATE complaint_media
     SET processing_status = 'pending',
         attempt_count = 0,
         next_retry_at = NULL,
         lease_token = NULL,
         lease_until = NULL,
         manual_intervention = FALSE,
         error_message = NULL,
         processed_at = NULL,
         failure_history = failure_history || jsonb_build_array(
           jsonb_build_object('at', NOW(), 'status', 'manual_retry', 'triggeredBy', $2)
         )
     WHERE id = $1 AND processing_status IN ('failed', 'pending')
       AND (lease_until IS NULL OR lease_until <= NOW())
     RETURNING id`,
    [mediaId, triggeredBy]
  );
  if (!reset.rows.length) {
    const err: any = new Error('This media job is already being processed or cannot be retried.');
    err.statusCode = 409;
    throw err;
  }

  if (runAnalysisSync) {
    const outcome = await runMediaAnalysisJob({
      mediaId,
      complaintId,
      storageKey: row.storage_key,
      mimeType: row.mime_type,
      triggeredBy,
    });

    return {
      mediaId,
      storageKey: row.storage_key,
      mediaType: row.media_type,
      processingStatus: outcome.status === 'completed'
        ? 'completed'
        : outcome.status === 'failed'
        ? 'failed'
        : outcome.status === 'processing'
        ? 'processing'
        : 'pending',
      serveUrl,
      analysis: outcome.analysis,
    };
  }

  const dispatch = await dispatchMediaAnalysisJob({
    mediaId,
    complaintId,
    storageKey: row.storage_key,
    mimeType: row.mime_type,
    triggeredBy,
  });

  return {
    mediaId,
    storageKey: row.storage_key,
    mediaType: row.media_type,
    processingStatus:
      dispatch.status === 'completed'
        ? 'completed'
        : dispatch.status === 'failed'
        ? 'failed'
        : 'pending',
    serveUrl,
    analysis: dispatch.analysis,
  };
}

/**
 * Retrieves all media items attached to a complaint.
 */
export async function getMediaForComplaint(complaintId: number): Promise<any[]> {
  if (!pool) return [];

  try {
    const res = await pool.query(
      `SELECT id, complaint_id, media_type, storage_key, original_filename,
              mime_type, file_size, processing_status, extracted_description,
              detected_category, confidence_score, created_at, processed_at,
              error_message, needs_human_review, attempt_count, next_retry_at,
              manual_intervention
       FROM complaint_media
       WHERE complaint_id = $1
       ORDER BY created_at ASC`,
      [complaintId]
    );

    const storage = getStorageProvider();

    return await Promise.all(
      res.rows.map(async (row) => ({
        id: row.id,
        complaintId: row.complaint_id,
        mediaType: row.media_type,
        storageKey: row.storage_key,
        originalFilename: row.original_filename,
        mimeType: row.mime_type,
        fileSize: row.file_size,
        processingStatus: row.processing_status,
        extractedDescription: row.extracted_description,
        detectedCategory: row.detected_category,
        confidenceScore: row.confidence_score ? parseFloat(row.confidence_score) : null,
        needsHumanReview: row.needs_human_review,
        createdAt: row.created_at,
        processedAt: row.processed_at,
        errorMessage: row.error_message,
        retryCount: Number(row.attempt_count || 0),
        nextRetryAt: row.next_retry_at,
        manualInterventionRequired: row.manual_intervention === true,
        serveUrl: await storage.getServeUrl(row.storage_key),
      }))
    );
  } catch (err: any) {
    logger.warn(`[MEDIA_SERVICE] Error querying complaint_media: ${err.message}`);
    return [];
  }
}
