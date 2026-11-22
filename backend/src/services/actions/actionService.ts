// backend/src/services/actions/actionService.ts
//
// Phase 5 — Core Civic Action CRUD & Lifecycle Service
//
// Responsibilities:
//   - createAction      — Create from approved recommendation; prevent duplicates
//   - getActionById     — Full dossier with cluster, assignment, history
//   - listActions       — Paginated with filters
//   - approveAction     — pending_approval → approved + status history
//   - updateActionStatus — State-machine validated transitions
//   - cancelAction      — Transition to cancelled from allowed states

import { pool } from '../../config/db';
import logger from '../../utils/logger';
import { startAgentRun } from '../../utils/agentLogger';
import {
  CreateActionInput,
  ActionStatus,
  CivicAction,
  ActionAssignment,
  ActionStatusHistory,
  ResolutionEvidence,
  isValidTransition,
  TERMINAL_STATUSES,
} from './types';

// ── Helpers ───────────────────────────────────────────────────────────────────

function mapRow(row: Record<string, unknown>): CivicAction {
  return row as unknown as CivicAction;
}

// ── createAction ──────────────────────────────────────────────────────────────

export async function createAction(
  input: CreateActionInput,
  createdBy: number | null
): Promise<CivicAction> {
  if (!pool) throw new Error('Database not available');

  // Prevent duplicate active actions per recommendation
  if (input.recommendationId) {
    const dup = await pool.query(
      `SELECT id FROM civic_actions
       WHERE recommendation_id = $1
         AND status NOT IN ('rejected', 'cancelled')
       LIMIT 1`,
      [input.recommendationId]
    );
    if (dup.rows.length > 0) {
      throw new Error(
        `An active action (id=${dup.rows[0].id}) already exists for recommendation #${input.recommendationId}`
      );
    }
  }

  const result = await pool.query(
    `INSERT INTO civic_actions
       (investigation_id, recommendation_id, cluster_id,
        action_title, description, department_id, department_name,
        priority, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     RETURNING *`,
    [
      input.investigationId ?? null,
      input.recommendationId ?? null,
      input.clusterId ?? null,
      input.actionTitle,
      input.description,
      input.departmentId ?? null,
      input.departmentName ?? null,
      input.priority ?? 'medium',
      createdBy,
    ]
  );

  const action = mapRow(result.rows[0]);

  // Log initial status to history
  await pool.query(
    `INSERT INTO action_status_history
       (action_id, previous_status, new_status, changed_by, change_reason)
     VALUES ($1, NULL, 'pending_approval', $2, 'Action created')`,
    [action.id, createdBy]
  );

  logger.info(`[ACTION_SERVICE] Created action #${action.id} "${action.action_title}"`);
  return action;
}

// ── getActionById ─────────────────────────────────────────────────────────────

export interface ActionDossier {
  action:      CivicAction;
  assignments: ActionAssignment[];
  history:     ActionStatusHistory[];
  evidence:    ResolutionEvidence[];
}

export async function getActionById(id: number): Promise<ActionDossier> {
  if (!pool) throw new Error('Database not available');

  const actionRes = await pool.query('SELECT * FROM civic_actions WHERE id = $1', [id]);
  if (actionRes.rows.length === 0) throw new Error(`Action #${id} not found`);

  const [assignRes, histRes, evRes] = await Promise.all([
    pool.query(
      'SELECT * FROM action_assignments WHERE action_id = $1 ORDER BY assigned_at DESC',
      [id]
    ),
    pool.query(
      'SELECT * FROM action_status_history WHERE action_id = $1 ORDER BY created_at DESC',
      [id]
    ),
    pool.query(
      'SELECT * FROM resolution_evidence WHERE action_id = $1 ORDER BY created_at ASC',
      [id]
    ),
  ]);

  return {
    action:      mapRow(actionRes.rows[0]),
    assignments: assignRes.rows as unknown as ActionAssignment[],
    history:     histRes.rows as unknown as ActionStatusHistory[],
    evidence:    evRes.rows as unknown as ResolutionEvidence[],
  };
}

// ── listActions ───────────────────────────────────────────────────────────────

export interface ListActionsFilter {
  status?:       string;
  priority?:     string;
  departmentId?: string;
  clusterId?:    number;
  limit?:        number;
  offset?:       number;
}

