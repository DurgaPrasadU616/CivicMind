// backend/src/services/recommendations.ts
//
// Generates LLM-powered (Gemini) or rule-based recommended actions for clusters.
// Triggered asynchronously — never blocks complaint submission.

import { GoogleGenerativeAI } from '@google/generative-ai';
import { pool } from '../config/db';
import logger from '../utils/logger';
import { backgroundQueue } from './backgroundQueue';

// ---------------------------------------------------------------------------
// Severity band helpers
// ---------------------------------------------------------------------------

export type SeverityBand = 'low' | 'medium' | 'high';

export const getSeverityBand = (score: number): SeverityBand => {
  if (score >= 75) return 'high';
  if (score >= 40) return 'medium';
  return 'low';
};

/** Returns true if the new band represents an escalation (upward movement). */
export const isBandEscalation = (
  previousBand: SeverityBand | null,
  newBand: SeverityBand
): boolean => {
  if (previousBand === null) return true; // new cluster — always generate
  const order: SeverityBand[] = ['low', 'medium', 'high'];
  return order.indexOf(newBand) > order.indexOf(previousBand);
};

// ---------------------------------------------------------------------------
// Rule-based fallback
// ---------------------------------------------------------------------------

const buildRuleBasedAction = (
  category: string,
  region: string,
  complaintCount: number
): string => {
  const dept =
    category.charAt(0).toUpperCase() + category.slice(1);
  const actionObj = {
    executive_summary: `Escalate to ${dept} department — ${complaintCount} complaint${complaintCount !== 1 ? 's' : ''} in ${region}`,
    root_cause_analysis: 'Requires field inspection to determine root cause.',
    short_term_actions: ['Dispatch immediate inspection team'],
    long_term_actions: ['Develop comprehensive mitigation strategy based on inspection'],
    budget_estimate: 'To be determined after inspection',
    staff_vehicle_requirements: '1 Inspection team (2 personnel), 1 field vehicle',
    environmental_impact: 'Pending assessment'
  };
  return JSON.stringify(actionObj);
};

// ---------------------------------------------------------------------------
// RAG Retrieval Helpers
// ---------------------------------------------------------------------------

const retrievePastClusters = async (clusterId: number, centroid: string) => {
  if (!centroid) return [];
  const res = await pool!.query(`
    SELECT title, category, recommended_action as action_text, 
           updated_at, (1 - (centroid <=> $2::vector)) as similarity 
    FROM cluster 
    WHERE status = 'resolved' AND id != $1 AND centroid IS NOT NULL
    ORDER BY centroid <=> $2::vector 
    LIMIT 3
  `, [clusterId, centroid]);
  // Filter by a basic threshold to avoid returning completely unrelated cases
  return res.rows.filter(r => r.similarity > 0.5);
};

const retrieveGuidelines = async (category: string, centroid: string) => {
  if (!centroid) return [];
  const res = await pool!.query(`
    SELECT title, content, source, (1 - (embedding <=> $2::vector)) as similarity 
    FROM guideline_document 
    WHERE category = $1 AND embedding IS NOT NULL
    ORDER BY embedding <=> $2::vector 
    LIMIT 3
  `, [category, centroid]);
  // Minimum relevance threshold
  return res.rows.filter(r => r.similarity > 0.6);
};

// ---------------------------------------------------------------------------
// Gemini generation
// ---------------------------------------------------------------------------

const GEMINI_TIMEOUT_MS = 5000;

