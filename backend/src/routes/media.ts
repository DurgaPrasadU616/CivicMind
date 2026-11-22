// backend/src/routes/media.ts
//
// Phase 3 — Media Upload, Analysis, and Retrieval API Routes
//
// Endpoints:
//   POST /api/complaints/:id/media  — Authenticated media upload attached to complaint
//   GET  /api/complaints/:id/media  — List media attachments for a complaint
//   POST /api/media/analyze         — Pre-submission media analysis (for citizen portal)
//   GET  /api/media/:key(*)         — Authenticated private file serving

import { Router, Request, Response } from 'express';
import multer from 'multer';
import { pool } from '../config/db';
import { authenticateToken, optionalAuth } from '../middleware/auth';
import { getStorageProvider } from '../services/storage';
import {
  attachMediaToComplaint,
  retryMediaAnalysis,
  getMediaForComplaint,
  confirmDirectMediaUpload,
} from '../services/complaintMediaService';
import {
  analyzeMedia,
  MAX_VIDEO_SIZE_BYTES,
} from '../services/mediaAnalysis';
import {
  validateMediaUpload,
  validatePresignUploadParams,
  generateStorageKey,
  sanitizeFilename,
} from '../utils/fileValidation';
import { enforceVideoDurationLimit, VideoDurationLimitError } from '../utils/videoFrames';
import logger from '../utils/logger';
import { randomUUID } from 'crypto';
import {
  UploadTicketError,
  registerPresignedTicket,
  claimPresignedTicket,
  confirmPresignedTicket,
  releasePresignedTicket,
  getPresignedTicket,
  _resetPresignedTickets,
} from '../services/uploadTicketStore';
import type { PresignedUploadTicket } from '../services/uploadTicketStore';

const router = Router();

// Re-export the persistent ticket API for backwards compatibility with
// existing tests and callers.
export {
  UploadTicketError,
  registerPresignedTicket,
  claimPresignedTicket,
  confirmPresignedTicket,
  releasePresignedTicket,
  getPresignedTicket,
  _resetPresignedTickets,
};
export type { PresignedUploadTicket };
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: MAX_VIDEO_SIZE_BYTES, // 50 MB upper bound
    files: 1,
  },
});

/**
 * Access check for complaint media (attach, list, retry, file serving).
 * The complaint owner (meta_data.userId, stamped server-side on submission)
 * and staff roles (admin/govt/ngo) may attach, list, retry and read media.
 * Complaints without a recorded owner (legacy rows) stay accessible to any
 * authenticated user.
 */
function canAccessComplaint(
  metaData: any,
  user?: { id: number; role: string }
): boolean {
  if (!user) return false;
  if (['admin', 'govt', 'ngo'].includes(user.role)) return true;
  const owner = metaData?.userId;
  if (owner === undefined || owner === null) return true;
  return owner === user.id;
}

/**
 * Helper to handle multer upload errors (e.g. file size exceeded) gracefully.
 */
function handleMulterError(err: any, res: Response): boolean {
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      res.status(400).json({
        error: 'File size exceeds the allowed limit.',
      });
      return true;
    }
    res.status(400).json({ error: `Upload error: ${err.message}` });
    return true;
  }
  if (err) {
    res.status(400).json({ error: err.message || 'File upload error' });
    return true;
  }
  return false;
}

// ── 1. POST /api/complaints/:id/media ─────────────────────────────────────────

/**
 * @openapi
 * /complaints/{id}/media:
 *   post:
 *     summary: Attach a media file (image, audio, video) to an existing complaint
 *     security:
 *       - bearerAuth: []
 */
