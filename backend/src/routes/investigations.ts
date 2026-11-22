// backend/src/routes/investigations.ts
//
// Phase 4 — Autonomous Civic Investigation Agent API Routes
//
// Endpoints:
//   POST /api/investigations
//   GET  /api/investigations
//   GET  /api/investigations/:id
//   POST /api/investigations/:id/run
//   POST /api/investigations/:id/retry
//   GET  /api/investigations/:id/evidence
//   GET  /api/investigations/:id/report
//   POST /api/investigations/:id/review
//   POST /api/investigations/:id/recommendations/:recId/approve
//   POST /api/investigations/:id/recommendations/:recId/reject

import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { authenticateToken, requireRole } from '../middleware/auth';
import {
  createInvestigation,
  listInvestigations,
  getInvestigationDossier,
  runInvestigationPipeline,
} from '../services/investigation/investigationService';
import {
  reviewInvestigationReport,
  updateRecommendationStatus,
} from '../services/investigation/investigationReportService';
import {
  InvestigationPriorityEnum,
  ReviewStatusEnum,
} from '../services/investigation/types';
import logger from '../utils/logger';

const router = Router();

// ── Validation Schemas ────────────────────────────────────────────────────────

const CreateInvestigationSchema = z.object({
  clusterId: z.number().int().positive({ message: 'clusterId must be a positive integer.' }),
  priority: InvestigationPriorityEnum.optional().default('medium'),
  autoRun: z.boolean().optional().default(false),
});

const ReviewReportSchema = z.object({
  reviewStatus: ReviewStatusEnum,
  reviewNotes: z.string().max(3000).optional(),
});

// ── 1. POST /api/investigations ───────────────────────────────────────────────

/**
 * @openapi
 * /investigations:
 *   post:
 *     summary: Initiate a civic investigation for a high-priority cluster
 *     security:
 *       - bearerAuth: []
 */
router.post(
  '/investigations',
  authenticateToken,
  requireRole('govt', 'admin', 'ngo'),
  async (req: Request, res: Response) => {
    try {
      const parsed = CreateInvestigationSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({
          error: 'Validation failed',
          details: parsed.error.errors.map((e) => ({ path: e.path.join('.'), message: e.message })),
        });
      }

      const { clusterId, priority, autoRun } = parsed.data;
      const createdBy = req.user?.id || null;
      const triggeredBy = req.user ? `user:${req.user.id}` : 'api';

      const investigation = await createInvestigation({
        clusterId,
        priority,
        createdBy,
        autoRun,
        triggeredBy,
      });

      return res.status(201).json({
        message: 'Investigation created successfully',
        data: investigation,
      });
    } catch (err: any) {
      logger.error('[INVESTIGATIONS_ROUTE] Error creating investigation:', err);
      return res.status(err.message.includes('not exist') ? 404 : 500).json({
        error: err.message || 'Failed to create investigation',
      });
    }
  }
);

// ── 2. GET /api/investigations ────────────────────────────────────────────────

/**
 * @openapi
 * /investigations:
 *   get:
 *     summary: List civic investigations with filtering
 *     security:
 *       - bearerAuth: []
 */
router.get(
  '/investigations',
  authenticateToken,
  requireRole('govt', 'admin', 'ngo'),
  async (req: Request, res: Response) => {
    try {
      const { status, clusterId, priority, limit, offset } = req.query;

      const filters = {
        status: typeof status === 'string' ? status : undefined,
        clusterId: clusterId ? parseInt(String(clusterId), 10) : undefined,
        priority: typeof priority === 'string' ? priority : undefined,
        limit: limit ? parseInt(String(limit), 10) : 50,
        offset: offset ? parseInt(String(offset), 10) : 0,
      };

      const result = await listInvestigations(filters);

      return res.status(200).json({
        data: result.data,
        meta: {
          total: result.total,
          limit: filters.limit,
          offset: filters.offset,
        },
      });
    } catch (err: any) {
      logger.error('[INVESTIGATIONS_ROUTE] Error listing investigations:', err);
      return res.status(500).json({ error: 'Failed to retrieve investigations' });
    }
  }
);

// ── 3. GET /api/investigations/:id ───────────────────────────────────────────

/**
 * @openapi
 * /investigations/{id}:
 *   get:
 *     summary: Get complete dossier for an investigation
 *     security:
 *       - bearerAuth: []
 */
router.get(
  '/investigations/:id',
  authenticateToken,
  requireRole('govt', 'admin', 'ngo'),
  async (req: Request, res: Response) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (isNaN(id) || id <= 0) {
        return res.status(400).json({ error: 'Invalid investigation ID' });
      }

      const dossier = await getInvestigationDossier(id);
      return res.status(200).json({ data: dossier });
    } catch (err: any) {
      logger.error(`[INVESTIGATIONS_ROUTE] Error retrieving #${req.params.id}:`, err);
      return res.status(err.message.includes('not found') ? 404 : 500).json({
        error: err.message || 'Failed to retrieve investigation',
      });
    }
  }
);

// ── 4. POST /api/investigations/:id/run ───────────────────────────────────────

/**
 * @openapi
 * /investigations/{id}/run:
 *   post:
 *     summary: Trigger the multi-step investigation pipeline
 *     security:
 *       - bearerAuth: []
 */
router.post(
  '/investigations/:id/run',
  authenticateToken,
  requireRole('govt', 'admin', 'ngo'),
  async (req: Request, res: Response) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (isNaN(id) || id <= 0) {
        return res.status(400).json({ error: 'Invalid investigation ID' });
      }

      const triggeredBy = req.user ? `user:${req.user.id}` : 'system';
      const report = await runInvestigationPipeline(id, triggeredBy);

      return res.status(200).json({
        message: 'Investigation completed successfully and is ready for review.',
        data: report,
      });
    } catch (err: any) {
      logger.error(`[INVESTIGATIONS_ROUTE] Error running pipeline for #${req.params.id}:`, err);
      const isConflict = err.message.includes('already running');
      const isNotFound = err.message.includes('not found');
      return res.status(isConflict ? 409 : isNotFound ? 404 : 500).json({
        error: err.message || 'Investigation run failed',
      });
    }
  }
);

