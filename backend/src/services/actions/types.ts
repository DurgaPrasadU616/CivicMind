// backend/src/services/actions/types.ts
//
// Phase 5 — Civic Action & Resolution Intelligence — Shared Types & Schemas
//
// Defines Zod schemas and TypeScript types for:
//   - Action status and priority enums
//   - CivicAction, ActionAssignment, ActionStatusHistory
//   - ResolutionEvidence, SlaConfig, ActionNotification
//   - Input schemas for all service operations
//   - Valid state machine transition map

import { z } from 'zod';

// ── Status / Priority Enums ───────────────────────────────────────────────────

export const ActionStatusEnum = z.enum([
  'pending_approval',
  'approved',
  'assigned',
  'in_progress',
  'awaiting_verification',
  'resolved',
  'rejected',
  'on_hold',
  'overdue',
  'reopened',
  'cancelled',
]);
export type ActionStatus = z.infer<typeof ActionStatusEnum>;

export const ActionPriorityEnum = z.enum(['low', 'medium', 'high', 'critical']);
export type ActionPriority = z.infer<typeof ActionPriorityEnum>;

// ── State Machine: Valid Transitions ─────────────────────────────────────────
// Maps "current status" → Set of allowed "next statuses"

export const VALID_TRANSITIONS: Record<ActionStatus, Set<ActionStatus>> = {
  pending_approval:      new Set(['approved', 'rejected', 'cancelled']),
  approved:              new Set(['assigned', 'cancelled', 'on_hold']),
  assigned:              new Set(['in_progress', 'on_hold', 'cancelled']),
  in_progress:           new Set(['awaiting_verification', 'on_hold', 'cancelled', 'overdue']),
  awaiting_verification: new Set(['resolved', 'in_progress', 'reopened']),
  resolved:              new Set(['reopened']),
  rejected:              new Set([]),
  on_hold:               new Set(['approved', 'in_progress', 'cancelled']),
  overdue:               new Set(['in_progress', 'awaiting_verification', 'cancelled']),
  reopened:              new Set(['assigned', 'in_progress', 'cancelled']),
  cancelled:             new Set([]),
};

/** Strict terminal statuses — no further transitions allowed */
export const TERMINAL_STATUSES: Set<ActionStatus> = new Set(['rejected', 'cancelled']);

/** Checks whether a transition is valid */
export function isValidTransition(from: ActionStatus, to: ActionStatus): boolean {
  return VALID_TRANSITIONS[from]?.has(to) ?? false;
}

// ── Entity Schemas ────────────────────────────────────────────────────────────

export const CivicActionSchema = z.object({
  id:                      z.number().int().positive(),
  investigation_id:        z.number().int().nullable(),
  recommendation_id:       z.number().int().nullable(),
  cluster_id:              z.number().int().nullable(),
  action_title:            z.string().min(1).max(255),
  description:             z.string().min(1),
  department_id:           z.string().nullable(),
  department_name:         z.string().nullable(),
  status:                  ActionStatusEnum,
  priority:                ActionPriorityEnum,
  created_by:              z.number().int().nullable(),
  approved_by:             z.number().int().nullable(),
  assigned_by:             z.number().int().nullable(),
  created_at:              z.string(),
  updated_at:              z.string(),
  approved_at:             z.string().nullable(),
  assigned_at:             z.string().nullable(),
  expected_completion_date: z.string().nullable(),
  actual_completion_date:  z.string().nullable(),
  overdue_since:           z.string().nullable(),
});
export type CivicAction = z.infer<typeof CivicActionSchema>;

export const ActionAssignmentSchema = z.object({
  id:                      z.number().int().positive(),
  action_id:               z.number().int().positive(),
  department_name:         z.string().nullable(),
  department_id:           z.string().nullable(),
  officer_id:              z.number().int().nullable(),
  officer_name:            z.string().nullable(),
  assigned_by:             z.number().int().nullable(),
  expected_completion_date: z.string().nullable(),
  priority:                ActionPriorityEnum.nullable(),
  notes:                   z.string().nullable(),
  assigned_at:             z.string(),
  created_at:              z.string(),
  is_current:              z.boolean(),
});
export type ActionAssignment = z.infer<typeof ActionAssignmentSchema>;

