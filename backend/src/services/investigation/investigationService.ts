// backend/src/services/investigation/investigationService.ts
//
// Phase 4 — Autonomous Civic Investigation Agent Orchestrator
//
// Executes the full controlled 8-step investigation pipeline:
//   1. Issue Detection & Concurrency Check
//   2. Evidence Collection
//   3. Public Information Research
//   4. Department Identification
//   5. Investigation Analysis (Gemini + Fallback)
//   6. Actionable Recommendation Generation
//   7. Report Compilation & Versioning
//   8. Human Review Ready State
//
// Audit & Safety:
//   • Uses `agentLogger` with `agentType: 'investigation'` for structured audit logs.
//   • Concurrency protection: prevents duplicate simultaneous runs on the same cluster.
//   • All findings and recommendations require human review before external action.

import { pool } from '../../config/db';
import logger from '../../utils/logger';
import { startAgentRun } from '../../utils/agentLogger';
import { collectInvestigationEvidence } from './evidenceCollector';
import { conductPublicResearch } from './publicResearchService';
import { identifyResponsibleDepartment } from './departmentMatcher';
import { analyzeInvestigationFindings } from './investigationAnalyzer';
import { generateAndStoreRecommendations } from './recommendationService';
import { compileAndSaveReport } from './investigationReportService';
import {
  InvestigationStatus,
  InvestigationPriority,
  InvestigationReport,
} from './types';

export interface CreateInvestigationInput {
  clusterId: number;
  priority?: InvestigationPriority;
  createdBy?: number | null;
  triggeredBy?: string;
  autoRun?: boolean;
}

export interface InvestigationRecord {
  id: number;
  clusterId: number;
  status: InvestigationStatus;
  priority: InvestigationPriority;
  investigationSummary: string | null;
  departmentSuggestion: string | null;
  confidenceScore: number | null;
  createdBy: number | null;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
  clusterTitle?: string;
  clusterCategory?: string;
  clusterRegion?: string;
}

/**
 * Creates a new investigation record. Prevents creating duplicate active
 * investigations for the same cluster.
 */
export async function createInvestigation(
  input: CreateInvestigationInput
): Promise<InvestigationRecord> {
  if (!pool) throw new Error('[INVESTIGATION_SERVICE] DB pool unavailable');

  const { clusterId, priority = 'medium', createdBy = null, autoRun = false, triggeredBy = 'system' } = input;

  // 1. Verify cluster existence and fetch priority score
  const clusterRes = await pool.query(
    'SELECT id, title, category, region, priority_score, severity_score FROM cluster WHERE id = $1',
    [clusterId]
  );

  if (clusterRes.rows.length === 0) {
    throw new Error(`[INVESTIGATION_SERVICE] Cluster ${clusterId} does not exist`);
  }

  const cluster = clusterRes.rows[0];

  // Auto-elevate priority if priority_score is critical
  let resolvedPriority: InvestigationPriority = priority;
  const pScore = parseFloat(cluster.priority_score || cluster.severity_score || '40');
  if (pScore >= 80) resolvedPriority = 'critical';
  else if (pScore >= 65) resolvedPriority = 'high';

  // 2. Prevent duplicate active investigations (pending or running)
  const existingActive = await pool.query(
    `SELECT id, status, priority FROM civic_investigations 
     WHERE cluster_id = $1 AND status IN ('pending', 'running', 'review_pending')`,
    [clusterId]
  );

  if (existingActive.rows.length > 0) {
    const existing = existingActive.rows[0];
    logger.info(
      `[INVESTIGATION_SERVICE] Cluster ${clusterId} already has an active investigation #${existing.id} (${existing.status}). Reusing existing record.`
    );
    return getInvestigationById(existing.id);
  }

  // 3. Insert new investigation
  const insertRes = await pool.query(
    `INSERT INTO civic_investigations (cluster_id, priority, status, created_by)
     VALUES ($1, $2, 'pending', $3)
     RETURNING id, cluster_id, status, priority, created_by, created_at, updated_at`,
    [clusterId, resolvedPriority, createdBy]
  );

  const newInv = insertRes.rows[0];

  // 4. Log creation activity
  await pool.query(
    `INSERT INTO investigation_activity (investigation_id, actor_id, activity_type, description)
     VALUES ($1, $2, 'investigation_created', $3)`,
    [
      newInv.id,
      createdBy,
      `Investigation created for Cluster #${clusterId} ("${cluster.title}") with priority "${resolvedPriority}".`,
    ]
  );

  logger.info(`[INVESTIGATION_SERVICE] Created Investigation #${newInv.id} for Cluster ${clusterId}`);

  // 5. Auto-run if requested
  if (autoRun) {
    setImmediate(() => {
      runInvestigationPipeline(newInv.id, triggeredBy).catch((err) =>
        logger.error(`[INVESTIGATION_SERVICE] Auto-run failed for #${newInv.id}: ${err.message}`)
      );
    });
  }

  return getInvestigationById(newInv.id);
}