const generateWithGemini = async (
  category: string,
  region: string,
  complaintCount: number,
  severityBand: SeverityBand,
  sampleTexts: string[],
  pastCases: any[],
  guidelines: any[]
): Promise<string> => {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error('GEMINI_API_KEY not configured');
  }

  const genAI = new GoogleGenerativeAI(apiKey);
  const modelName = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
  const model = genAI.getGenerativeModel({ model: modelName });

  const prompt = `You are a civic issue management assistant for a city administration dashboard.

Current Issue:
A cluster of ${complaintCount} related ${category} complaint(s) in the ${region} area has reached ${severityBand} severity.
${sampleTexts.length > 0 ? `Sample complaints:\n${sampleTexts.map((t, i) => `${i + 1}. "${t}"`).join('\n')}` : ''}

${pastCases.length > 0 ? `Similar Past Cases:\n${pastCases.map(c => `- [${c.category}] ${c.title}: Resolved with action -> ${c.action_text}`).join('\n')}\n` : ''}
${guidelines.length > 0 ? `Relevant Guidelines:\n${guidelines.map(g => `- [${g.source}] ${g.title}: ${g.content}`).join('\n')}\n` : ''}

Generate a comprehensive recommendation formatted strictly as a JSON object (without markdown code blocks). It must contain exactly these keys:
- "executive_summary": A concise 1-2 sentence actionable summary.
- "root_cause_analysis": A brief analysis of the likely root cause.
- "short_term_actions": An array of immediate actions (strings).
- "long_term_actions": An array of permanent fixes (strings).
- "budget_estimate": A string estimating the cost (e.g., "$5,000 - $10,000").
- "staff_vehicle_requirements": A string listing required personnel and equipment.
- "environmental_impact": A string assessing the environmental impact.

Base your recommendation primarily on Relevant Guidelines and Similar Past Cases if available. Be specific about the category and region.`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), GEMINI_TIMEOUT_MS);

  try {
    const result = await model.generateContent(prompt, { signal: controller.signal });
    clearTimeout(timeout);
    let text = result.response.text().trim();
    // Strip markdown blocks if present
    text = text.replace(/^```json\s*/, '').replace(/```$/, '').trim();
    return text;
  } catch (err) {
    clearTimeout(timeout);
    throw err;
  }
};

// ---------------------------------------------------------------------------
// Store action with history (mark previous active rows superseded)
// ---------------------------------------------------------------------------

export const storeAction = async (
  clusterId: number,
  actionText: string,
  generatedBy: 'gemini' | 'rule_based',
  retrievedContext?: any,
  confidenceScore?: number
): Promise<void> => {
  if (!pool) return;

  // Mark previous active actions as superseded
  await pool.query(
    `UPDATE recommended_action SET status = 'superseded' WHERE cluster_id = $1 AND status = 'active'`,
    [clusterId]
  );

  // Insert new action
  await pool.query(
    `INSERT INTO recommended_action (cluster_id, action_text, generated_by, status, retrieved_context, confidence_score)
     VALUES ($1, $2, $3, 'active', $4, $5)`,
    [clusterId, actionText, generatedBy, retrievedContext ? JSON.stringify(retrievedContext) : null, confidenceScore]
  );

  // Also keep cluster.recommended_action in sync (backward compat for existing query)
  await pool.query(
    `UPDATE cluster SET recommended_action = $1 WHERE id = $2`,
    [actionText, clusterId]
  );

  logger.info(`[RECOMMENDATIONS] Stored ${generatedBy} action for Cluster ${clusterId}`);
};

// ---------------------------------------------------------------------------
// Main entry: generate and store
// ---------------------------------------------------------------------------

