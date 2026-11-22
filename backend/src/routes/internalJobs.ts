// backend/src/routes/internalJobs.ts
//
// Phase 2B.3 — Internal durable-job endpoints.
//
//   POST /api/internal/jobs/media-analysis  — QStash webhook (signed)
//   GET|POST /api/internal/jobs/media-recover — recovery sweep (CRON_SECRET)
//
// These endpoints are not part of the public citizen API. The media-analysis
// webhook only accepts requests carrying a valid Upstash-Signature JWT.

import { Router, Request, Response } from 'express';
import {
  runMediaAnalysisJob,
  recoverStaleMediaJobs,
} from '../services/complaintMediaService';
import {
  isCronAuthorized,
  isQStashConfigured,
  verifyQStashSignature,
} from '../services/qstash';
import logger from '../utils/logger';

const router = Router();

function getRawBody(req: Request): Buffer | null {
  const raw = (req as any).rawBody;
  if (Buffer.isBuffer(raw)) return raw;
  if (typeof raw === 'string') return Buffer.from(raw);
  return null;
}

router.post(
  '/api/internal/jobs/media-analysis',
  async (req: Request, res: Response) => {
    if (!isQStashConfigured()) {
      return res.status(503).json({ error: 'QStash is not configured on this deployment.' });
    }

    const signature = req.header('upstash-signature') || '';
    const rawBody = getRawBody(req);
    if (!rawBody || !verifyQStashSignature(signature, rawBody)) {
      logger.warn('[INTERNAL_JOBS] Rejected media-analysis job with invalid QStash signature');
      return res.status(401).json({ error: 'Invalid QStash signature.' });
    }

    const { mediaId, complaintId, storageKey, mimeType, triggeredBy, jobId } = req.body || {};
    if (
      !Number.isFinite(Number(mediaId)) ||
      !Number.isFinite(Number(complaintId)) ||
      typeof storageKey !== 'string' ||
      typeof mimeType !== 'string'
    ) {
      return res.status(400).json({ error: 'Invalid media-analysis job payload.' });
    }

    try {
      const result = await runMediaAnalysisJob({
        mediaId: Number(mediaId),
        complaintId: Number(complaintId),
        storageKey,
        mimeType,
        triggeredBy: typeof triggeredBy === 'string' ? triggeredBy : 'qstash',
        jobId: typeof jobId === 'string' ? jobId : undefined,
      });

      if (result.status === 'failed') {
        // A new retryable failure gets 5xx so QStash can redeliver. Once a
        // retry is delayed or permanently exhausted, acknowledge it; the DB
        // retry schedule or manual-intervention state is now authoritative.
        if (result.skipped || result.manualIntervention) {
          return res.status(200).json({
            ok: true,
            status: result.status,
            skipped: true,
            retryAt: result.retryAt,
            manualIntervention: result.manualIntervention === true,
          });
        }
        logger.warn(
          `[INTERNAL_JOBS] Media ${mediaId} analysis failed (attempt=${result.attemptCount || 'unknown'}); QStash retry requested.`
        );
        return res.status(500).json({
          error: 'Media analysis failed.',
          status: result.status,
          retryable: true,
        });
      }

      return res.status(200).json({
        ok: true,
        status: result.status,
        skipped: result.skipped === true,
      });
    } catch (err: any) {
      logger.error(`[INTERNAL_JOBS] Media-analysis job crashed (${err?.name || 'Error'}).`);
      return res.status(500).json({ error: 'Media analysis job failed.', retryable: true });
    }
  }
);

async function handleRecovery(req: Request, res: Response) {
  if (!isCronAuthorized(req)) {
    return res.status(401).json({ error: 'Unauthorized recovery request.' });
  }

  const requestedLimit = Number(req.query.limit);
  const limit = Number.isFinite(requestedLimit)
    ? Math.min(Math.max(Math.trunc(requestedLimit), 1), 50)
    : 10;

  try {
    const summary = await recoverStaleMediaJobs(limit);
    logger.info(`[INTERNAL_JOBS] Media recovery sweep completed: ${JSON.stringify(summary)}`);
    return res.status(200).json({ ok: true, ...summary });
  } catch (err: any) {
    logger.error(`[INTERNAL_JOBS] Media recovery sweep failed (${err?.name || 'Error'}).`);
    return res.status(500).json({ error: 'Media recovery sweep failed.' });
  }
}

router.get('/api/internal/jobs/media-recover', handleRecovery);
router.post('/api/internal/jobs/media-recover', handleRecovery);

export default router;