export const ActionStatusHistorySchema = z.object({
  id:              z.number().int().positive(),
  action_id:       z.number().int().positive(),
  previous_status: z.string().nullable(),
  new_status:      z.string(),
  changed_by:      z.number().int().nullable(),
  change_reason:   z.string().nullable(),
  metadata:        z.record(z.unknown()).default({}),
  created_at:      z.string(),
});
export type ActionStatusHistory = z.infer<typeof ActionStatusHistorySchema>;

export const ResolutionEvidenceSchema = z.object({
  id:                  z.number().int().positive(),
  action_id:           z.number().int().positive(),
  evidence_type:       z.enum(['before', 'after', 'progress', 'completion_report']),
  storage_key:         z.string(),
  original_filename:   z.string().nullable(),
  mime_type:           z.string().nullable(),
  file_size:           z.number().nullable(),
  uploaded_by:         z.number().int().nullable(),
  description:         z.string().nullable(),
  ai_analysis:         z.record(z.unknown()).nullable(),
  ai_confidence_score: z.number().min(0).max(1).nullable(),
  needs_human_review:  z.boolean(),
  verification_status: z.enum(['pending', 'verified', 'rejected']),
  created_at:          z.string(),
  verified_at:         z.string().nullable(),
  verified_by:         z.number().int().nullable(),
});
export type ResolutionEvidence = z.infer<typeof ResolutionEvidenceSchema>;

export const SlaConfigSchema = z.object({
  id:                 z.number().int().positive(),
  state:              z.string().nullable(),
  district:           z.string().nullable(),
  municipality:       z.string().nullable(),
  department_id:      z.string().nullable(),
  complaint_category: z.string().nullable(),
  priority:           ActionPriorityEnum.nullable(),
  response_hours:     z.number().int().positive(),
  resolution_hours:   z.number().int().positive(),
  source_description: z.string().nullable(),
  is_verified:        z.boolean(),
  configuration_type: z.enum(['statutory', 'estimated', 'manual']),
  created_at:         z.string(),
  updated_at:         z.string(),
});
export type SlaConfig = z.infer<typeof SlaConfigSchema>;

// ── Input Schemas ─────────────────────────────────────────────────────────────

export const CreateActionInputSchema = z.object({
  investigationId:   z.number().int().positive().optional(),
  recommendationId:  z.number().int().positive().optional(),
  clusterId:         z.number().int().positive().optional(),
  actionTitle:       z.string().min(1).max(255),
  description:       z.string().min(1).max(5000),
  departmentId:      z.string().max(100).optional(),
  departmentName:    z.string().max(150).optional(),
  priority:          ActionPriorityEnum.optional().default('medium'),
});
export type CreateActionInput = z.input<typeof CreateActionInputSchema>;

export const AssignActionInputSchema = z.object({
  departmentName:         z.string().min(1).max(150),
  departmentId:           z.string().max(100).optional(),
  officerId:              z.number().int().positive().optional(),
  officerName:            z.string().max(150).optional(),
  expectedCompletionDate: z.string().datetime({ offset: true }).optional(),
  priority:               ActionPriorityEnum.optional(),
  notes:                  z.string().max(2000).optional(),
});
export type AssignActionInput = z.infer<typeof AssignActionInputSchema>;

export const UpdateStatusInputSchema = z.object({
  newStatus:    ActionStatusEnum,
  changeReason: z.string().max(2000).optional(),
  metadata:     z.record(z.unknown()).optional().default({}),
});
export type UpdateStatusInput = z.infer<typeof UpdateStatusInputSchema>;

export const VerifyResolutionInputSchema = z.object({
  approved: z.boolean(),
  notes:    z.string().max(2000).optional(),
});
export type VerifyResolutionInput = z.infer<typeof VerifyResolutionInputSchema>;

export const SlaMetrics = z.object({
  timeElapsedMs:     z.number(),
  timeRemainingMs:   z.number().nullable(),
  isOverdue:         z.boolean(),
  overdueDurationMs: z.number().nullable(),
  complianceStatus:  z.enum(['on_track', 'at_risk', 'overdue', 'completed', 'unknown']),
});
export type SlaMetrics = z.infer<typeof SlaMetrics>;

// ── Citizen-safe progress view ────────────────────────────────────────────────

export interface CitizenProgressView {
  complaintId:    number;
  actionId:       number | null;
  currentStatus:  string;
  priority:       string;
  departmentName: string | null;
  expectedCompletion: string | null;
  statusHistory: Array<{
    status:    string;
    changedAt: string;
    note:      string | null;
  }>;
  canReopen: boolean;
}