// ── 5. POST /api/investigations/:id/retry ─────────────────────────────────────

/**
 * @openapi
 * /investigations/{id}/retry:
 *   post:
 *     summary: Retry a failed or pending investigation
 *     security:
 *       - bearerAuth: []
 */
router.post(
  '/investigations/:id/retry',
  authenticateToken,
  requireRole('govt', 'admin', 'ngo'),
  async (req: Request, res: Response) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (isNaN(id) || id <= 0) {
        return res.status(400).json({ error: 'Invalid investigation ID' });
      }

      const triggeredBy = req.user ? `user:${req.user.id}` : 'retry';
      const report = await runInvestigationPipeline(id, triggeredBy);

      return res.status(200).json({
        message: 'Investigation retried successfully.',
        data: report,
      });
    } catch (err: any) {
      logger.error(`[INVESTIGATIONS_ROUTE] Error retrying #${req.params.id}:`, err);
      return res.status(500).json({ error: err.message || 'Retry failed' });
    }
  }
);

// ── 6. GET /api/investigations/:id/evidence ───────────────────────────────────

router.get(
  '/investigations/:id/evidence',
  authenticateToken,
  requireRole('govt', 'admin', 'ngo'),
  async (req: Request, res: Response) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (isNaN(id) || id <= 0) return res.status(400).json({ error: 'Invalid ID' });

      const dossier = await getInvestigationDossier(id);
      return res.status(200).json({ data: dossier.evidence });
    } catch (err: any) {
      return res.status(500).json({ error: err.message });
    }
  }
);

// ── 7. GET /api/investigations/:id/report ─────────────────────────────────────

router.get(
  '/investigations/:id/report',
  authenticateToken,
  requireRole('govt', 'admin', 'ngo'),
  async (req: Request, res: Response) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (isNaN(id) || id <= 0) return res.status(400).json({ error: 'Invalid ID' });

      const dossier = await getInvestigationDossier(id);
      return res.status(200).json({ data: dossier.latestReport });
    } catch (err: any) {
      return res.status(500).json({ error: err.message });
    }
  }
);

// ── 8. POST /api/investigations/:id/review ───────────────────────────────────

/**
 * @openapi
 * /investigations/{id}/review:
 *   post:
 *     summary: Official review action on investigation findings (approve / reject / revision_requested)
 *     security:
 *       - bearerAuth: []
 */
router.post(
  '/investigations/:id/review',
  authenticateToken,
  requireRole('govt', 'admin', 'ngo'),
  async (req: Request, res: Response) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (isNaN(id) || id <= 0) {
        return res.status(400).json({ error: 'Invalid investigation ID' });
      }

      const parsed = ReviewReportSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({
          error: 'Validation failed',
          details: parsed.error.errors.map((e) => ({ path: e.path.join('.'), message: e.message })),
        });
      }

      const reviewerId = req.user!.id;
      const { reviewStatus, reviewNotes } = parsed.data;

      const result = await reviewInvestigationReport(id, reviewerId, reviewStatus, reviewNotes);

      return res.status(200).json({
        message: `Investigation reviewed: status updated to "${result.newStatus}".`,
        data: result,
      });
    } catch (err: any) {
      logger.error(`[INVESTIGATIONS_ROUTE] Error reviewing #${req.params.id}:`, err);
      return res.status(500).json({ error: err.message || 'Review submission failed' });
    }
  }
);

// ── 9. POST /api/investigations/:id/recommendations/:recId/approve ────────────

router.post(
  '/investigations/:id/recommendations/:recId/approve',
  authenticateToken,
  requireRole('govt', 'admin', 'ngo'),
  async (req: Request, res: Response) => {
    try {
      const investigationId = parseInt(req.params.id, 10);
      const recommendationId = parseInt(req.params.recId, 10);

      if (isNaN(investigationId) || isNaN(recommendationId)) {
        return res.status(400).json({ error: 'Invalid ID parameters' });
      }

      const actorId = req.user!.id;
      await updateRecommendationStatus(recommendationId, investigationId, actorId, 'approved');

      return res.status(200).json({
        message: `Recommendation #${recommendationId} approved successfully.`,
      });
    } catch (err: any) {
      logger.error('[INVESTIGATIONS_ROUTE] Recommendation approval error:', err);
      return res.status(500).json({ error: err.message || 'Approval failed' });
    }
  }
);

// ── 10. POST /api/investigations/:id/recommendations/:recId/reject ───────────

router.post(
  '/investigations/:id/recommendations/:recId/reject',
  authenticateToken,
  requireRole('govt', 'admin', 'ngo'),
  async (req: Request, res: Response) => {
    try {
      const investigationId = parseInt(req.params.id, 10);
      const recommendationId = parseInt(req.params.recId, 10);

      if (isNaN(investigationId) || isNaN(recommendationId)) {
        return res.status(400).json({ error: 'Invalid ID parameters' });
      }

      const actorId = req.user!.id;
      await updateRecommendationStatus(recommendationId, investigationId, actorId, 'rejected');

      return res.status(200).json({
        message: `Recommendation #${recommendationId} rejected.`,
      });
    } catch (err: any) {
      logger.error('[INVESTIGATIONS_ROUTE] Recommendation rejection error:', err);
      return res.status(500).json({ error: err.message || 'Rejection failed' });
    }
  }
);

export default router;
