// backend/src/services/investigation/types.ts
//
// Phase 4 — Autonomous Civic Investigation Agent Data Types & Zod Schemas
//
// Defines structured types and runtime validation schemas for evidence,
// public research, department identification, investigation findings,
// actionable recommendations, and full reports.

import { z } from 'zod';

// ── Status Enums ─────────────────────────────────────────────────────────────

export const InvestigationStatusEnum = z.enum([
  'pending',
  'running',
  'completed',
  'failed',
  'review_pending',
  'approved',
  'rejected',
  'resolved',
]);
export type InvestigationStatus = z.infer<typeof InvestigationStatusEnum>;

export const InvestigationPriorityEnum = z.enum(['low', 'medium', 'high', 'critical']);
export type InvestigationPriority = z.infer<typeof InvestigationPriorityEnum>;

export const EvidenceTypeEnum = z.enum([
  'complaint',
  'media',
  'public_source',
  'historical',
  'department_policy',
]);
export type EvidenceType = z.infer<typeof EvidenceTypeEnum>;

export const VerificationStatusEnum = z.enum(['verified', 'unverified', 'ai_inferred']);
export type VerificationStatus = z.infer<typeof VerificationStatusEnum>;

export const ReviewStatusEnum = z.enum(['pending', 'approved', 'rejected', 'revision_requested']);
export type ReviewStatus = z.infer<typeof ReviewStatusEnum>;

export const RecommendationApprovalEnum = z.enum(['pending', 'approved', 'rejected', 'modified']);
export type RecommendationApproval = z.infer<typeof RecommendationApprovalEnum>;

// ── Evidence Item ─────────────────────────────────────────────────────────────

export const EvidenceItemSchema = z.object({
  complaintId: z.number().nullable().optional(),
  mediaId: z.number().nullable().optional(),
  evidenceType: EvidenceTypeEnum,
  sourceUrl: z.string().url().nullable().optional(),
  sourceTitle: z.string().nullable().optional(),
  evidenceDescription: z.string().min(1),
  verificationStatus: VerificationStatusEnum,
  retrievedAt: z.string().optional(),
});
export type EvidenceItem = z.infer<typeof EvidenceItemSchema>;

// ── Public Research Source ───────────────────────────────────────────────────

export const PublicResearchSourceSchema = z.object({
  sourceUrl: z.string(),
  sourceTitle: z.string(),
  excerpt: z.string(),
  policyCode: z.string().optional(),
  jurisdiction: z.string().optional(),
  retrievedAt: z.string(),
  sourceOrigin: z.enum(['statutory_reference_benchmark', 'external_web_crawl']).optional(),
});
export interface PublicResearchSource {
  sourceUrl: string;
  sourceTitle: string;
  excerpt: string;
  policyCode?: string;
  jurisdiction?: string;
  retrievedAt: string;
  sourceOrigin?: 'statutory_reference_benchmark' | 'external_web_crawl';
}

// ── Department Match ─────────────────────────────────────────────────────────

export const DepartmentMatchSchema = z.object({
  suggestedDepartment: z.string().min(1),
  reasoning: z.string().min(1),
  confidenceScore: z.number().min(0).max(1),
  supportingEvidence: z.array(z.string()).default([]),
  alternativeDepartment: z.string().nullable().optional(),
  needsHumanVerification: z.boolean().optional(),
  jurisdictionLevel: z.enum(['verified', 'provisional', 'unverified']).optional(),
});
export interface DepartmentMatch {
  suggestedDepartment: string;
  reasoning: string;
  confidenceScore: number;
  supportingEvidence: string[];
  alternativeDepartment?: string | null;
  needsHumanVerification?: boolean;
  jurisdictionLevel?: 'verified' | 'provisional' | 'unverified';
}

// ── AI Investigation Findings ────────────────────────────────────────────────

export const InvestigationFindingsSchema = z.object({
  investigationSummary: z.string().min(10).max(3000),
  problemDescription: z.string().min(10).max(3000),
  geographicImpact: z.string().min(5),
  affectedPopulationEstimate: z.string().min(1),
  complaintTrends: z.string().min(5),
  severityAssessment: z.string().min(5),
  potentialCauses: z.array(z.string()).min(1),
  missingInformation: z.array(z.string()).default([]),
  humanVerificationRequirements: z.array(z.string()).default([]),
  confidenceLevel: z.number().min(0).max(1),
});
export type InvestigationFindings = z.infer<typeof InvestigationFindingsSchema>;

// ── Recommendation Item ──────────────────────────────────────────────────────

export const InvestigationRecommendationSchema = z.object({
  actionTitle: z.string().min(3).max(200),
  description: z.string().min(10).max(2000),
  departmentId: z.string().optional(),
  priority: InvestigationPriorityEnum.default('medium'),
  expectedOutcome: z.string().min(5),
  requiredResources: z.string().optional(),
  supportingEvidence: z.array(z.string()).default([]),
  confidenceScore: z.number().min(0).max(1),
});
export type InvestigationRecommendation = z.infer<typeof InvestigationRecommendationSchema>;

// ── Full Investigation Report JSON ───────────────────────────────────────────

export const InvestigationReportSchema = z.object({
  investigationId: z.number(),
  clusterId: z.number(),
  clusterTitle: z.string(),
  category: z.string(),
  region: z.string(),
  priority: InvestigationPriorityEnum,
  generatedAt: z.string(),
  findings: InvestigationFindingsSchema,
  departmentMatch: DepartmentMatchSchema,
  recommendations: z.array(InvestigationRecommendationSchema),
  evidenceSummary: z.object({
    totalComplaints: z.number(),
    mediaAttachments: z.number(),
    publicSourcesChecked: z.number(),
  }),
  humanReviewNotes: z.string().nullable().optional(),
});
export type InvestigationReport = z.infer<typeof InvestigationReportSchema>;
