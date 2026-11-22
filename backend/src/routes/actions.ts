// backend/src/routes/actions.ts
//
// Phase 5 — Civic Action & Resolution Intelligence API Routes
//
// All routes require authenticateToken.
// RBAC restrictions documented per-endpoint.
//
// Endpoints:
//   POST   /api/actions                                        — create (govt/admin/ngo)
//   GET    /api/actions                                        — list with filters (govt/admin/ngo)
//   GET    /api/actions/analytics                              — performance analytics (govt/admin)
//   GET    /api/actions/my-complaints/:complaintId/progress    — citizen progress (authenticated)
//   GET    /api/actions/:id                                    — full dossier (govt/admin/ngo)
//   POST   /api/actions/:id/approve                            — approve (govt/admin)
//   POST   /api/actions/:id/assign                             — assign dept/officer (govt/admin)
//   PATCH  /api/actions/:id/status                             — update status (govt/admin/ngo)
//   POST   /api/actions/:id/evidence                           — upload evidence (govt/admin)
//   POST   /api/actions/:id/verify-resolution                  — human verification (govt/admin)
//   POST   /api/actions/:id/reopen                             — reopen (govt/admin)

import { Router, Request, Response } from 'express';
import multer from 'multer';
import { z } from 'zod';
import { authenticateToken, requireRole } from '../middleware/auth';
import { createAction, getActionById, listActions, approveAction, updateActionStatus, cancelAction } from '../services/actions/actionService';
import { assignAction, getActionAssignments, updateAssignment } from '../services/actions/assignmentService';
import { getSlaConfig, getSlaMetrics, calculateDeadline } from '../services/actions/slaService';
import { uploadResolutionEvidence, runAIEvidenceComparison, verifyResolution, reopenAction } from '../services/actions/resolutionVerification';
import { getDepartmentAnalytics, getCategoryWiseResolution, getDepartmentWorkload } from '../services/actions/performanceAnalytics';
import { sendNotification } from '../services/actions/actionNotificationService';
import {
  CreateActionInputSchema,
  AssignActionInputSchema,
  UpdateStatusInputSchema,
  VerifyResolutionInputSchema,
} from '../services/actions/types';
import logger from '../utils/logger';
import { pool } from '../config/db';

const router = Router();

// Multer for evidence upload — images only, 10 MB cap
const evidenceUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024, files: 1 },
});

// ── Helper ────────────────────────────────────────────────────────────────────

function parseId(raw: string): number {
  const id = parseInt(raw, 10);
  if (isNaN(id) || id <= 0) throw new Error('Invalid ID');
  return id;
}

// ── 1. POST /api/actions — Create action ──────────────────────────────────────

router.post(
  '/actions',
  authenticateToken,
  requireRole('govt', 'admin', 'ngo'),
  async (req: Request, res: Response) => {
    try {
      const parsed = CreateActionInputSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({
          error: 'Validation failed',
          details: parsed.error.errors.map((e) => ({ path: e.path.join('.'), message: e.message })),
        });
      }

      const action = await createAction(parsed.data, req.user!.id);
      return res.status(201).json({ message: 'Action created', data: action });
    } catch (err: any) {
      logger.error('[ACTIONS_ROUTE] Create error:', err);
      return res.status(err.message.includes('already exists') ? 409 : 500).json({ error: err.message });
    }
  }
);

// ── 2. GET /api/actions — List with filters ───────────────────────────────────

router.get(
  '/actions',
  authenticateToken,
  requireRole('govt', 'admin', 'ngo'),
  async (req: Request, res: Response) => {
    try {
      const { status, priority, departmentId, clusterId, limit, offset } = req.query;
      const result = await listActions({
        status:       typeof status === 'string' ? status : undefined,
        priority:     typeof priority === 'string' ? priority : undefined,
        departmentId: typeof departmentId === 'string' ? departmentId : undefined,
        clusterId:    clusterId ? parseInt(String(clusterId), 10) : undefined,
        limit:        limit ? parseInt(String(limit), 10) : 50,
        offset:       offset ? parseInt(String(offset), 10) : 0,
      });
      return res.status(200).json({ data: result.data, meta: { total: result.total } });
    } catch (err: any) {
      logger.error('[ACTIONS_ROUTE] List error:', err);
      return res.status(500).json({ error: 'Failed to list actions' });
    }
  }
);