router.post(
  '/complaints/:id/media',
  authenticateToken,
  (req, res, next) => {
    upload.single('file')(req, res, (err) => {
      if (handleMulterError(err, res)) return;
      next();
    });
  },
  async (req: Request, res: Response) => {
    try {
      const rawId = req.params.id;
      const complaintId = parseInt(rawId.replace(/^CM-/, ''), 10);

      if (isNaN(complaintId) || complaintId <= 0) {
        return res.status(400).json({ error: 'Invalid complaint ID.' });
      }

      if (!req.file || !req.file.buffer) {
        return res.status(400).json({ error: 'No media file provided in "file" field.' });
      }

      if (!pool) {
        return res.status(503).json({ error: 'Database service is unavailable.' });
      }

      // Check complaint existence and verify permissions
      const complaintRes = await pool.query(
        'SELECT id, meta_data FROM complaint WHERE id = $1',
        [complaintId]
      );

      if (complaintRes.rows.length === 0) {
        return res.status(404).json({ error: `Complaint with ID ${complaintId} not found.` });
      }

      const complaint = complaintRes.rows[0];

      // Ownership enforcement (see canAccessComplaint)
      if (!canAccessComplaint(complaint.meta_data, req.user)) {
        return res.status(403).json({
          error: 'You do not have permission to attach media to this complaint.',
        });
      }

      // Validate MIME type and magic bytes before storage
      const validation = validateMediaUpload(
        req.file.buffer,
        req.file.mimetype,
        req.file.originalname
      );

      if (!validation.valid) {
        return res.status(400).json({ error: validation.error });
      }

      const syncParam = req.query.sync === 'true' || req.query.sync === undefined;

      const result = await attachMediaToComplaint({
        complaintId,
        buffer: req.file.buffer,
        mimeType: req.file.mimetype,
        originalFilename: req.file.originalname || 'upload',
        triggeredBy: req.user ? `user:${req.user.id}` : 'system',
        runAnalysisSync: syncParam,
      });

      return res.status(201).json({
        message: 'Media attached and analyzed successfully.',
        data: result,
      });
    } catch (error: any) {
      // Validation / lifecycle errors carry an explicit HTTP status code
      if (error instanceof VideoDurationLimitError || typeof error?.statusCode === 'number') {
        return res.status(error.statusCode || 400).json({ error: error.message });
      }
      logger.error('[MEDIA_ROUTE] Error attaching media to complaint:', error);
      return res.status(500).json({
        error: error.message || 'An error occurred while attaching media.',
      });
    }
  }
);

// ── 1b. POST /api/complaints/:id/media/:mediaId/retry ────────────────────────

/**
 * @openapi
 * /complaints/{id}/media/{mediaId}/retry:
 *   post:
 *     summary: Retry AI analysis for a failed media attachment (no new record)
 *     security:
 *       - bearerAuth: []
 */
router.post(
  '/complaints/:id/media/:mediaId/retry',
  authenticateToken,
  async (req: Request, res: Response) => {
    try {
      const complaintId = parseInt(String(req.params.id).replace(/^CM-/, ''), 10);
      const mediaId = parseInt(String(req.params.mediaId), 10);

      if (isNaN(complaintId) || complaintId <= 0) {
        return res.status(400).json({ error: 'Invalid complaint ID.' });
      }
      if (isNaN(mediaId) || mediaId <= 0) {
        return res.status(400).json({ error: 'Invalid media ID.' });
      }

      if (!pool) {
        return res.status(503).json({ error: 'Database service is unavailable.' });
      }

      const complaintRes = await pool.query(
        'SELECT id, meta_data FROM complaint WHERE id = $1',
        [complaintId]
      );
      if (complaintRes.rows.length === 0) {
        return res.status(404).json({ error: `Complaint with ID ${complaintId} not found.` });
      }

      if (!canAccessComplaint(complaintRes.rows[0].meta_data, req.user)) {
        return res.status(403).json({
          error: 'You do not have permission to modify media for this complaint.',
        });
      }

      const syncParam = req.query.sync === 'true' || req.query.sync === undefined;

      const result = await retryMediaAnalysis(
        complaintId,
        mediaId,
        req.user ? `user:${req.user.id}` : 'system',
        syncParam
      );

      return res.status(200).json({
        message: 'Media analysis retry completed.',
        data: result,
      });
    } catch (error: any) {
      if (typeof error?.statusCode === 'number') {
        return res.status(error.statusCode).json({ error: error.message });
      }
      logger.error('[MEDIA_ROUTE] Error retrying media analysis:', error);
      return res.status(500).json({ error: 'Failed to retry media analysis.' });
    }
  }
);

// ── 2. POST /api/complaints/:id/media/presign ─────────────────────────────────

/**
 * @openapi
 * /complaints/{id}/media/presign:
 *   post:
 *     summary: Generate a presigned direct-to-storage upload URL (bypassing Express)
 *     security:
 *       - bearerAuth: []
 */
