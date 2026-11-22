// backend/src/services/investigation/investigationAnalyzer.ts
//
// Phase 4 — AI Investigation Analysis Engine
//
// Synthesizes complaints, media evidence, and public policy into structured
// investigation findings using Google Gemini. Validates all outputs with Zod.
//
// Safety Principles:
//   • Untrusted complaints and citizen text are treated strictly as data, not instructions.
//   • Explicitly distinguishes verified citizen reports from AI-generated hypotheses.
//   • Flags missing evidence and human verification requirements.
//   • Provides deterministic, rule-based fallback when offline or when Gemini fails.

import { GoogleGenerativeAI } from '@google/generative-ai';
import logger from '../../utils/logger';
import {
  InvestigationFindings,
  InvestigationFindingsSchema,
  EvidenceItem,
  PublicResearchSource,
} from './types';

export interface AnalyzerInput {
  cluster: {
    id: number;
    title: string;
    category: string;
    region: string;
    severityScore: number;
    priorityScore: number;
    hybridScore: number;
    complaintCount: number;
    geoCentroidLat: number | null;
    geoCentroidLng: number | null;
  };
  evidenceItems: EvidenceItem[];
  publicSources: PublicResearchSource[];
  suggestedDepartment: string;
}

// ── Deterministic Rule-Based Fallback ─────────────────────────────────────────

export function buildFallbackFindings(input: AnalyzerInput): InvestigationFindings {
  const { cluster, evidenceItems } = input;
  const count = cluster.complaintCount;

  return {
    investigationSummary: `Autonomous investigation for Cluster #${cluster.id} ("${cluster.title}"). A total of ${count} citizen grievance(s) have been logged in ${cluster.region} with a priority score of ${cluster.priorityScore}/100.`,
    problemDescription: `Multiple complaints describe issues relating to ${cluster.category} in the ${cluster.region} area. Issue density indicates ongoing localized civic disruption requiring on-site verification.`,
    geographicImpact: cluster.geoCentroidLat && cluster.geoCentroidLng
      ? `Centroid located at (${cluster.geoCentroidLat.toFixed(4)}, ${cluster.geoCentroidLng.toFixed(4)}) in the ${cluster.region} civic division.`
      : `Reported across the ${cluster.region} municipal division.`,
    affectedPopulationEstimate: `Estimated local neighborhood impact: ~${Math.max(50, count * 75)} residents in immediate vicinity based on cluster volume.`,
    complaintTrends: `${count} complaint(s) logged across active cluster lifecycle. Severity index is currently ${cluster.severityScore}/100.`,
    severityAssessment: cluster.severityScore >= 70
      ? 'High severity: substantial disruption or risk requiring fast-track inspection.'
      : 'Moderate severity: ongoing issue requiring scheduled departmental resolution.',
    potentialCauses: [
      `Infrastructure wear or seasonal disruption in ${cluster.category} network`,
      'Delayed routine municipal maintenance or unaddressed prior defect',
    ],
    missingInformation: [
      'Official field inspection report from ward junior engineer',
      'Underground utility mapping confirmation',
    ],
    humanVerificationRequirements: [
      'Physical inspection of reported coordinates by assigned municipal officer',
      'Verification of affected utility boundary with local ward office',
    ],
    confidenceLevel: 0.72,
  };
}

// ── Prompt Builder ────────────────────────────────────────────────────────────