/**
 * Executes the complete autonomous multi-step investigation pipeline for an investigation.
 */
export async function runInvestigationPipeline(
  investigationId: number,
  triggeredBy = 'system'
): Promise<InvestigationReport> {
  if (!pool) throw new Error('[INVESTIGATION_SERVICE] DB pool unavailable');

  const startTime = Date.now();

  // 1. Concurrency Check: ensure investigation is not already running
  const invRes = await pool.query(
    'SELECT id, cluster_id, status, priority FROM civic_investigations WHERE id = $1 FOR UPDATE',
    [investigationId]
  );

  if (invRes.rows.length === 0) {
    throw new Error(`[INVESTIGATION_SERVICE] Investigation #${investigationId} not found`);
  }

  const investigation = invRes.rows[0];
  if (investigation.status === 'running') {
    throw new Error(`[INVESTIGATION_SERVICE] Investigation #${investigationId} is already running.`);
  }

  const clusterId = investigation.cluster_id;

  // 2. Mark investigation as running
  await pool.query(
    `UPDATE civic_investigations 
     SET status = 'running', started_at = NOW(), updated_at = NOW() 
     WHERE id = $1`,
    [investigationId]
  );

  await pool.query(
    `INSERT INTO investigation_activity (investigation_id, activity_type, description)
     VALUES ($1, 'investigation_started', 'Autonomous investigation pipeline initiated.')`,
    [investigationId]
  );

  // 3. Start Agent Audit Run
  const agentRun = startAgentRun('investigation', {
    clusterId,
    triggeredBy,
  });

  try {
    // ── STEP 1: Collect Evidence ──────────────────────────────────────────────
    const evidenceStepStart = Date.now();
    const evidenceBundle = await collectInvestigationEvidence(investigationId, clusterId);

    await agentRun.log({
      stepName: 'collect_evidence',
      status: 'success',
      durationMs: Date.now() - evidenceStepStart,
      inputData: { investigationId, clusterId },
      outputData: {
        complaintsCount: evidenceBundle.complaints.length,
        mediaCount: evidenceBundle.mediaItems.length,
        evidenceItemsCount: evidenceBundle.evidenceItems.length,
      },
    });

    // ── STEP 2: Public Policy Research ────────────────────────────────────────
    const researchStepStart = Date.now();
    const publicSources = await conductPublicResearch(
      investigationId,
      evidenceBundle.cluster.category,
      evidenceBundle.cluster.region
    );

    await agentRun.log({
      stepName: 'public_information_research',
      status: 'success',
      durationMs: Date.now() - researchStepStart,
      inputData: {
        category: evidenceBundle.cluster.category,
        region: evidenceBundle.cluster.region,
      },
      outputData: {
        sourcesCheckedCount: publicSources.length,
        policies: publicSources.map((p) => p.sourceTitle),
      },
    });

    // ── STEP 3: Department Identification ─────────────────────────────────────
    const deptStepStart = Date.now();
    const complaintTexts = evidenceBundle.complaints.map((c) => c.text);
    const departmentMatch = identifyResponsibleDepartment(
      evidenceBundle.cluster.category,
      evidenceBundle.cluster.region,
      complaintTexts,
      evidenceBundle.cluster.assignedDepartment
    );

    await agentRun.log({
      stepName: 'identify_department',
      status: 'success',
      durationMs: Date.now() - deptStepStart,
      outputData: {
        suggestedDepartment: departmentMatch.suggestedDepartment,
        confidenceScore: departmentMatch.confidenceScore,
        alternativeDepartment: departmentMatch.alternativeDepartment,
      },
    });

    // ── STEP 4: AI Investigation Analysis (Gemini) ───────────────────────────
    const analysisStepStart = Date.now();
    const findings = await analyzeInvestigationFindings({
      cluster: evidenceBundle.cluster,
      evidenceItems: evidenceBundle.evidenceItems,
      publicSources,
      suggestedDepartment: departmentMatch.suggestedDepartment,
    });

    await agentRun.log({
      stepName: 'generate_investigation_findings',
      status: 'success',
      modelUsed: process.env.INVESTIGATION_MODEL || 'gemini-2.0-flash',
      durationMs: Date.now() - analysisStepStart,
      outputData: {
        confidenceLevel: findings.confidenceLevel,
        potentialCausesCount: findings.potentialCauses.length,
        missingInfoCount: findings.missingInformation.length,
        humanVerificationReqCount: findings.humanVerificationRequirements.length,
      },
    });

    // ── STEP 5: Generate Actionable Recommendations ───────────────────────────
    const recStepStart = Date.now();
    const recommendations = await generateAndStoreRecommendations({
      investigationId,
      cluster: evidenceBundle.cluster,
      findings,
      departmentMatch,
    });

    await agentRun.log({
      stepName: 'generate_recommendations',
      status: 'success',
      durationMs: Date.now() - recStepStart,
      outputData: {
        recommendationsCount: recommendations.length,
        actions: recommendations.map((r) => r.actionTitle),
      },
    });

    // ── STEP 6: Compile and Version Investigation Report ──────────────────────
    const report = await compileAndSaveReport({
      investigationId,
      cluster: evidenceBundle.cluster,
      priority: investigation.priority,
      findings,
      departmentMatch,
      recommendations,
      totalComplaints: evidenceBundle.complaints.length,
      mediaAttachments: evidenceBundle.mediaItems.length,
      publicSourcesChecked: publicSources.length,
    });

    // ── STEP 7: Update Investigation Status to review_pending ─────────────────
    await pool.query(
      `UPDATE civic_investigations 
       SET status = 'review_pending',
           investigation_summary = $1,
           department_suggestion = $2,
           confidence_score = $3,
           completed_at = NOW(),
           updated_at = NOW()
       WHERE id = $4`,
      [
        findings.investigationSummary,
        departmentMatch.suggestedDepartment,
        findings.confidenceLevel,
        investigationId,
      ]
    );

    // ── STEP 8: Log Completion Activity ───────────────────────────────────────
    await pool.query(
      `INSERT INTO investigation_activity (investigation_id, activity_type, description, metadata)
       VALUES ($1, 'investigation_completed', $2, $3)`,
      [
        investigationId,
        `Investigation completed in ${((Date.now() - startTime) / 1000).toFixed(1)}s. Awaiting official review.`,
        JSON.stringify({
          findingsConfidence: findings.confidenceLevel,
          recommendationsCount: recommendations.length,
        }),
      ]
    );

    await agentRun.log({
      stepName: 'pipeline_completion',
      status: 'success',
      durationMs: Date.now() - startTime,
      outputData: {
        status: 'review_pending',
        departmentSuggestion: departmentMatch.suggestedDepartment,
        confidenceScore: findings.confidenceLevel,
      },
    });

    logger.info(`[INVESTIGATION_SERVICE] Investigation #${investigationId} pipeline finished successfully.`);
    return report;
  } catch (pipelineErr: any) {
    logger.error(`[INVESTIGATION_SERVICE] Pipeline failed for #${investigationId}: ${pipelineErr.message}`);

    // Update status to failed
    await pool.query(
      `UPDATE civic_investigations 
       SET status = 'failed', updated_at = NOW() 
       WHERE id = $1`,
      [investigationId]
    );

    await pool.query(
      `INSERT INTO investigation_activity (investigation_id, activity_type, description, metadata)
       VALUES ($1, 'investigation_failed', $2, $3)`,
      [
        investigationId,
        `Investigation failed: ${pipelineErr.message}`,
        JSON.stringify({ error: pipelineErr.message, stack: pipelineErr.stack }),
      ]
    );

    await agentRun.log({
      stepName: 'pipeline_completion',
      status: 'failed',
      durationMs: Date.now() - startTime,
      errorMessage: pipelineErr.message,
    });

    throw pipelineErr;
  }
}