export const generateRecommendedAction = async (clusterId: number): Promise<void> => {
  if (!pool) return;

  try {
    // Fetch cluster context
    const clusterRes = await pool.query(
      `SELECT category, region, complaint_count, severity_score, centroid FROM cluster WHERE id = $1`,
      [clusterId]
    );
    if (clusterRes.rows.length === 0) return;

    const { category, region, complaint_count, severity_score, centroid } = clusterRes.rows[0];
    const count = parseInt(complaint_count, 10);
    const band = getSeverityBand(parseInt(severity_score, 10));

    // Fetch up to 3 sample complaint texts for context
    const sampleRes = await pool.query(
      `SELECT text FROM complaint WHERE cluster_id = $1 LIMIT 3`,
      [clusterId]
    );
    const sampleTexts: string[] = sampleRes.rows.map((r: { text: string }) => r.text);

    let actionText: string;
    let generatedBy: 'gemini' | 'rule_based';
    let retrievedContext: any = null;
    let confidenceScore: number | undefined = undefined;

    try {
      let pastCases: any[] = [];
      let guidelines: any[] = [];
      
      if (centroid) {
        // RAG Retrieval
        pastCases = await retrievePastClusters(clusterId, centroid);
        guidelines = await retrieveGuidelines(category, centroid);
        
        retrievedContext = {
          pastCases: pastCases.map(c => ({ title: c.title, category: c.category, action_text: c.action_text, similarity: c.similarity })),
          guidelines: guidelines.map(g => ({ title: g.title, source: g.source, content: g.content, similarity: g.similarity })),
          coldStart: pastCases.length === 0
        };

        // Calculate confidence score (average of similarities)
        let totalSim = 0;
        let simCount = 0;
        if (pastCases.length > 0) {
          pastCases.forEach(c => totalSim += c.similarity);
          simCount += pastCases.length;
        }
        if (guidelines.length > 0) {
          guidelines.forEach(g => totalSim += g.similarity);
          simCount += guidelines.length;
        }
        
        if (simCount > 0) {
          // Normalize to a 0-100 scale loosely based on the raw cosine similarity (0 to 1)
          // 0.8+ is High, 0.6+ is Med. 
          confidenceScore = Math.min(100, Math.round((totalSim / simCount) * 100));
        } else {
          // Fallback if no context found
          confidenceScore = 40; 
        }
      }

      actionText = await generateWithGemini(category, region, count, band, sampleTexts, pastCases, guidelines);
      generatedBy = 'gemini';
      logger.info(`[RECOMMENDATIONS] Gemini RAG action generated for Cluster ${clusterId} (Confidence: ${confidenceScore})`);
    } catch (geminiError) {
      logger.warn(
        `[RECOMMENDATIONS] Gemini failed for Cluster ${clusterId}, using rule-based fallback:`,
        (geminiError as Error).message
      );
      actionText = buildRuleBasedAction(category, region, count);
      generatedBy = 'rule_based';
      retrievedContext = null;
      confidenceScore = undefined;
    }

    await storeAction(clusterId, actionText, generatedBy, retrievedContext, confidenceScore);
  } catch (err) {
    // Swallow errors — this runs in background, must not surface to the caller
    logger.error(`[RECOMMENDATIONS] Background generation failed for Cluster ${clusterId}:`, err);
  }
};

// ---------------------------------------------------------------------------
// Trigger: called after each severity recalculation
// ---------------------------------------------------------------------------

export const triggerRecommendationIfNeeded = async (
  clusterId: number,
  newSeverity: number
): Promise<void> => {
  if (!pool) return;

  try {
    const clusterRes = await pool.query(
      `SELECT last_severity_band FROM cluster WHERE id = $1`,
      [clusterId]
    );
    if (clusterRes.rows.length === 0) return;

    const previousBand: SeverityBand | null = clusterRes.rows[0].last_severity_band || null;
    const newBand = getSeverityBand(newSeverity);

    // Update the stored band regardless of whether we generate
    await pool.query(
      `UPDATE cluster SET last_severity_band = $1 WHERE id = $2`,
      [newBand, clusterId]
    );

    if (!isBandEscalation(previousBand, newBand)) {
      logger.info(
        `[RECOMMENDATIONS] No escalation for Cluster ${clusterId} (${previousBand} → ${newBand}). Skipping generation.`
      );
      return;
    }

    logger.info(
      `[RECOMMENDATIONS] Band escalation detected for Cluster ${clusterId}: ${previousBand ?? 'new'} → ${newBand}. Queuing generation.`
    );

    backgroundQueue.enqueue(
      `recommendations_for_cluster_${clusterId}`,
      async () => {
        await generateRecommendedAction(clusterId);
      }
    );
  } catch (err) {
    logger.error(`[RECOMMENDATIONS] triggerRecommendationIfNeeded error for Cluster ${clusterId}:`, err);
  }
};
