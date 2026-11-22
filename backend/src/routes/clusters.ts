// backend/src/routes/clusters.ts
//
// Dedicated router for cluster lifecycle management:
//
//   PATCH /api/clusters/:id/status  — enforce state machine, write action_log
//   GET   /api/clusters/:id/history — full audit trail for a cluster, newest first
//
// State machine (only these transitions are legal):
//   open        → in_progress
//   in_progress → resolved
//   in_progress → escalated
//   escalated   → in_progress
//   resolved    → open          (manual reopen; new complaints set needs_review instead)
//
// Concurrency: PATCH uses SELECT ... FOR UPDATE to lock the cluster row before
// reading its current status, so two simultaneous requests can't silently overwrite
// each other.  The second request sees the post-commit status and validates against it.
//
// Append-only guarantee: no UPDATE or DELETE path touches action_log in this file
// or anywhere else in the codebase.

import { Router } from 'express';
import { pool } from '../config/db';
import { authenticateToken } from '../middleware/auth';
import { requirePermission } from '../middleware/rbac';
import logger from '../utils/logger';

const router = Router();

// ─── State Machine ────────────────────────────────────────────────────────────

type ClusterStatus = 'open' | 'in_progress' | 'resolved' | 'escalated';

const VALID_STATUSES: ClusterStatus[] = ['open', 'in_progress', 'resolved', 'escalated'];

/**
 * Legal transitions map.
 * Key: current status. Value: set of statuses it may transition TO.
 */
const ALLOWED_TRANSITIONS: Record<ClusterStatus, ClusterStatus[]> = {
  open:        ['in_progress'],
  in_progress: ['resolved', 'escalated'],
  escalated:   ['in_progress'],
  resolved:    ['open'],
};

/**
 * Returns a human-readable reason why a transition is rejected,
 * to surface in 400 responses.
 */
const transitionRejectionReason = (from: ClusterStatus, to: ClusterStatus): string => {
  const allowed = ALLOWED_TRANSITIONS[from];
  if (from === to) {
    return `Cluster is already in status "${from}". No change needed.`;
  }
  if (from === 'open' && to === 'resolved') {
    return `Cannot jump directly from "open" to "resolved". Set status to "in_progress" first to acknowledge the issue, then resolve it.`;
  }
  if (from === 'open' && to === 'escalated') {
    return `Cannot escalate an "open" cluster directly. Set it to "in_progress" first.`;
  }
  if (from === 'resolved' && (to === 'in_progress' || to === 'escalated')) {
    return `A "resolved" cluster can only be reopened to "open". Use "open" → "in_progress" to resume work.`;
  }
  return `Transition from "${from}" to "${to}" is not permitted. From "${from}", allowed transitions are: ${allowed.join(', ')}.`;
};

// ─── PATCH /api/clusters/:id/status ──────────────────────────────────────────
// Govt / NGO / Admin only.
// Body: { newStatus: ClusterStatus, note?: string }
// Returns: { cluster, logEntry }

