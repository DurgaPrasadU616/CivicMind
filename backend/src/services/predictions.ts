import { GoogleGenerativeAI } from '@google/generative-ai';
import { env } from '../config/env';
import logger from '../utils/logger';
import { pool } from '../config/db';

const genAI = env.GEMINI_API_KEY ? new GoogleGenerativeAI(env.GEMINI_API_KEY) : null;

// Uses configured GEMINI_MODEL with fallback to gemini-2.5-flash
const model = genAI?.getGenerativeModel({ model: process.env.GEMINI_MODEL || env.GEMINI_MODEL || 'gemini-2.5-flash' });

export interface PredictionResult {
  category: string;
  forecast: string; // e.g., 'Increasing', 'Stable', 'Decreasing'
  riskLevel: 'Low' | 'Medium' | 'High' | 'Critical';
  confidenceScore: number; // 0-100
  reasoning: string;
  preventativeActions: string[];
}

export const generateCityPredictions = async (): Promise<PredictionResult[]> => {
  if (!pool) {
    throw new Error('Database service is unavailable.');
  }

  // 1. Gather historical data from DB to provide context to Gemini
  const recentClustersRes = await pool.query(`
    SELECT category, COUNT(*) as count, AVG(severity_score) as avg_severity
    FROM cluster
    WHERE created_at >= NOW() - INTERVAL '30 days'
    GROUP BY category
  `);
  
  const historicalContext = recentClustersRes.rows.map(r => 
    `Category: ${r.category}, Incidents last 30 days: ${r.count}, Average Severity: ${parseFloat(r.avg_severity).toFixed(2)}`
  ).join('\n');

  if (!model) {
    logger.warn('[PREDICTIONS] Gemini API key not found. Using rule-based fallback predictions.');
    return generateFallbackPredictions(recentClustersRes.rows);
  }

  const prompt = `
    You are an expert Smart City AI predictive engine.
    Based on the following incident data over the last 30 days:
    ${historicalContext}
    
    Predict the future trends for these categories, specifically analyzing complaint growth, infrastructure risks (like flood or road damage), and service demand.
    
    Output a strictly formatted JSON array of objects, with NO markdown formatting, NO backticks. Each object must have these exact keys:
    - "category": string (e.g. "flood", "noise", "sanitation")
    - "forecast": string ("Increasing", "Stable", or "Decreasing")
    - "riskLevel": string ("Low", "Medium", "High", or "Critical")
    - "confidenceScore": number (0-100)
    - "reasoning": string (1-2 sentences explaining why)
    - "preventativeActions": string array (2-3 recommended actions)
  `;

  try {
    const result = await model.generateContent(prompt);
    let responseText = result.response.text();
    
    // Strip markdown blocks if present
    responseText = responseText.replace(/^```json\s*/, '').replace(/```$/, '').trim();
    
    const parsed = JSON.parse(responseText);
    return parsed as PredictionResult[];
  } catch (error) {
    logger.error('[PREDICTIONS] Error generating AI predictions:', error);
    return generateFallbackPredictions(recentClustersRes.rows);
  }
};

const generateFallbackPredictions = (data: any[]): PredictionResult[] => {
  return data.map(r => {
    const count = parseInt(r.count, 10);
    const avgSeverity = parseFloat(r.avg_severity);
    
    let riskLevel: 'Low' | 'Medium' | 'High' | 'Critical' = 'Low';
    if (avgSeverity > 80) riskLevel = 'Critical';
    else if (avgSeverity > 60) riskLevel = 'High';
    else if (avgSeverity > 40) riskLevel = 'Medium';
    
    let forecast = 'Stable';
    if (count > 10) forecast = 'Increasing';

    return {
      category: r.category,
      forecast,
      riskLevel,
      confidenceScore: 50,
      reasoning: 'Fallback rule-based prediction due to AI unavailability.',
      preventativeActions: ['Monitor closely', 'Allocate standard resources'],
    };
  });
};