// ── 3. GET /api/actions/analytics — Department analytics ──────────────────────
// NOTE: Must be defined BEFORE /:id to avoid "analytics" being matched as an id

router.get(
  '/actions/analytics',
  authenticateToken,
  requireRole('govt', 'admin'),
  async (req: Request, res: Response) => {
    try {
      const { startDate, endDate, departmentId } = req.query;
      const filters = {
        startDate:    typeof startDate === 'string' ? startDate : undefined,
        endDate:      typeof endDate === 'string' ? endDate : undefined,
        departmentId: typeof departmentId === 'string' ? departmentId : undefined,
      };

      const [deptAnalytics, categoryAnalytics, workload] = await Promise.all([
        getDepartmentAnalytics(filters),
        getCategoryWiseResolution(filters),
        getDepartmentWorkload(),
      ]);

      return res.status(200).json({
        data: {
          departmentAnalytics: deptAnalytics,
          categoryAnalytics,
          workload,
        },
      });
    } catch (err: any) {
      logger.error('[ACTIONS_ROUTE] Analytics error:', err);
      return res.status(500).json({ error: 'Failed to retrieve analytics' });
    }
  }
);

// ── 4. GET /api/actions/my-complaints/:complaintId/progress — Citizen view ────

router.get(
  '/actions/my-complaints/:complaintId/progress',
  authenticateToken,
  async (req: Request, res: Response) => {
    try {
      const complaintId = parseId(req.params.complaintId);

      if (!pool) return res.status(503).json({ error: 'Database not available' });

      // Find action linked to this complaint via investigation → cluster → complaint
      const actionRes = await pool.query(
        `SELECT ca.id, ca.status, ca.priority, ca.department_name,
                ca.expected_completion_date, ca.created_at
         FROM civic_actions ca
         LEFT JOIN civic_investigations ci ON ca.investigation_id = ci.id
         LEFT JOIN cluster cl ON ca.cluster_id = cl.id
         LEFT JOIN complaint c ON c.cluster_id = cl.id
         WHERE c.id = $1
           AND ca.status NOT IN ('rejected', 'cancelled')
         ORDER BY ca.created_at DESC
         LIMIT 1`,
        [complaintId]
      );

      if (actionRes.rows.length === 0) {
        return res.status(200).json({
          data: {
            complaintId,
            actionId:           null,
            currentStatus:      'no_action',
            priority:           null,
            departmentName:     null,
            expectedCompletion: null,
            statusHistory:      [],
            canReopen:          false,
          },
        });
      }

      const a = actionRes.rows[0];

      // Status history — public-safe fields only (no officer names, no internal metadata)
      const histRes = await pool.query(
        `SELECT new_status, created_at, change_reason
         FROM action_status_history
         WHERE action_id = $1
         ORDER BY created_at ASC`,
        [a.id]
      );

      const statusHistory = histRes.rows.map((h) => ({
        status:    h.new_status,
        changedAt: h.created_at,
        note:      h.change_reason && !h.change_reason.toLowerCase().includes('internal')
          ? h.change_reason
          : null,
      }));

      return res.status(200).json({
        data: {
          complaintId,
          actionId:           a.id,
          currentStatus:      a.status,
          priority:           a.priority,
          departmentName:     a.department_name,   // only public dept name, no officer details
          expectedCompletion: a.expected_completion_date,
          statusHistory,
          canReopen:          ['resolved'].includes(a.status),
        },
      });
    } catch (err: any) {
      logger.error('[ACTIONS_ROUTE] Citizen progress error:', err);
      if (err.message === 'Invalid ID') return res.status(400).json({ error: err.message });
      return res.status(500).json({ error: 'Failed to retrieve progress' });
    }
  }
);

