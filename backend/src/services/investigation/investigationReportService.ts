// backend/src/services/investigation/investigationReportService.ts
//
// Phase 4 — Investigation Report Compilation & Review Workflow Service
//
// Compiles full versioned investigation reports, stores them in
// `investigation_reports`, and handles the official review lifecycle
// (Approve, Reject, Request Revision, Recommendation modifications).

import { pool } from '../../config/db';
import logger from '../../utils/logger';
import {
  InvestigationReport,
  InvestigationReportSchema,
  InvestigationFindings,
  DepartmentMatch,
  InvestigationRecommendation,
  ReviewStatus,
} from './types';

export interface CompileReportInput {
  investigationId: number;
  cluster: {
    id: number;
    title: string;
    category: string;
    region: string;
    priorityScore: number;
    complaintCount: number;
  };
  priority: 'low' | 'medium' | 'high' | 'critical';
  findings: InvestigationFindings;
  departmentMatch: DepartmentMatch;
  recommendations: InvestigationRecommendation[];
  totalComplaints: number;
  mediaAttachments: number;
  publicSourcesChecked: number;
}

/**
 * Compiles a comprehensive investigation report, validates it with Zod,
 * and saves a versioned entry in `investigation_reports`.
 */
export async function compileAndSaveReport(
  input: CompileReportInput
): Promise<InvestigationReport> {
  const reportPayload: InvestigationReport = {
    investigationId: input.investigationId,
    clusterId: input.cluster.id,
    clusterTitle: input.cluster.title,
    category: input.cluster.category,
    region: input.cluster.region,
    priority: input.priority,
    generatedAt: new Date().toISOString(),
    findings: input.findings,
    departmentMatch: input.departmentMatch,
    recommendations: input.recommendations,
    evidenceSummary: {
      totalComplaints: input.totalComplaints,
      mediaAttachments: input.mediaAttachments,
      publicSourcesChecked: input.publicSourcesChecked,
    },
    humanReviewNotes: null,
  };

  // Validate full report schema
  const validated = InvestigationReportSchema.parse(reportPayload);

  if (pool) {
    try {
      // Get next version number
      const verRes = await pool.query(
        `SELECT COALESCE(MAX(report_version), 0) + 1 as next_ver
         FROM investigation_reports
         WHERE investigation_id = $1`,
        [input.investigationId]
      );
      const nextVersion = verRes.rows[0]?.next_ver || 1;

      await pool.query(
        `INSERT INTO investigation_reports
           (investigation_id, report_json, report_version, review_status)
         VALUES ($1, $2, $3, 'pending')`,
        [input.investigationId, JSON.stringify(validated), nextVersion]
      );

      logger.info(
        `[INVESTIGATION_REPORT] Saved Report Version ${nextVersion} for Investigation ${input.investigationId}`
      );
    } catch (err: any) {
      logger.warn(`[INVESTIGATION_REPORT] Could not save report version to DB: ${err.message}`);
    }
  }

  return validated;
}

/**
 * Handles official human review actions on an investigation report.
 */
export async function reviewInvestigationReport(
  investigationId: number,
  reviewerId: number,
  reviewStatus: ReviewStatus,
  reviewNotes?: string
): Promise<{ success: boolean; newStatus: string }> {
  if (!pool) throw new Error('[INVESTIGATION_REPORT] DB pool unavailable');

  // Map review status to investigation status
  let newInvestigationStatus = 'review_pending';
  if (reviewStatus === 'approved') newInvestigationStatus = 'approved';
  else if (reviewStatus === 'rejected') newInvestigationStatus = 'rejected';
  else if (reviewStatus === 'revision_requested') newInvestigationStatus = 'pending';

  // 1. Update latest report review status
  await pool.query(
    `UPDATE investigation_reports
     SET review_status = $1,
         reviewed_by = $2,
         review_notes = $3
     WHERE id = (
       SELECT id FROM investigation_reports
       WHERE investigation_id = $4
       ORDER BY report_version DESC
       LIMIT 1
     )`,
    [reviewStatus, reviewerId, reviewNotes || null, investigationId]
  );

  // 2. Update investigation row status
  await pool.query(
    `UPDATE civic_investigations
     SET status = $1,
         updated_at = NOW()
     WHERE id = $2`,
    [newInvestigationStatus, investigationId]
  );

  // 3. Log activity timeline event
  await pool.query(
    `INSERT INTO investigation_activity
       (investigation_id, actor_id, activity_type, description, metadata)
     VALUES ($1, $2, $3, $4, $5)`,
    [
      investigationId,
      reviewerId,
      `report_review_${reviewStatus}`,
      `Investigation findings marked as "${reviewStatus}" by reviewer #${reviewerId}.`,
      JSON.stringify({ reviewNotes, reviewStatus, timestamp: new Date().toISOString() }),
    ]
  );

  logger.info(
    `[INVESTIGATION_REPORT] Investigation ${investigationId} review completed: ${reviewStatus} (Officer: ${reviewerId})`
  );

  return { success: true, newStatus: newInvestigationStatus };
}

/**
 * Updates approval status for a specific recommendation.
 */
export async function updateRecommendationStatus(
  recommendationId: number,
  investigationId: number,
  actorId: number,
  newApprovalStatus: 'approved' | 'rejected' | 'modified',
  modifiedTitle?: string,
  modifiedDescription?: string
): Promise<boolean> {
  if (!pool) throw new Error('[INVESTIGATION_REPORT] DB pool unavailable');

  const updateFields = modifiedTitle && modifiedDescription
    ? 'action_title = $1, description = $2, approval_status = $3'
    : 'approval_status = $1';

  const params = modifiedTitle && modifiedDescription
    ? [modifiedTitle, modifiedDescription, newApprovalStatus, recommendationId, investigationId]
    : [newApprovalStatus, recommendationId, investigationId];

  await pool.query(
    `UPDATE investigation_recommendations
     SET ${updateFields}
     WHERE id = $${params.length - 1} AND investigation_id = $${params.length}`,
    params
  );

  // Log recommendation activity
  await pool.query(
    `INSERT INTO investigation_activity
       (investigation_id, actor_id, activity_type, description, metadata)
     VALUES ($1, $2, 'recommendation_review', $3, $4)`,
    [
      investigationId,
      actorId,
      `Recommendation #${recommendationId} updated to status "${newApprovalStatus}"`,
      JSON.stringify({ recommendationId, newApprovalStatus, modifiedTitle }),
    ]
  );

  return true;
}
