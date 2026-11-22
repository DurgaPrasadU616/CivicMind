// backend/src/services/actions/deadlineMonitor.ts
//
// Phase 5 — Background SLA Deadline Monitor
//
// Registers a recurring job (every 15 min) via jobQueue.
// Scans for overdue actions and marks them OVERDUE.
// Uses action_notifications dedupe_key to prevent duplicate alerts.

import { jobQueue } from '../jobQueue';
import { pool } from '../../config/db';
import logger from '../../utils/logger';
import { startAgentRun } from '../../utils/agentLogger';
import { markOverdue } from './slaService';

const MONITOR_INTERVAL_MS = 15 * 60 * 1000; // 15 minutes
const NON_TERMINAL_STATUSES = ['pending_approval', 'approved', 'assigned', 'in_progress', 'on_hold', 'reopened'];

let _monitorTimer: ReturnType<typeof setInterval> | null = null;

// ── checkOverdueActions ───────────────────────────────────────────────────────

export async function checkOverdueActions(): Promise<number> {
  if (!pool) {
    logger.warn('[DEADLINE_MONITOR] DB not available — skipping overdue check');
    return 0;
  }

  const run = startAgentRun('monitoring', { triggeredBy: 'cron' });
  await run.log({ stepName: 'check_overdue_start', status: 'running' });

  try {
    // Find actions where deadline has passed and not yet in terminal/overdue state
    const res = await pool.query(
      `SELECT id, department_name, department_id
       FROM civic_actions
       WHERE expected_completion_date < NOW()
         AND status = ANY($1::text[])`,
      [NON_TERMINAL_STATUSES]
    );

    const overdueIds: number[] = res.rows.map((r: { id: number }) => r.id);
    let marked = 0;

    for (const actionId of overdueIds) {
      await markOverdue(actionId);

      // Deduplication — only send one overdue_alert per action
      const dedupeKey = `overdue_alert:${actionId}`;
      try {
        await pool.query(
          `INSERT INTO action_notifications
             (action_id, notification_type, delivery_status, dedupe_key)
           VALUES ($1, 'overdue_alert', 'queued', $2)
           ON CONFLICT (dedupe_key) DO NOTHING`,
          [actionId, dedupeKey]
        );
      } catch (err: any) {
        logger.warn(`[DEADLINE_MONITOR] Notification dedupe failed for #${actionId}: ${err.message}`);
      }

      marked++;
    }

    await run.log({
      stepName:   'check_overdue_complete',
      status:     'success',
      outputData: { overdueCount: marked },
    });

    if (marked > 0) {
      logger.warn(`[DEADLINE_MONITOR] Marked ${marked} action(s) as OVERDUE`);
    }

    return marked;
  } catch (err: any) {
    await run.log({ stepName: 'check_overdue_error', status: 'failed', errorMessage: err.message });
    logger.error(`[DEADLINE_MONITOR] Error checking overdue actions: ${err.message}`);
    return 0;
  }
}

// ── startDeadlineMonitor ──────────────────────────────────────────────────────

/**
 * Starts the background SLA deadline monitor.
 * Safe to call multiple times — no-ops if already running.
 */
export function startDeadlineMonitor(): void {
  if (_monitorTimer) {
    logger.info('[DEADLINE_MONITOR] Already running — skipping start');
    return;
  }

  logger.info(`[DEADLINE_MONITOR] Starting — checking every ${MONITOR_INTERVAL_MS / 60000} minutes`);

  // Run once immediately, then on interval
  const runJob = (): void => {
    jobQueue.enqueue(
      'deadline_monitor_check',
      async () => {
        await checkOverdueActions();
      },
      { maxRetries: 1, meta: { job: 'deadline_monitor' } }
    );
  };

  runJob();
  _monitorTimer = setInterval(runJob, MONITOR_INTERVAL_MS);
}

/** Stop the monitor (for clean test teardown) */
export function stopDeadlineMonitor(): void {
  if (_monitorTimer) {
    clearInterval(_monitorTimer);
    _monitorTimer = null;
    logger.info('[DEADLINE_MONITOR] Stopped');
  }
}