/**
 * Retrieves an investigation by primary ID with cluster metadata.
 */
export async function getInvestigationById(id: number): Promise<InvestigationRecord> {
  if (!pool) throw new Error('[INVESTIGATION_SERVICE] DB pool unavailable');

  const res = await pool.query(
    `SELECT i.id, i.cluster_id as "clusterId", i.status, i.priority,
            i.investigation_summary as "investigationSummary",
            i.department_suggestion as "departmentSuggestion",
            i.confidence_score as "confidenceScore",
            i.created_by as "createdBy",
            i.started_at as "startedAt",
            i.completed_at as "completedAt",
            i.created_at as "createdAt",
            i.updated_at as "updatedAt",
            c.title as "clusterTitle",
            c.category as "clusterCategory",
            c.region as "clusterRegion"
     FROM civic_investigations i
     JOIN cluster c ON i.cluster_id = c.id
     WHERE i.id = $1`,
    [id]
  );

  if (res.rows.length === 0) {
    throw new Error(`[INVESTIGATION_SERVICE] Investigation #${id} not found`);
  }

  const row = res.rows[0];
  return {
    ...row,
    confidenceScore: row.confidenceScore != null ? parseFloat(row.confidenceScore) : null,
  };
}

/**
 * Retrieves all investigations with optional filtering.
 */
