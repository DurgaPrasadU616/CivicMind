// backend/src/services/actions/actionNotificationService.ts
//
// Phase 5 — Notification Dispatch Service
//
// LIMITATION: This service does NOT send actual email or SMS.
// Notifications are queued in action_notifications with status='queued'.
// A real delivery channel (SendGrid, Twilio, etc.) must be wired externally.
//
// Notification types:
//   overdue_alert           — Action has exceeded SLA deadline
//   assignment_notification — Action assigned to department/officer
//   resolution_verified     — Human reviewer confirmed resolution
//   reopened_alert          — Resolved or awaiting-verification action reopened

import { pool } from '../../config/db';
import logger from '../../utils/logger';

export type NotificationType =
  | 'overdue_alert'
  | 'assignment_notification'
  | 'resolution_verified'
  | 'reopened_alert';

export interface SendNotificationResult {
  sent:    boolean;
  skipped: boolean;
  reason?: string;
}

/**
 * Queues a notification for the given action and recipient.
 * Uses dedupe_key = "<type>:<actionId>:<recipientId>" to prevent duplicate entries.
 *
 * Returns:
 *   { sent: true }   — notification row inserted
 *   { skipped: true } — dedupe_key already exists; notification not duplicated
 */
export async function sendNotification(
  actionId:         number,
  type:             NotificationType,
  recipientId:      number | null
): Promise<SendNotificationResult> {
  if (!pool) {
    logger.warn('[NOTIFICATION] DB not available — skipping notification');
    return { sent: false, skipped: true, reason: 'no_db' };
  }

  const dedupeKey = `${type}:${actionId}:${recipientId ?? 'system'}`;

  try {
    const res = await pool.query(
      `INSERT INTO action_notifications
         (action_id, notification_type, recipient_id, delivery_status, dedupe_key)
       VALUES ($1, $2, $3, 'queued', $4)
       ON CONFLICT (dedupe_key) DO NOTHING
       RETURNING id`,
      [actionId, type, recipientId, dedupeKey]
    );

    if (res.rows.length === 0) {
      logger.debug(
        `[NOTIFICATION] Skipped duplicate: type="${type}" action=#${actionId} recipient=${recipientId ?? 'system'}`
      );
      return { sent: false, skipped: true, reason: 'duplicate' };
    }

    logger.info(
      `[NOTIFICATION] Queued: type="${type}" action=#${actionId} recipient=${recipientId ?? 'system'} id=${res.rows[0].id}`
    );

    // NOTE: Real dispatch (email/SMS) would be triggered here.
    // For now, we only queue the row. The delivery_status stays 'queued'.

    return { sent: true, skipped: false };
  } catch (err: any) {
    logger.error(`[NOTIFICATION] Failed to queue notification: ${err.message}`);
    return { sent: false, skipped: false, reason: err.message };
  }
}