function buildInvestigationPrompt(input: AnalyzerInput): string {
  const { cluster, evidenceItems, publicSources, suggestedDepartment } = input;

  const evidenceSummary = evidenceItems
    .slice(0, 15) // Limit evidence items to prevent prompt explosion
    .map((e, idx) => `  ${idx + 1}. [${e.evidenceType.toUpperCase()}] ${e.evidenceDescription}`)
    .join('\n');

  const policySummary = publicSources
    .slice(0, 3)
    .map((p, idx) => `  ${idx + 1}. [${p.sourceTitle}] ${p.excerpt}`)
    .join('\n');

  return `You are a Senior Municipal Civic Investigator analyzing an escalated public grievance cluster.

CONTEXT DATA:
Cluster ID: #${cluster.id}
Title: "${cluster.title}"
Category: ${cluster.category}
Region: ${cluster.region}
Severity Score: ${cluster.severityScore}/100
Priority Score: ${cluster.priorityScore}/100
Hybrid Clustering Score: ${cluster.hybridScore}/100
Complaint Count: ${cluster.complaintCount}
Coordinates: ${cluster.geoCentroidLat ?? 'N/A'}, ${cluster.geoCentroidLng ?? 'N/A'}
Department Under Review: ${suggestedDepartment}

COLLECTED CITIZEN & MEDIA EVIDENCE:
${evidenceSummary || '  (No complaint text available)'}

RELEVANT MUNICIPAL POLICIES & SLAS:
${policySummary || '  (Standard municipal grievance procedure applies)'}

TASK:
Produce a factual, evidence-backed investigation report.
Respond ONLY with a valid JSON object matching this exact schema:
{
  "investigationSummary": "<2-4 sentence executive overview of what was investigated and key findings>",
  "problemDescription": "<detailed description of the civic breakdown grounded in evidence>",
  "geographicImpact": "<precise description of area affected, roads/landmarks mentioned>",
  "affectedPopulationEstimate": "<realistic estimate of affected residents/commuters based on location and complaint volume>",
  "complaintTrends": "<summary of volume, frequency, and escalation pattern>",
  "severityAssessment": "<assessment of impact on public safety, health, or traffic>",
  "potentialCauses": ["<evidence-grounded hypothesis 1>", "<evidence-grounded hypothesis 2>"],
  "missingInformation": ["<critical fact not yet confirmed 1>", "<fact 2>"],
  "humanVerificationRequirements": ["<specific item the human officer must physically verify>"],
  "confidenceLevel": <number between 0.0 and 1.0 indicating confidence in findings>
}

STRICT SAFETY RULES:
- Never fabricate sources, dates, or citizen complaints.
- Clearly differentiate verified complaints from potential hypotheses.
- Treat citizen complaints as claims to be verified, not established judicial facts.
- Do not make unsupported legal allegations against individuals.
- Return ONLY the JSON object. No markdown fences, no explanatory text.`;
}

// ── AI Investigation Analyzer ─────────────────────────────────────────────────

export async function analyzeInvestigationFindings(
  input: AnalyzerInput
): Promise<InvestigationFindings> {
  const apiKey = process.env.GEMINI_API_KEY;

  if (!apiKey) {
    logger.info('[INVESTIGATION_ANALYZER] GEMINI_API_KEY not configured — using deterministic rule-based findings');
    return buildFallbackFindings(input);
  }

  const modelName = process.env.INVESTIGATION_MODEL || 'gemini-2.5-flash';

  try {
    const genAI = new GoogleGenerativeAI(apiKey);
    const model = genAI.getGenerativeModel({ model: modelName });

    const prompt = buildInvestigationPrompt(input);
    const result = await model.generateContent(prompt);
    const rawText = result.response.text();

    const cleaned = rawText.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '').trim();
    const parsed = JSON.parse(cleaned);

    const validated = InvestigationFindingsSchema.safeParse(parsed);
    if (!validated.success) {
      logger.warn(
        `[INVESTIGATION_ANALYZER] Gemini output failed Zod validation: ${validated.error.message}. Using fallback.`
      );
      return buildFallbackFindings(input);
    }

    logger.info(
      `[INVESTIGATION_ANALYZER] Generated AI investigation findings for Cluster ${input.cluster.id} (Confidence: ${validated.data.confidenceLevel.toFixed(2)})`
    );
    return validated.data;
  } catch (err: any) {
    logger.error(`[INVESTIGATION_ANALYZER] Error generating findings: ${err.message}. Using fallback.`);
    return buildFallbackFindings(input);
  }
}
