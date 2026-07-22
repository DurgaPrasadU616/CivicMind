// backend/src/services/recommendations.ts
//
// Generates LLM-powered (Gemini) or rule-based recommended actions for clusters.
// Triggered asynchronously — never blocks complaint submission.

import { GoogleGenerativeAI } from '@google/generative-ai';
import { pool } from '../config/db';

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
  return `Escalate to ${dept} department — ${complaintCount} complaint${complaintCount !== 1 ? 's' : ''} in ${region}`;
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
  sampleTexts: string[]
): Promise<string> => {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error('GEMINI_API_KEY not configured');
  }

  const genAI = new GoogleGenerativeAI(apiKey);
  const model = genAI.getGenerativeModel({ model: 'gemini-2.0-flash' });

  const prompt = `You are a civic issue management assistant for a city administration dashboard.
A cluster of ${complaintCount} related ${category} complaint(s) in the ${region} area has reached ${severityBand} severity.
${sampleTexts.length > 0 ? `Sample complaints:\n${sampleTexts.map((t, i) => `${i + 1}. "${t}"`).join('\n')}` : ''}

Provide a concise, actionable recommended action for city officials (1-2 sentences, max 150 characters).
Be specific about the category and region. Do not include quotes in your response.`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), GEMINI_TIMEOUT_MS);

  try {
    const result = await model.generateContent(prompt, { signal: controller.signal });
    clearTimeout(timeout);
    const text = result.response.text().trim();
    // Clamp to 300 chars to keep it dashboard-friendly
    return text.length > 300 ? text.slice(0, 297) + '...' : text;
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
  generatedBy: 'gemini' | 'rule_based'
): Promise<void> => {
  if (!pool) return;

  // Mark previous active actions as superseded
  await pool.query(
    `UPDATE recommended_action SET status = 'superseded' WHERE cluster_id = $1 AND status = 'active'`,
    [clusterId]
  );

  // Insert new action
  await pool.query(
    `INSERT INTO recommended_action (cluster_id, action_text, generated_by, status)
     VALUES ($1, $2, $3, 'active')`,
    [clusterId, actionText, generatedBy]
  );

  // Also keep cluster.recommended_action in sync (backward compat for existing query)
  await pool.query(
    `UPDATE cluster SET recommended_action = $1 WHERE id = $2`,
    [actionText, clusterId]
  );

  console.log(`[RECOMMENDATIONS] Stored ${generatedBy} action for Cluster ${clusterId}`);
};

// ---------------------------------------------------------------------------
// Main entry: generate and store
// ---------------------------------------------------------------------------

export const generateRecommendedAction = async (clusterId: number): Promise<void> => {
  if (!pool) return;

  try {
    // Fetch cluster context
    const clusterRes = await pool.query(
      `SELECT category, region, complaint_count, severity_score FROM cluster WHERE id = $1`,
      [clusterId]
    );
    if (clusterRes.rows.length === 0) return;

    const { category, region, complaint_count, severity_score } = clusterRes.rows[0];
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

    try {
      actionText = await generateWithGemini(category, region, count, band, sampleTexts);
      generatedBy = 'gemini';
      console.log(`[RECOMMENDATIONS] Gemini action generated for Cluster ${clusterId}`);
    } catch (geminiError) {
      console.warn(
        `[RECOMMENDATIONS] Gemini failed for Cluster ${clusterId}, using rule-based fallback:`,
        (geminiError as Error).message
      );
      actionText = buildRuleBasedAction(category, region, count);
      generatedBy = 'rule_based';
    }

    await storeAction(clusterId, actionText, generatedBy);
  } catch (err) {
    // Swallow errors — this runs in background, must not surface to the caller
    console.error(`[RECOMMENDATIONS] Background generation failed for Cluster ${clusterId}:`, err);
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
      console.log(
        `[RECOMMENDATIONS] No escalation for Cluster ${clusterId} (${previousBand} → ${newBand}). Skipping generation.`
      );
      return;
    }

    console.log(
      `[RECOMMENDATIONS] Band escalation detected for Cluster ${clusterId}: ${previousBand ?? 'new'} → ${newBand}. Queuing generation.`
    );

    // Fire-and-forget: do NOT await — keeps complaint submission fast
    setImmediate(() => {
      generateRecommendedAction(clusterId).catch((err) => {
        console.error(`[RECOMMENDATIONS] setImmediate generation error for Cluster ${clusterId}:`, err);
      });
    });
  } catch (err) {
    console.error(`[RECOMMENDATIONS] triggerRecommendationIfNeeded error for Cluster ${clusterId}:`, err);
  }
};
