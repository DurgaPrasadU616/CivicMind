// backend/src/services/actions/assignmentService.ts
//
// Phase 5 — Department & Officer Assignment Service
//
// Responsibilities:
//   - assignAction       — Set is_current=false on prior, insert new assignment,
//                          update civic_actions to 'assigned', validate jurisdiction
//   - getActionAssignments — Full history
//   - updateAssignment    — Change officer, deadline, notes on the current assignment

import { pool } from '../../config/db';
import logger from '../../utils/logger';
import { identifyResponsibleDepartment } from '../investigation/departmentMatcher';
import { AssignActionInput, ActionAssignment } from './types';
import { updateActionStatus } from './actionService';

// ── assignAction ──────────────────────────────────────────────────────────────

export async function assignAction(
  actionId: number,
  input: AssignActionInput,
  assignedBy: number | null
): Promise<ActionAssignment> {
  if (!pool) throw new Error('Database not available');

  // Validate jurisdiction via departmentMatcher (informational — not blocking)
  try {
    const match = identifyResponsibleDepartment('infrastructure', input.departmentName, [], null, {
      municipality: input.departmentName,
    });
    if (match.needsHumanVerification) {
      logger.warn(
        `[ASSIGNMENT_SERVICE] Department "${input.departmentName}" requires human jurisdiction verification`
      );
    }
  } catch (err: any) {
    logger.warn(`[ASSIGNMENT_SERVICE] Department matcher warning: ${err.message}`);
  }

  // Set all current assignments to is_current=false
  await pool.query(
    'UPDATE action_assignments SET is_current = FALSE WHERE action_id = $1',
    [actionId]
  );

  const result = await pool.query(
    `INSERT INTO action_assignments
       (action_id, department_name, department_id, officer_id, officer_name,
        assigned_by, expected_completion_date, priority, notes)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     RETURNING *`,
    [
      actionId,
      input.departmentName,
      input.departmentId ?? null,
      input.officerId ?? null,
      input.officerName ?? null,
      assignedBy,
      input.expectedCompletionDate ?? null,
      input.priority ?? null,
      input.notes ?? null,
    ]
  );

  const assignment = result.rows[0] as ActionAssignment;

  // Update action: status → assigned, assigned_by, assigned_at, expected_completion_date
  await pool.query(
    `UPDATE civic_actions
     SET status = 'assigned',
         assigned_by = $1,
         assigned_at = NOW(),
         department_id = $2,
         department_name = $3,
         expected_completion_date = $4
     WHERE id = $5`,
    [
      assignedBy,
      input.departmentId ?? null,
      input.departmentName,
      input.expectedCompletionDate ?? null,
      actionId,
    ]
  );

  // Log status transition
  await pool.query(
    `INSERT INTO action_status_history
       (action_id, previous_status, new_status, changed_by, change_reason)
     SELECT $1, status, 'assigned', $2, $3
     FROM civic_actions WHERE id = $1`,
    [actionId, assignedBy, `Assigned to ${input.departmentName}`]
  );

  logger.info(
    `[ASSIGNMENT_SERVICE] Action #${actionId} assigned to "${input.departmentName}" by user #${assignedBy}`
  );

  return assignment;
}

// ── getActionAssignments ──────────────────────────────────────────────────────

export async function getActionAssignments(actionId: number): Promise<ActionAssignment[]> {
  if (!pool) throw new Error('Database not available');

  const result = await pool.query(
    'SELECT * FROM action_assignments WHERE action_id = $1 ORDER BY assigned_at DESC',
    [actionId]
  );
  return result.rows as unknown as ActionAssignment[];
}

// ── updateAssignment ──────────────────────────────────────────────────────────

export async function updateAssignment(
  assignmentId: number,
  patch: Partial<Pick<AssignActionInput, 'officerName' | 'expectedCompletionDate' | 'notes' | 'priority'>>,
  updatedBy: number | null
): Promise<ActionAssignment> {
  if (!pool) throw new Error('Database not available');

  const fields: string[] = [];
  const params: unknown[] = [];
  let idx = 1;

  if (patch.officerName !== undefined) {
    fields.push(`officer_name = $${idx++}`);
    params.push(patch.officerName);
  }
  if (patch.expectedCompletionDate !== undefined) {
    fields.push(`expected_completion_date = $${idx++}`);
    params.push(patch.expectedCompletionDate);
  }
  if (patch.notes !== undefined) {
    fields.push(`notes = $${idx++}`);
    params.push(patch.notes);
  }
  if (patch.priority !== undefined) {
    fields.push(`priority = $${idx++}`);
    params.push(patch.priority);
  }

  if (fields.length === 0) throw new Error('No fields to update');

  const result = await pool.query(
    `UPDATE action_assignments SET ${fields.join(', ')} WHERE id = $${idx} RETURNING *`,
    [...params, assignmentId]
  );

  if (result.rows.length === 0) throw new Error(`Assignment #${assignmentId} not found`);

  logger.info(`[ASSIGNMENT_SERVICE] Assignment #${assignmentId} updated by user #${updatedBy}`);
  return result.rows[0] as unknown as ActionAssignment;
}
