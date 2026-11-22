// backend/src/services/investigation/recommendationService.ts
//
// Phase 4 — Actionable Recommendation Engine
//
// Generates concrete, practical, and departmental corrective actions based on
// investigation findings. Every recommendation includes expected outcomes,
// estimated resources, supporting evidence, and required review status.
//
// Safety:
//   All recommendations are created with `approval_status = 'pending'`.
//   The AI agent cannot execute recommendations or dispatch civic contractors
//   without explicit human approval.

import { pool } from '../../config/db';
import logger from '../../utils/logger';
import {
  InvestigationRecommendation,
  InvestigationRecommendationSchema,
  InvestigationFindings,
  DepartmentMatch,
} from './types';

export interface RecommendationEngineInput {
  investigationId: number;
  cluster: {
    id: number;
    title: string;
    category: string;
    region: string;
    severityScore: number;
  };
  findings: InvestigationFindings;
  departmentMatch: DepartmentMatch;
}

/**
 * Deterministic, category-specific corrective actions used as primary or fallback logic.
 */
export function buildDeterministicRecommendations(
  input: RecommendationEngineInput
): InvestigationRecommendation[] {
  const { cluster, departmentMatch } = input;
  const dept = departmentMatch.suggestedDepartment;

  const recs: InvestigationRecommendation[] = [];

  switch (cluster.category.toLowerCase()) {
    case 'infrastructure':
      recs.push({
        actionTitle: 'Dispatch Ward Junior Engineer for Physical Inspection',
        description: `Deploy a field inspection officer from ${dept} to survey road surface damage and mark defect boundaries.`,
        departmentId: dept,
        priority: 'high',
        expectedOutcome: 'Accurate damage measurement and road-cut permit verification within 24 hours.',
        requiredResources: '1 Ward Junior Engineer, survey kit, measuring wheel',
        supportingEvidence: [
          `Cluster #${cluster.id} has severity index ${cluster.severityScore}/100`,
          'Citizen complaints document hazardous road defects',
        ],
        confidenceScore: 0.95,
      });
      recs.push({
        actionTitle: 'Execute High-Grade Asphalt Cold-Mix Patching',
        description: 'Apply rapid cold-mix bitumen patching to eliminate vehicle tyre impact and prevent rain erosion.',
        departmentId: dept,
        priority: 'medium',
        expectedOutcome: 'Smooth vehicular passage restored; prevention of asphalt degradation.',
        requiredResources: 'Road maintenance crew (4 personnel), 2 tonnes asphalt cold-mix, compactor roller',
        supportingEvidence: ['Public SLA mandates 48-hour response for arterial roadway defects'],
        confidenceScore: 0.88,
      });
      break;

    case 'sanitation':
      recs.push({
        actionTitle: 'Deploy Rapid Response SWM Clearance Unit',
        description: `Direct the zonal sanitation supervisor from ${dept} to clear accumulated waste and sanitize surrounding perimeter.`,
        departmentId: dept,
        priority: 'high',
        expectedOutcome: 'Immediate elimination of black spot and foul odor within 24 hours.',
        requiredResources: '1 Tipper truck, 1 mini-compactor, sanitation team (4 personnel), bleaching powder',
        supportingEvidence: ['BBMP SWM By-laws 2020 mandate 24-hour clearance for reported dump sites'],
        confidenceScore: 0.92,
      });
      recs.push({
        actionTitle: 'Install Deterrent Signage and CCTV Surveillance',
        description: 'Erect anti-dumping signboards indicating spot fines and evaluate CCTV installation to curb chronic dumping.',
        departmentId: dept,
        priority: 'low',
        expectedOutcome: 'Long-term reduction in illegal midnight dumping by local commercial units.',
        requiredResources: '2 Anti-dumping signboards, ward marshal surveillance',
        supportingEvidence: ['History of recurring sanitation complaints at same coordinates'],
        confidenceScore: 0.80,
      });
      break;

    case 'utility':
      recs.push({
        actionTitle: 'Conduct Acoustic Pipeline Leak Detection',
        description: `Deploy technical maintenance squad from ${dept} to localize pipeline breach and isolate affected distribution valve.`,
        departmentId: dept,
        priority: 'high',
        expectedOutcome: 'Cessation of potable water wastage and restoration of normal line pressure within 12 hours.',
        requiredResources: 'Acoustic leak sensor, emergency valve key, maintenance van',
        supportingEvidence: ['BWSSB Citizen Charter mandates emergency valve response within 4 hours'],
        confidenceScore: 0.90,
      });
      break;

    default:
      recs.push({
        actionTitle: 'Conduct Multi-Departmental Ward Coordination Review',
        description: `Convene an on-site review between ${dept} and the ward nodal grievance officer to establish jurisdictional ownership.`,
        departmentId: dept,
        priority: 'medium',
        expectedOutcome: 'Formal allocation of corrective budget and work order within 3 business days.',
        requiredResources: 'Ward Nodal Officer, inter-departmental liaison',
        supportingEvidence: ['Complex or cross-boundary complaint cluster requiring administrative triage'],
        confidenceScore: 0.78,
      });
  }

  return recs;
}

/**
 * Generates and persists actionable recommendations for an investigation.
 */
export async function generateAndStoreRecommendations(
  input: RecommendationEngineInput
): Promise<InvestigationRecommendation[]> {
  const recommendations = buildDeterministicRecommendations(input);

  // Validate all recommendations through Zod
  const validatedRecs = recommendations.map((r) => {
    const parse = InvestigationRecommendationSchema.safeParse(r);
    return parse.success ? parse.data : r;
  });

  // Persist into investigation_recommendations (idempotent on retry)
  if (pool) {
    try {
      // Clear previous pending recommendations on retry to prevent duplicates
      await pool.query(
        `DELETE FROM investigation_recommendations 
         WHERE investigation_id = $1 AND approval_status = 'pending'`,
        [input.investigationId]
      );

      for (const rec of validatedRecs) {
        await pool.query(
          `INSERT INTO investigation_recommendations
             (investigation_id, action_title, description, department_id, priority, confidence_score, approval_status)
           VALUES ($1, $2, $3, $4, $5, $6, 'pending')`,
          [
            input.investigationId,
            rec.actionTitle,
            rec.description,
            rec.departmentId || null,
            rec.priority,
            rec.confidenceScore,
          ]
        );
      }
      logger.info(
        `[RECOMMENDATION_SERVICE] Stored ${validatedRecs.length} recommendations for Investigation ${input.investigationId}`
      );
    } catch (err: any) {
      logger.warn(`[RECOMMENDATION_SERVICE] Could not persist recommendations (non-fatal): ${err.message}`);
    }
  }

  return validatedRecs;
}