// ── 5. GET /api/actions/:id — Full dossier ────────────────────────────────────

router.get(
  '/actions/:id',
  authenticateToken,
  requireRole('govt', 'admin', 'ngo'),
  async (req: Request, res: Response) => {
    try {
      const id = parseId(req.params.id);
      const dossier = await getActionById(id);
      const slaMetrics = getSlaMetrics(dossier.action);
      return res.status(200).json({ data: { ...dossier, slaMetrics } });
    } catch (err: any) {
      logger.error('[ACTIONS_ROUTE] Get dossier error:', err);
      if (err.message === 'Invalid ID') return res.status(400).json({ error: err.message });
      if (err.message.includes('not found')) return res.status(404).json({ error: err.message });
      return res.status(500).json({ error: err.message });
    }
  }
);

// ── 6. POST /api/actions/:id/approve ─────────────────────────────────────────

router.post(
  '/actions/:id/approve',
  authenticateToken,
  requireRole('govt', 'admin'),
  async (req: Request, res: Response) => {
    try {
      const id = parseId(req.params.id);
      const action = await approveAction(id, req.user!.id);

      await sendNotification(id, 'assignment_notification', req.user!.id);

      return res.status(200).json({ message: `Action #${id} approved`, data: action });
    } catch (err: any) {
      logger.error('[ACTIONS_ROUTE] Approve error:', err);
      if (err.message.includes('not found')) return res.status(404).json({ error: err.message });
      return res.status(400).json({ error: err.message });
    }
  }
);

// ── 7. POST /api/actions/:id/assign ──────────────────────────────────────────

router.post(
  '/actions/:id/assign',
  authenticateToken,
  requireRole('govt', 'admin'),
  async (req: Request, res: Response) => {
    try {
      const id = parseId(req.params.id);
      const parsed = AssignActionInputSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({
          error: 'Validation failed',
          details: parsed.error.errors.map((e) => ({ path: e.path.join('.'), message: e.message })),
        });
      }

      const assignment = await assignAction(id, parsed.data, req.user!.id);

      // If expectedCompletionDate not provided, compute from SLA
      if (!parsed.data.expectedCompletionDate) {
        const sla = await getSlaConfig({
          departmentId: parsed.data.departmentId,
          priority:     parsed.data.priority,
        });
        if (sla) {
          const deadline = calculateDeadline(new Date(), sla.resolution_hours);
          if (pool) {
            await pool.query(
              'UPDATE civic_actions SET expected_completion_date = $1 WHERE id = $2',
              [deadline, id]
            );
          }
        }
      }

      await sendNotification(id, 'assignment_notification', assignment.officer_id);

      return res.status(200).json({ message: `Action #${id} assigned`, data: assignment });
    } catch (err: any) {
      logger.error('[ACTIONS_ROUTE] Assign error:', err);
      return res.status(400).json({ error: err.message });
    }
  }
);

// ── 8. PATCH /api/actions/:id/status ─────────────────────────────────────────

router.patch(
  '/actions/:id/status',
  authenticateToken,
  requireRole('govt', 'admin', 'ngo'),
  async (req: Request, res: Response) => {
    try {
      const id = parseId(req.params.id);
      const parsed = UpdateStatusInputSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({
          error: 'Validation failed',
          details: parsed.error.errors.map((e) => ({ path: e.path.join('.'), message: e.message })),
        });
      }

      const action = await updateActionStatus(
        id,
        parsed.data.newStatus,
        req.user!.id,
        parsed.data.changeReason,
        parsed.data.metadata
      );
      return res.status(200).json({ message: `Status updated to "${parsed.data.newStatus}"`, data: action });
    } catch (err: any) {
      logger.error('[ACTIONS_ROUTE] Status update error:', err);
      if (err.message.includes('Invalid transition')) return res.status(409).json({ error: err.message });
      return res.status(400).json({ error: err.message });
    }
  }
);

