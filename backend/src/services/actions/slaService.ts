// backend/src/services/actions/slaService.ts
//
// Phase 5 — SLA Calculation & Deadline Management
//
// Responsibilities:
//   - getSlaConfig     — Lookup SLA with progressive fallback chain
//   - calculateDeadline — Compute expected completion from assignedAt + hours
//   - getSlaMetrics    — Time elapsed/remaining, overdue status
//   - markOverdue      — Transition action to OVERDUE and log history

import { pool } from '../../config/db';
import logger from '../../utils/logger';
import { SlaConfig, SlaMetrics, CivicAction } from './types';
import { updateActionStatus } from './actionService';

// ── getSlaConfig ──────────────────────────────────────────────────────────────

export interface SlaLookupParams {
  departmentId?:   string;
  category?:       string;
  priority?:       string;
  municipality?:   string;
  district?:       string;
  state?:          string;
}

/**
 * Returns the most specific SLA config found, using a progressive fallback:
 *   1. Full match (state + department + category + priority)
 *   2. Without priority
 *   3. Without department
 *   4. Generic (category + priority only)
 *   5. Generic (category only)
 *   6. null — no config found
 */
export async function getSlaConfig(params: SlaLookupParams): Promise<SlaConfig | null> {
  if (!pool) return null;

  const { departmentId, category, priority, municipality, district, state } = params;

  const queries: Array<[string, unknown[]]> = [
    // Most specific: state + department + category + priority
    [
      `SELECT * FROM sla_configurations
       WHERE ($1::text IS NULL OR state = $1)
         AND ($2::text IS NULL OR department_id = $2)
         AND ($3::text IS NULL OR complaint_category = $3)
         AND ($4::text IS NULL OR priority = $4)
       ORDER BY is_verified DESC, configuration_type = 'statutory' DESC
       LIMIT 1`,
      [state ?? null, departmentId ?? null, category ?? null, priority ?? null],
    ],
    // Without priority
    [
      `SELECT * FROM sla_configurations
       WHERE ($1::text IS NULL OR state = $1)
         AND ($2::text IS NULL OR department_id = $2)
         AND ($3::text IS NULL OR complaint_category = $3)
       ORDER BY is_verified DESC LIMIT 1`,
      [state ?? null, departmentId ?? null, category ?? null],
    ],
    // Generic: category + priority
    [
      `SELECT * FROM sla_configurations
       WHERE state IS NULL AND department_id IS NULL
         AND ($1::text IS NULL OR complaint_category = $1)
         AND ($2::text IS NULL OR priority = $2)
       ORDER BY is_verified DESC LIMIT 1`,
      [category ?? null, priority ?? null],
    ],
    // Generic: category only
    [
      `SELECT * FROM sla_configurations
       WHERE state IS NULL AND department_id IS NULL
         AND ($1::text IS NULL OR complaint_category = $1)
       ORDER BY is_verified DESC LIMIT 1`,
      [category ?? null],
    ],
  ];

  for (const [sql, bindParams] of queries) {
    try {
      const res = await pool.query(sql, bindParams);
      if (res.rows.length > 0) {
        return res.rows[0] as unknown as SlaConfig;
      }
    } catch (err: any) {
      logger.warn(`[SLA_SERVICE] SLA lookup query failed: ${err.message}`);
    }
  }

  return null;
}

// ── calculateDeadline ─────────────────────────────────────────────────────────

/**
 * Computes the expected completion date from an assignedAt timestamp + SLA hours.
 * Returns ISO 8601 string.
 */
export function calculateDeadline(assignedAt: Date | string, slaHours: number): string {
  const base = new Date(assignedAt);
  const deadline = new Date(base.getTime() + slaHours * 60 * 60 * 1000);
  return deadline.toISOString();
}

// ── getSlaMetrics ─────────────────────────────────────────────────────────────

export function getSlaMetrics(action: CivicAction): SlaMetrics {
  const now = Date.now();

  if (!action.assigned_at) {
    return {
      timeElapsedMs:     0,
      timeRemainingMs:   null,
      isOverdue:         false,
      overdueDurationMs: null,
      complianceStatus:  'unknown',
    };
  }

  const assignedMs = new Date(action.assigned_at).getTime();
  const timeElapsedMs = now - assignedMs;

  if (action.status === 'resolved' || action.status === 'cancelled') {
    return {
      timeElapsedMs,
      timeRemainingMs:   null,
      isOverdue:         false,
      overdueDurationMs: null,
      complianceStatus:  'completed',
    };
  }

  if (!action.expected_completion_date) {
    return {
      timeElapsedMs,
      timeRemainingMs:   null,
      isOverdue:         false,
      overdueDurationMs: null,
      complianceStatus:  'unknown',
    };
  }

  const deadlineMs = new Date(action.expected_completion_date).getTime();
  const timeRemainingMs = deadlineMs - now;
  const isOverdue = timeRemainingMs < 0;

  let complianceStatus: SlaMetrics['complianceStatus'];
  if (isOverdue) {
    complianceStatus = 'overdue';
  } else if (timeRemainingMs < 4 * 60 * 60 * 1000) {
    // < 4h remaining
    complianceStatus = 'at_risk';
  } else {
    complianceStatus = 'on_track';
  }

  return {
    timeElapsedMs,
    timeRemainingMs,
    isOverdue,
    overdueDurationMs: isOverdue ? Math.abs(timeRemainingMs) : null,
    complianceStatus,
  };
}

// ── markOverdue ───────────────────────────────────────────────────────────────

export async function markOverdue(actionId: number): Promise<void> {
  if (!pool) return;

  try {
    // Only transition if currently in a state that allows overdue
    const res = await pool.query('SELECT status FROM civic_actions WHERE id = $1', [actionId]);
    if (res.rows.length === 0) return;

    const status = res.rows[0].status as string;
    if (!['in_progress', 'assigned'].includes(status)) return;

    await updateActionStatus(actionId, 'overdue', null, 'SLA deadline exceeded');
    logger.warn(`[SLA_SERVICE] Action #${actionId} marked OVERDUE`);
  } catch (err: any) {
    logger.error(`[SLA_SERVICE] markOverdue failed for action #${actionId}: ${err.message}`);
  }
}