export async function listInvestigations(filters: {
  status?: string;
  clusterId?: number;
  priority?: string;
  limit?: number;
  offset?: number;
} = {}): Promise<{ data: InvestigationRecord[]; total: number }> {
  if (!pool) return { data: [], total: 0 };

  const { status, clusterId, priority, limit = 50, offset = 0 } = filters;
  const conditions: string[] = [];
  const params: any[] = [];

  if (status && status !== 'all') {
    params.push(status);
    conditions.push(`i.status = $${params.length}`);
  }

  if (clusterId) {
    params.push(clusterId);
    conditions.push(`i.cluster_id = $${params.length}`);
  }

  if (priority && priority !== 'all') {
    params.push(priority);
    conditions.push(`i.priority = $${params.length}`);
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  const countRes = await pool.query(
    `SELECT COUNT(*) FROM civic_investigations i ${whereClause}`,
    params
  );
  const total = parseInt(countRes.rows[0]?.count || '0', 10);

  const query = `
    SELECT i.id, i.cluster_id as "clusterId", i.status, i.priority,
           i.investigation_summary as "investigationSummary",
           i.department_suggestion as "departmentSuggestion",
           i.confidence_score as "confidenceScore",
           i.created_by as "createdBy",
           i.started_at as "startedAt",
           i.completed_at as "completedAt",
           i.created_at as "createdAt",
           i.updated_at as "updatedAt",
           c.title as "clusterTitle",
           c.category as "clusterCategory",
           c.region as "clusterRegion"
    FROM civic_investigations i
    JOIN cluster c ON i.cluster_id = c.id
    ${whereClause}
    ORDER BY 
      CASE i.priority 
        WHEN 'critical' THEN 1 
        WHEN 'high' THEN 2 
        WHEN 'medium' THEN 3 
        ELSE 4 
      END,
      i.created_at DESC
    LIMIT $${params.length + 1} OFFSET $${params.length + 2}
  `;

  const rowsRes = await pool.query(query, [...params, limit, offset]);

  const mapped = rowsRes.rows.map((row) => ({
    ...row,
    confidenceScore: row.confidenceScore != null ? parseFloat(row.confidenceScore) : null,
  }));

  return { data: mapped, total };
}

/**
 * Retrieves the full investigation dossier including evidence, latest report,
 * recommendations, and activity history.
 */
export async function getInvestigationDossier(investigationId: number) {
  if (!pool) throw new Error('[INVESTIGATION_SERVICE] DB pool unavailable');

  const investigation = await getInvestigationById(investigationId);

  // Evidence
  const evidenceRes = await pool.query(
    `SELECT id, evidence_type as "evidenceType", source_url as "sourceUrl",
            source_title as "sourceTitle", evidence_description as "evidenceDescription",
            verification_status as "verificationStatus", retrieved_at as "retrievedAt"
     FROM investigation_evidence
     WHERE investigation_id = $1
     ORDER BY id ASC`,
    [investigationId]
  );

  // Latest Report
  const reportRes = await pool.query(
    `SELECT id, report_json as "reportJson", report_version as "reportVersion",
            generated_at as "generatedAt", review_status as "reviewStatus",
            review_notes as "reviewNotes", reviewed_by as "reviewedBy"
     FROM investigation_reports
     WHERE investigation_id = $1
     ORDER BY report_version DESC
     LIMIT 1`,
    [investigationId]
  );

  // Recommendations
  const recsRes = await pool.query(
    `SELECT id, action_title as "actionTitle", description, department_id as "departmentId",
            priority, confidence_score as "confidenceScore", approval_status as "approvalStatus",
            created_at as "createdAt"
     FROM investigation_recommendations
     WHERE investigation_id = $1
     ORDER BY id ASC`,
    [investigationId]
  );

  // Activity Log
  const activityRes = await pool.query(
    `SELECT a.id, a.activity_type as "activityType", a.description,
            a.metadata, a.created_at as "createdAt",
            u.name as "actorName", u.role as "actorRole"
     FROM investigation_activity a
     LEFT JOIN "user" u ON a.actor_id = u.id
     WHERE a.investigation_id = $1
     ORDER BY a.created_at DESC`,
    [investigationId]
  );

  return {
    investigation,
    evidence: evidenceRes.rows,
    latestReport: reportRes.rows[0] ? {
      ...reportRes.rows[0],
      reportJson: typeof reportRes.rows[0].reportJson === 'string'
        ? JSON.parse(reportRes.rows[0].reportJson)
        : reportRes.rows[0].reportJson,
    } : null,
    recommendations: recsRes.rows.map((r) => ({
      ...r,
      confidenceScore: r.confidenceScore != null ? parseFloat(r.confidenceScore) : null,
    })),
    activity: activityRes.rows,
  };
}

/**
 * Recovers investigations left in 'running' state after an unexpected server crash or restart.
 * Marks runs exceeding staleThresholdMinutes as 'failed' so they can be safely retried.
 */
export async function recoverStaleInvestigations(staleThresholdMinutes = 15): Promise<number> {
  if (!pool) return 0;
  try {
    const res = await pool.query(
      `UPDATE civic_investigations 
       SET status = 'failed', updated_at = NOW() 
       WHERE status = 'running' 
         AND started_at < NOW() - INTERVAL '1 minute' * $1
       RETURNING id`,
      [staleThresholdMinutes]
    );
    const count = res.rowCount || 0;
    if (count > 0) {
      logger.warn(`[INVESTIGATION_SERVICE] Recovered ${count} stale running investigations -> marked 'failed' for safe retry`);
    }
    return count;
  } catch (err: any) {
    logger.error('[INVESTIGATION_SERVICE] Error recovering stale investigations:', err);
    return 0;
  }
}