// ── 9. POST /api/actions/:id/evidence ─────────────────────────────────────────

router.post(
  '/actions/:id/evidence',
  authenticateToken,
  requireRole('govt', 'admin'),
  (req: Request, res: Response, next) => {
    evidenceUpload.single('file')(req, res, (err) => {
      if (err instanceof multer.MulterError) {
        return res.status(400).json({ error: err.message });
      }
      if (err) return res.status(400).json({ error: err.message || 'Upload error' });
      next();
    });
  },
  async (req: Request, res: Response) => {
    try {
      const id = parseId(req.params.id);

      if (!req.file) {
        return res.status(400).json({ error: 'No file uploaded' });
      }

      const evidenceTypeRaw = req.body.evidenceType || req.body.evidence_type;
      const EvidenceTypeSchema = z.enum(['before', 'after', 'progress', 'completion_report']);
      const typeParsed = EvidenceTypeSchema.safeParse(evidenceTypeRaw);
      if (!typeParsed.success) {
        return res.status(400).json({ error: 'evidenceType must be one of: before, after, progress, completion_report' });
      }

      const evidence = await uploadResolutionEvidence(
        id,
        {
          buffer:       req.file.buffer,
          mimetype:     req.file.mimetype,
          originalname: req.file.originalname,
          size:         req.file.size,
        },
        typeParsed.data,
        req.user!.id,
        req.body.description
      );

      return res.status(201).json({ message: 'Evidence uploaded', data: evidence });
    } catch (err: any) {
      logger.error('[ACTIONS_ROUTE] Evidence upload error:', err);
      return res.status(400).json({ error: err.message });
    }
  }
);

// ── 10. POST /api/actions/:id/verify-resolution ───────────────────────────────

router.post(
  '/actions/:id/verify-resolution',
  authenticateToken,
  requireRole('govt', 'admin'),
  async (req: Request, res: Response) => {
    try {
      const id = parseId(req.params.id);
      const parsed = VerifyResolutionInputSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({
          error: 'Validation failed',
          details: parsed.error.errors.map((e) => ({ path: e.path.join('.'), message: e.message })),
        });
      }

      // Run AI comparison first (non-blocking — result stored in DB for context)
      let aiComparison = null;
      try {
        aiComparison = await runAIEvidenceComparison(id);
      } catch {
        // AI failure must not block human verification
      }

      const result = await verifyResolution(id, req.user!.id, parsed.data);

      if (result.resolved) {
        await sendNotification(id, 'resolution_verified', null);
      }

      return res.status(200).json({
        message: result.resolved ? 'Action resolved' : 'Action returned to in_progress',
        data:    { ...result, aiComparison },
      });
    } catch (err: any) {
      logger.error('[ACTIONS_ROUTE] Verify resolution error:', err);
      return res.status(400).json({ error: err.message });
    }
  }
);

// ── 11. POST /api/actions/:id/reopen ─────────────────────────────────────────

router.post(
  '/actions/:id/reopen',
  authenticateToken,
  requireRole('govt', 'admin'),
  async (req: Request, res: Response) => {
    try {
      const id = parseId(req.params.id);
      const reason = z.string().min(1).max(2000).safeParse(req.body.reason);
      if (!reason.success) {
        return res.status(400).json({ error: 'reason is required (string, max 2000 chars)' });
      }

      const result = await reopenAction(id, reason.data, req.user!.id);
      await sendNotification(id, 'reopened_alert', null);

      return res.status(200).json({ message: `Action #${id} reopened`, data: result });
    } catch (err: any) {
      logger.error('[ACTIONS_ROUTE] Reopen error:', err);
      return res.status(400).json({ error: err.message });
    }
  }
);

export default router;