router.patch(
  '/clusters/:id/status',
  authenticateToken,
  requirePermission('update:status'),
  async (req, res) => {
    if (!pool) {
      return res.status(503).json({ error: 'Database service is unavailable.' });
    }

    const rawClusterId = req.params.id;
    const { newStatus, note } = req.body;

    // ── Validate newStatus is a known value ──
    if (!newStatus || !VALID_STATUSES.includes(newStatus as ClusterStatus)) {
      return res.status(400).json({
        error: `Invalid status value "${newStatus}". Must be one of: ${VALID_STATUSES.join(', ')}.`,
      });
    }

    // ── Parse cluster ID ──
    const numericClusterId = parseInt(
      rawClusterId.startsWith('CL-') ? rawClusterId.slice(3) : rawClusterId,
      10
    );
    if (isNaN(numericClusterId)) {
      return res.status(400).json({ error: 'Invalid cluster ID format. Use an integer or CL-<n>.' });
    }

    const adminId = req.user!.id;
    const targetStatus = newStatus as ClusterStatus;

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // ── 1. Lock the cluster row (prevents concurrent race conditions) ──
      //    SELECT FOR UPDATE waits until any concurrent transaction holding
      //    a lock on this row commits, then returns the up-to-date row.
      const lockResult = await client.query(
        `SELECT id, status, title, category, region, severity_score, complaint_count,
                priority_score, needs_review, recommended_action, created_at, updated_at
         FROM cluster
         WHERE id = $1
         FOR UPDATE`,
        [numericClusterId]
      );

      if (lockResult.rows.length === 0) {
        await client.query('ROLLBACK');
        return res.status(404).json({
          error: `Cluster with ID "${rawClusterId}" not found.`,
        });
      }

      const cluster = lockResult.rows[0];
      const currentStatus = cluster.status as ClusterStatus;

      // ── 2. Validate transition ──
      const allowed = ALLOWED_TRANSITIONS[currentStatus];
      if (!allowed.includes(targetStatus)) {
        await client.query('ROLLBACK');
        return res.status(400).json({
          error: transitionRejectionReason(currentStatus, targetStatus),
          currentStatus,
          requestedStatus: targetStatus,
          allowedTransitions: allowed,
        });
      }

      // ── 3a. Update cluster status ──
      //    If reopening (resolved → open), also clear needs_review.
      const needsReviewUpdate =
        targetStatus === 'open' ? ', needs_review = FALSE' : '';

      const updateResult = await client.query(
        `UPDATE cluster
         SET status = $1, updated_at = NOW()${needsReviewUpdate}
         WHERE id = $2
         RETURNING id, status, title, category, region, severity_score, complaint_count,
                   priority_score, needs_review, recommended_action, updated_at`,
        [targetStatus, numericClusterId]
      );

      const updatedCluster = updateResult.rows[0];

      // ── 3b. Insert action_log row (APPEND-ONLY — never UPDATE or DELETE) ──
      const logResult = await client.query(
        `INSERT INTO action_log
           (cluster_id, admin_id, action_taken, previous_status, new_status, note)
         VALUES ($1, $2, 'status_change', $3, $4, $5)
         RETURNING id, cluster_id, admin_id, action_taken, previous_status, new_status, note, logged_at`,
        [numericClusterId, adminId, currentStatus, targetStatus, note || null]
      );

      const logEntry = logResult.rows[0];

      await client.query('COMMIT');

      return res.status(200).json({
        message: `Cluster status updated: "${currentStatus}" → "${targetStatus}".`,
        cluster: {
          id: `CL-${updatedCluster.id}`,
          status: updatedCluster.status,
          title: updatedCluster.title,
          category: updatedCluster.category,
          region: updatedCluster.region,
          severityScore: updatedCluster.severity_score,
          priorityScore: updatedCluster.priority_score,
          complaintCount: updatedCluster.complaint_count,
          needsReview: updatedCluster.needs_review,
          updatedAt: updatedCluster.updated_at,
        },
        logEntry: {
          id: logEntry.id,
          clusterId: `CL-${logEntry.cluster_id}`,
          adminId: logEntry.admin_id,
          actionTaken: logEntry.action_taken,
          previousStatus: logEntry.previous_status,
          newStatus: logEntry.new_status,
          note: logEntry.note,
          loggedAt: logEntry.logged_at,
        },
      });
    } catch (err) {
      await client.query('ROLLBACK');
      logger.error('[CLUSTERS] Error in PATCH /clusters/:id/status:', err);
      return res.status(500).json({
        error: 'An internal server error occurred while updating cluster status.',
      });
    } finally {
      client.release();
    }
  }
);

// ─── GET /api/clusters/:id/history ───────────────────────────────────────────
// Any authenticated user who can view clusters (citizen, ngo, govt, admin).
// Returns the full action_log for the cluster, newest first.
// Admin name and role are joined in from the user table.

router.get('/clusters/:id/history', authenticateToken, async (req, res) => {
  if (!pool) {
    return res.status(503).json({ error: 'Database service is unavailable.' });
  }

  const rawClusterId = req.params.id;
  const numericClusterId = parseInt(
    rawClusterId.startsWith('CL-') ? rawClusterId.slice(3) : rawClusterId,
    10
  );

  if (isNaN(numericClusterId)) {
    return res.status(400).json({ error: 'Invalid cluster ID format. Use an integer or CL-<n>.' });
  }

  try {
    // Verify cluster exists
    const clusterCheck = await pool.query(
      'SELECT id, title, status FROM cluster WHERE id = $1',
      [numericClusterId]
    );
    if (clusterCheck.rows.length === 0) {
      return res.status(404).json({
        error: `Cluster with ID "${rawClusterId}" not found.`,
      });
    }

    // Fetch audit log with admin details joined in
    const historyRes = await pool.query(
      `SELECT
         al.id,
         al.cluster_id,
         al.action_taken,
         al.previous_status,
         al.new_status,
         al.note,
         al.logged_at,
         u.id   AS admin_id,
         u.name AS admin_name,
         u.role AS admin_role
       FROM action_log al
       JOIN "user" u ON u.id = al.admin_id
       WHERE al.cluster_id = $1
       ORDER BY al.logged_at DESC`,
      [numericClusterId]
    );

    return res.status(200).json({
      clusterId: `CL-${numericClusterId}`,
      clusterTitle: clusterCheck.rows[0].title,
      currentStatus: clusterCheck.rows[0].status,
      history: historyRes.rows.map((row) => ({
        id: row.id,
        actionTaken: row.action_taken,
        previousStatus: row.previous_status,
        newStatus: row.new_status,
        note: row.note,
        loggedAt: row.logged_at,
        admin: {
          id: row.admin_id,
          name: row.admin_name,
          role: row.admin_role,
        },
      })),
    });
  } catch (err) {
    logger.error('[CLUSTERS] Error in GET /clusters/:id/history:', err);
    return res.status(500).json({
      error: 'An internal server error occurred while retrieving cluster history.',
    });
  }
});

export default router;