export async function listActions(
  filters: ListActionsFilter = {}
): Promise<{ data: CivicAction[]; total: number }> {
  if (!pool) throw new Error('Database not available');

  const { status, priority, departmentId, clusterId, limit = 50, offset = 0 } = filters;
  const conditions: string[] = [];
  const params: unknown[] = [];
  let idx = 1;

  if (status)       { conditions.push(`status = $${idx++}`);        params.push(status); }
  if (priority)     { conditions.push(`priority = $${idx++}`);      params.push(priority); }
  if (departmentId) { conditions.push(`department_id = $${idx++}`); params.push(departmentId); }
  if (clusterId)    { conditions.push(`cluster_id = $${idx++}`);    params.push(clusterId); }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  const [dataRes, countRes] = await Promise.all([
    pool.query(
      `SELECT * FROM civic_actions ${where} ORDER BY created_at DESC LIMIT $${idx} OFFSET $${idx + 1}`,
      [...params, limit, offset]
    ),
    pool.query(`SELECT COUNT(*) FROM civic_actions ${where}`, params),
  ]);

  return {
    data:  dataRes.rows.map(mapRow),
    total: parseInt(countRes.rows[0].count, 10),
  };
}

// ── approveAction ─────────────────────────────────────────────────────────────

export async function approveAction(
  id: number,
  officerId: number
): Promise<CivicAction> {
  if (!pool) throw new Error('Database not available');

  const { action } = await getActionById(id);
  if (action.status !== 'pending_approval') {
    throw new Error(
      `Cannot approve action #${id}: current status is "${action.status}" (must be "pending_approval")`
    );
  }

  const run = startAgentRun('monitoring', { triggeredBy: `user:${officerId}` });
  await run.log({ stepName: 'approve_action', status: 'running' });

  await pool.query(
    `UPDATE civic_actions
     SET status = 'approved', approved_by = $1, approved_at = NOW()
     WHERE id = $2`,
    [officerId, id]
  );

  await pool.query(
    `INSERT INTO action_status_history
       (action_id, previous_status, new_status, changed_by, change_reason)
     VALUES ($1, 'pending_approval', 'approved', $2, 'Official approval')`,
    [id, officerId]
  );

  await run.log({ stepName: 'approve_action', status: 'success', outputData: { actionId: id } });
  logger.info(`[ACTION_SERVICE] Action #${id} approved by user #${officerId}`);

  const updated = await pool.query('SELECT * FROM civic_actions WHERE id = $1', [id]);
  return mapRow(updated.rows[0]);
}

// ── updateActionStatus ────────────────────────────────────────────────────────

export async function updateActionStatus(
  id: number,
  newStatus: ActionStatus,
  changedBy: number | null,
  reason?: string,
  metadata: Record<string, unknown> = {}
): Promise<CivicAction> {
  if (!pool) throw new Error('Database not available');

  const { action } = await getActionById(id);
  const currentStatus = action.status as ActionStatus;

  if (!isValidTransition(currentStatus, newStatus)) {
    throw new Error(
      `Invalid transition: "${currentStatus}" → "${newStatus}" for action #${id}`
    );
  }

  const extraUpdates: string[] = [];
  const extraParams: unknown[] = [];

  if (newStatus === 'resolved') {
    extraUpdates.push(`actual_completion_date = NOW()`);
  }
  if (newStatus === 'overdue' && !action.overdue_since) {
    extraUpdates.push(`overdue_since = NOW()`);
  }

  const setClause = ['status = $1', ...extraUpdates].join(', ');
  const baseParams = [newStatus, id];

  await pool.query(
    `UPDATE civic_actions SET ${setClause} WHERE id = $${baseParams.length}`,
    [...baseParams, ...extraParams]
  );

  await pool.query(
    `INSERT INTO action_status_history
       (action_id, previous_status, new_status, changed_by, change_reason, metadata)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [id, currentStatus, newStatus, changedBy, reason ?? null, JSON.stringify(metadata)]
  );

  logger.info(`[ACTION_SERVICE] Action #${id}: ${currentStatus} → ${newStatus}`);

  const updated = await pool.query('SELECT * FROM civic_actions WHERE id = $1', [id]);
  return mapRow(updated.rows[0]);
}

// ── cancelAction ──────────────────────────────────────────────────────────────

export async function cancelAction(
  id: number,
  reason: string,
  cancelledBy: number | null
): Promise<CivicAction> {
  const { action } = await getActionById(id);

  if (TERMINAL_STATUSES.has(action.status as ActionStatus) || action.status === 'resolved') {
    throw new Error(
      `Action #${id} is already in a terminal state (${action.status}) and cannot be cancelled`
    );
  }

  return updateActionStatus(id, 'cancelled', cancelledBy, reason);
}