router.post(
  '/complaints/:id/media/presign',
  authenticateToken,
  async (req: Request, res: Response) => {
    try {
      const rawId = req.params.id;
      const complaintId = parseInt(rawId.replace(/^CM-/, ''), 10);

      if (isNaN(complaintId) || complaintId <= 0) {
        return res.status(400).json({ error: 'Invalid complaint ID.' });
      }

      if (!pool) {
        return res.status(503).json({ error: 'Database service is unavailable.' });
      }

      // 1. Verify complaint existence and ownership
      const complaintRes = await pool.query(
        'SELECT id, meta_data FROM complaint WHERE id = $1',
        [complaintId]
      );

      if (complaintRes.rows.length === 0) {
        return res.status(404).json({ error: `Complaint with ID ${complaintId} not found.` });
      }

      const complaint = complaintRes.rows[0];

      if (!canAccessComplaint(complaint.meta_data, req.user)) {
        return res.status(403).json({
          error: 'You do not have permission to attach media to this complaint.',
        });
      }

      // 2. Validate request parameters: mimeType, fileSize, filename
      const { mimeType, fileSizeBytes, filename } = req.body;

      const validation = validatePresignUploadParams(mimeType, Number(fileSizeBytes));
      if (!validation.valid || !validation.sanitizedExt) {
        return res.status(400).json({ error: validation.error });
      }

      const safeFilename = sanitizeFilename(filename || 'upload');
      // Use staging key prefix to prevent overwriting finalized objects
      const storageKey = `staging/${generateStorageKey(complaintId, validation.sanitizedExt)}`;
      const storage = getStorageProvider();

      if (!storage.getPresignedUploadUrl) {
        return res.status(501).json({
          error: 'Direct presigned uploads are not supported by the active storage provider.',
        });
      }

      const ttlSeconds = 300; // 5 minutes window
      const uploadUrl = await storage.getPresignedUploadUrl(
        storageKey,
        mimeType,
        Number(fileSizeBytes),
        ttlSeconds
      );

      // Register the ticket in shared persistence (Redis/Upstash)
      const userId = req.user?.id || 0;
      await registerPresignedTicket(storageKey, {
        complaintId,
        userId,
        storageKey,
        mimeType,
        fileSizeBytes: Number(fileSizeBytes),
        expiresAt: Date.now() + ttlSeconds * 1000,
        status: 'issued',
      });

      return res.status(200).json({
        uploadUrl,
        storageKey,
        originalFilename: safeFilename,
        mimeType,
        fileSizeBytes: Number(fileSizeBytes),
        expiresInSeconds: ttlSeconds,
      });
    } catch (error: any) {
      if (typeof error?.statusCode === 'number') {
        return res.status(error.statusCode).json({ error: error.message });
      }
      logger.error('[MEDIA_ROUTE] Error generating presigned upload URL:', error);
      return res.status(500).json({ error: 'Failed to generate presigned upload URL.' });
    }
  }
);

// ── 3. POST /api/complaints/:id/media/confirm ─────────────────────────────────

/**
 * @openapi
 * /complaints/{id}/media/confirm:
 *   post:
 *     summary: Confirm direct upload completion, verify object in storage, and run analysis
 *     security:
 *       - bearerAuth: []
 */
router.post(
  '/complaints/:id/media/confirm',
  authenticateToken,
  async (req: Request, res: Response) => {
    try {
      const rawId = req.params.id;
      const complaintId = parseInt(rawId.replace(/^CM-/, ''), 10);

      if (isNaN(complaintId) || complaintId <= 0) {
        return res.status(400).json({ error: 'Invalid complaint ID.' });
      }

      if (!pool) {
        return res.status(503).json({ error: 'Database service is unavailable.' });
      }

      // 1. Verify complaint existence and ownership
      const complaintRes = await pool.query(
        'SELECT id, meta_data FROM complaint WHERE id = $1',
        [complaintId]
      );

      if (complaintRes.rows.length === 0) {
        return res.status(404).json({ error: `Complaint with ID ${complaintId} not found.` });
      }

      const complaint = complaintRes.rows[0];

      if (!canAccessComplaint(complaint.meta_data, req.user)) {
        return res.status(403).json({
          error: 'You do not have permission to attach media to this complaint.',
        });
      }

      const { storageKey, originalFilename, mimeType } = req.body;

      if (!storageKey || typeof storageKey !== 'string') {
        return res.status(400).json({ error: 'storageKey is required.' });
      }

      if (!mimeType || typeof mimeType !== 'string') {
        return res.status(400).json({ error: 'mimeType is required.' });
      }

      // Atomically claim the one-time upload ticket. A claim can be released
      // if confirmation fails before the media row is persisted, allowing a
      // safe retry. Duplicate confirmations after success are idempotent.
      const userId = req.user?.id || 0;
      let ticket: PresignedUploadTicket | null = null;
      let claimId: string | null = null;
      let ticketAlreadyConfirmed = false;

      if (storageKey.startsWith('staging/')) {
        claimId = randomUUID();
        const claimResult = await claimPresignedTicket(
          storageKey,
          complaintId,
          userId,
          claimId
        );
        ticket = await getPresignedTicket(storageKey);
        ticketAlreadyConfirmed = claimResult === 'confirmed';

        if (!ticket && !ticketAlreadyConfirmed) {
          throw new UploadTicketError(
            'Upload ticket has expired. Please request a new upload URL.',
            410,
            'expired'
          );
        }

      }

      const syncParam = req.query.sync === 'true' || req.query.sync === undefined;

      try {
        if (
          ticket &&
          (ticket.storageKey !== storageKey || ticket.mimeType !== mimeType)
        ) {
          throw new UploadTicketError(
            'Upload confirmation does not match the issued ticket.',
            400,
            'ticket_mismatch'
          );
        }

        const result = await confirmDirectMediaUpload({
          complaintId,
          storageKey,
          originalFilename: originalFilename || 'upload',
          mimeType: ticket?.mimeType || mimeType,
          expectedFileSizeBytes: ticket?.fileSizeBytes,
          triggeredBy: req.user ? `user:${req.user.id}` : 'system',
          runAnalysisSync: syncParam,
        });

        if (claimId && !ticketAlreadyConfirmed) {
          await confirmPresignedTicket(storageKey, claimId).catch((err) =>
            logger.warn('[MEDIA_ROUTE] Could not mark upload ticket confirmed:', err?.message || err)
          );
        }

        return res.status(201).json({
          message: 'Media upload confirmed and analyzed successfully.',
          data: result,
        });
      } catch (confirmError: any) {
        // Release the claim so a transient failure (DB/network) can be retried.
        if (claimId && !ticketAlreadyConfirmed) {
          await releasePresignedTicket(storageKey, claimId).catch((err) =>
            logger.warn('[MEDIA_ROUTE] Could not release upload ticket claim:', err?.message || err)
          );
        }
        throw confirmError;
      }
    } catch (error: any) {
      if (typeof error?.statusCode === 'number') {
        return res.status(error.statusCode).json({ error: error.message });
      }
      logger.error('[MEDIA_ROUTE] Error confirming direct media upload:', error);
      return res.status(500).json({ error: 'Failed to confirm media upload.' });
    }
  }
);

// ── 4. GET /api/complaints/:id/media ──────────────────────────────────────────

/**
 * @openapi
 * /complaints/{id}/media:
 *   get:
 *     summary: Get all media attachments for a complaint
 */
router.get('/complaints/:id/media', authenticateToken, async (req: Request, res: Response) => {
  try {
    const rawId = req.params.id;
    const complaintId = parseInt(rawId.replace(/^CM-/, ''), 10);

      if (isNaN(complaintId) || complaintId <= 0) {
        return res.status(400).json({ error: 'Invalid complaint ID.' });
      }

      if (!pool) {
        return res.status(503).json({ error: 'Database service is unavailable.' });
      }

      // Same access rule as attach/retry/serve: owner or staff only
      const complaintRes = await pool.query('SELECT id, meta_data FROM complaint WHERE id = $1', [
        complaintId,
      ]);
      if (complaintRes.rows.length === 0) {
        return res.status(404).json({ error: `Complaint with ID ${complaintId} not found.` });
      }
      if (!canAccessComplaint(complaintRes.rows[0].meta_data, req.user)) {
        return res.status(403).json({
          error: 'You do not have permission to view media for this complaint.',
        });
      }

      const mediaList = await getMediaForComplaint(complaintId);

    return res.status(200).json({
      data: mediaList,
      meta: { count: mediaList.length },
    });
  } catch (error: any) {
    logger.error('[MEDIA_ROUTE] Error fetching media for complaint:', error);
    return res.status(500).json({ error: 'Failed to retrieve media attachments.' });
  }
});

// ── 3. POST /api/media/analyze ────────────────────────────────────────────────

/**
 * @openapi
 * /media/analyze:
 *   post:
 *     summary: Pre-submission media analysis (for citizen portal file preview and AI description)
 */
router.post(
  '/media/analyze',
  optionalAuth,
  (req, res, next) => {
    upload.single('file')(req, res, (err) => {
      if (handleMulterError(err, res)) return;
      next();
    });
  },
  async (req: Request, res: Response) => {
    try {
      if (!req.file || !req.file.buffer) {
        return res.status(400).json({ error: 'No media file provided in "file" field.' });
      }

      const validation = validateMediaUpload(
        req.file.buffer,
        req.file.mimetype,
        req.file.originalname
      );

      if (!validation.valid) {
        return res.status(400).json({ error: validation.error });
      }

      // Enforce video duration limit before spending an AI call
      if (validation.mediaType === 'video') {
        try {
          await enforceVideoDurationLimit(req.file.buffer, req.file.mimetype);
        } catch (durationErr: any) {
          if (durationErr instanceof VideoDurationLimitError) {
            return res.status(400).json({ error: durationErr.message });
          }
          throw durationErr;
        }
      }

      // Execute multimodal analysis
      const analysis = await analyzeMedia(req.file.buffer, req.file.mimetype);

      return res.status(200).json({
        message: 'Media analyzed successfully.',
        data: {
          mediaType: validation.mediaType,
          originalFilename: sanitizeFilename(req.file.originalname),
          fileSize: req.file.buffer.length,
          mimeType: req.file.mimetype,
          analysis,
        },
      });
    } catch (error: any) {
      logger.error('[MEDIA_ROUTE] Error in pre-submission media analysis:', error);
      return res.status(500).json({
        error: error.message || 'Media analysis failed.',
      });
    }
  }
);

// ── 4. GET /api/media/:key(*) ─────────────────────────────────────────────────

/**
 * Authenticated media retrieval endpoint.
 * Streams private media files from the storage provider.
 */
router.get('/media/:key(*)', authenticateToken, async (req: Request, res: Response) => {
  try {
    const rawKey = req.params.key;
    if (!rawKey) {
      return res.status(400).json({ error: 'Storage key required.' });
    }

    const decodedKey = decodeURIComponent(rawKey);

    // Ownership check: keys are namespaced as `complaints/<complaintId>/...`
    const keyParts = decodedKey.split('/');
    if (keyParts[0] === 'complaints' && keyParts[1]) {
      const keyComplaintId = parseInt(keyParts[1], 10);
      if (!isNaN(keyComplaintId) && pool) {
        const complaintRes = await pool.query(
          'SELECT meta_data FROM complaint WHERE id = $1',
          [keyComplaintId]
        );
        if (complaintRes.rows.length === 0) {
          return res.status(404).json({ error: 'File not found in storage.' });
        }
        if (!canAccessComplaint(complaintRes.rows[0].meta_data, req.user)) {
          return res.status(403).json({
            error: 'You do not have permission to access this file.',
          });
        }
      }
    }

    const storage = getStorageProvider();

    let exists: boolean;
    try {
      exists = await storage.exists(decodedKey);
    } catch (pathErr: any) {
      // LocalStorageProvider throws on path-traversal attempts
      if (String(pathErr?.message || '').includes('Path traversal')) {
        return res.status(400).json({ error: 'Invalid storage key.' });
      }
      throw pathErr;
    }
    if (!exists) {
      return res.status(404).json({ error: 'File not found in storage.' });
    }

    const buffer = await storage.get(decodedKey);

    // Simple extension-to-mime map for serving
    const ext = decodedKey.split('.').pop()?.toLowerCase();
    const mimeMap: Record<string, string> = {
      jpg: 'image/jpeg',
      jpeg: 'image/jpeg',
      png: 'image/png',
      webp: 'image/webp',
      gif: 'image/gif',
      mp3: 'audio/mpeg',
      wav: 'audio/wav',
      ogg: 'audio/ogg',
      m4a: 'audio/mp4',
      weba: 'audio/webm',
      mp4: 'video/mp4',
      webm: 'video/webm',
      mov: 'video/quicktime',
    };

    const contentType = ext ? mimeMap[ext] || 'application/octet-stream' : 'application/octet-stream';
    res.setHeader('Content-Type', contentType);
    res.setHeader('Cache-Control', 'private, max-age=3600');
    return res.send(buffer);
  } catch (error: any) {
    logger.error('[MEDIA_ROUTE] Error serving media file:', error);
    return res.status(500).json({ error: 'Failed to retrieve media file.' });
  }
});

export default router;
