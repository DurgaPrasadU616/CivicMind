// backend/src/services/actions/resolutionVerification.ts
//
// Phase 5 — Resolution Evidence Upload & AI Comparison Service
//
// Responsibilities:
//   - uploadResolutionEvidence — Reuses Phase 3 StorageProvider + validateFileBuffer
//   - runAIEvidenceComparison  — Fetches before/after images, sends to Gemini,
//                                returns structured JSON comparison
//   - verifyResolution         — Human reviewer confirms RESOLVED or returns to IN_PROGRESS
//   - reopenAction             — From RESOLVED or AWAITING_VERIFICATION → REOPENED

import path from 'path';
import { randomUUID } from 'crypto';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { pool } from '../../config/db';
import logger from '../../utils/logger';
import { getStorageProvider } from '../storage';
import { validateMediaUpload, sanitizeFilename } from '../../utils/fileValidation';
import { SUPPORTED_IMAGE_TYPES } from '../mediaAnalysis';
import { ResolutionEvidence, VerifyResolutionInput } from './types';
import { updateActionStatus } from './actionService';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface EvidenceComparisonResult {
  observedChanges:          string[];
  unresolvedIssues:         string[];
  confidenceScore:          number;
  limitations:              string[];
  requiresHumanVerification: boolean;
  analysisText:             string;
}

// ── uploadResolutionEvidence ──────────────────────────────────────────────────

export async function uploadResolutionEvidence(
  actionId: number,
  file: {
    buffer:   Buffer;
    mimetype: string;
    originalname: string;
    size:     number;
  },
  evidenceType: 'before' | 'after' | 'progress' | 'completion_report',
  uploadedBy:   number | null,
  description?: string
): Promise<ResolutionEvidence> {
  if (!pool) throw new Error('Database not available');

  // Validate the file (MIME type + magic bytes + size limit — images only for resolution evidence)
  const validation = validateMediaUpload(file.buffer, file.mimetype, file.originalname);
  if (!validation.valid) {
    throw new Error(`Invalid file: ${validation.error}`);
  }
  if (!SUPPORTED_IMAGE_TYPES.has(file.mimetype)) {
    throw new Error(`Resolution evidence must be an image (jpeg, png, webp, gif). Got: ${file.mimetype}`);
  }

  // Build a path-traversal-safe storage key
  const safeFilename = sanitizeFilename(file.originalname);
  const ext = path.extname(safeFilename) || '.jpg';
  const storageKey = `resolution-evidence/${actionId}/${evidenceType}/${randomUUID()}${ext}`;

  // Persist to storage provider
  const storage = getStorageProvider();
  await storage.put(storageKey, file.buffer, file.mimetype);

  // Insert into DB
  const result = await pool.query(
    `INSERT INTO resolution_evidence
       (action_id, evidence_type, storage_key, original_filename, mime_type,
        file_size, uploaded_by, description)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     RETURNING *`,
    [
      actionId,
      evidenceType,
      storageKey,
      safeFilename,
      file.mimetype,
      file.size,
      uploadedBy,
      description ?? null,
    ]
  );

  logger.info(
    `[RESOLUTION_VERIFICATION] Evidence "${evidenceType}" uploaded for action #${actionId} (key=${storageKey})`
  );

  return result.rows[0] as unknown as ResolutionEvidence;
}

// ── runAIEvidenceComparison ───────────────────────────────────────────────────

export async function runAIEvidenceComparison(
  actionId: number
): Promise<EvidenceComparisonResult> {
  if (!pool) throw new Error('Database not available');

  // Fetch before and after evidence records
  const evidenceRes = await pool.query(
    `SELECT * FROM resolution_evidence
     WHERE action_id = $1
       AND evidence_type IN ('before', 'after')
       AND mime_type LIKE 'image/%'
     ORDER BY evidence_type ASC, created_at DESC`,
    [actionId]
  );

  const records: ResolutionEvidence[] = evidenceRes.rows as unknown as ResolutionEvidence[];
  const before = records.find((r) => r.evidence_type === 'before');
  const after  = records.find((r) => r.evidence_type === 'after');

  const fallback: EvidenceComparisonResult = {
    observedChanges:          [],
    unresolvedIssues:         ['Insufficient evidence for AI comparison — human review required'],
    confidenceScore:          0,
    limitations:              ['Missing before or after image'],
    requiresHumanVerification: true,
    analysisText:             'AI comparison could not proceed — provide both "before" and "after" images.',
  };

  if (!before || !after) {
    logger.warn(`[RESOLUTION_VERIFICATION] Cannot compare: missing before=${!before} after=${!after} for action #${actionId}`);
    return fallback;
  }

  if (!process.env.GEMINI_API_KEY) {
    logger.warn('[RESOLUTION_VERIFICATION] GEMINI_API_KEY not set — using fallback comparison');
    return fallback;
  }

  try {
    const storage = getStorageProvider();
    const [beforeBuf, afterBuf] = await Promise.all([
      storage.get(before.storage_key),
      storage.get(after.storage_key),
    ]);

    const model = new GoogleGenerativeAI(process.env.GEMINI_API_KEY)
      .getGenerativeModel({ model: process.env.MEDIA_ANALYSIS_MODEL || 'gemini-2.5-flash' });

    const prompt = `You are a civic issue resolution verification assistant. Compare these two images:
- Image 1 (BEFORE): state of the civic issue before resolution work.
- Image 2 (AFTER): state of the same location after resolution work.

Respond ONLY with valid JSON matching exactly this schema:
{
  "observedChanges": ["<visible change 1>", "<visible change 2>"],
  "unresolvedIssues": ["<remaining issue if any>"],
  "confidenceScore": <0.0 to 1.0 — confidence that the issue was resolved>,
  "limitations": ["<what could not be determined from these images>"],
  "requiresHumanVerification": <true if confidence < 0.7 or significant issues remain>,
  "analysisText": "<2-4 sentence summary of your findings>"
}

STRICT RULES:
- Only describe what is DIRECTLY VISIBLE in the images. Never infer.
- Do NOT declare the issue resolved unless clearly visible in the AFTER image.
- If the images are unrelated or inconsistent, set confidenceScore below 0.3.
- Return only valid JSON. No markdown, no explanation.`;

    const toBase64Part = (buf: Buffer, mime: string) => ({
      inlineData: { data: buf.toString('base64'), mimeType: mime },
    });

    const result = await model.generateContent([
      prompt,
      toBase64Part(beforeBuf, before.mime_type || 'image/jpeg'),
      toBase64Part(afterBuf, after.mime_type || 'image/jpeg'),
    ]);

    const raw = result.response.text().trim();
    const cleaned = raw
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/\s*```\s*$/i, '')
      .trim();

    const parsed = JSON.parse(cleaned);

    const comparison: EvidenceComparisonResult = {
      observedChanges:          Array.isArray(parsed.observedChanges) ? parsed.observedChanges : [],
      unresolvedIssues:         Array.isArray(parsed.unresolvedIssues) ? parsed.unresolvedIssues : [],
      confidenceScore:          typeof parsed.confidenceScore === 'number'
        ? Math.min(1, Math.max(0, parsed.confidenceScore))
        : 0,
      limitations:              Array.isArray(parsed.limitations) ? parsed.limitations : [],
      requiresHumanVerification: parsed.requiresHumanVerification !== false,
      analysisText:             typeof parsed.analysisText === 'string' ? parsed.analysisText : '',
    };

    // Store AI analysis result against the "after" evidence record
    await pool.query(
      `UPDATE resolution_evidence
       SET ai_analysis = $1, ai_confidence_score = $2,
           needs_human_review = $3
       WHERE id = $4`,
      [
        JSON.stringify(comparison),
        comparison.confidenceScore,
        comparison.requiresHumanVerification,
        after.id,
      ]
    );

    logger.info(
      `[RESOLUTION_VERIFICATION] AI comparison complete for action #${actionId} — confidence=${comparison.confidenceScore}`
    );

    return comparison;
  } catch (err: any) {
    logger.error(`[RESOLUTION_VERIFICATION] AI comparison failed for action #${actionId}: ${err.message}`);
    return { ...fallback, limitations: [`AI error: ${err.message}`] };
  }
}

// ── verifyResolution ──────────────────────────────────────────────────────────

export async function verifyResolution(
  actionId: number,
  reviewerId: number,
  input: VerifyResolutionInput
): Promise<{ resolved: boolean; newStatus: string }> {
  if (!pool) throw new Error('Database not available');

  // Current action must be awaiting_verification
  const res = await pool.query('SELECT status FROM civic_actions WHERE id = $1', [actionId]);
  if (res.rows.length === 0) throw new Error(`Action #${actionId} not found`);

  const currentStatus = res.rows[0].status as string;
  if (currentStatus !== 'awaiting_verification') {
    throw new Error(
      `Action #${actionId} must be in "awaiting_verification" state to verify (current: "${currentStatus}")`
    );
  }

  if (input.approved) {
    await updateActionStatus(actionId, 'resolved', reviewerId, input.notes || 'Human reviewer confirmed resolution');

    // Mark all evidence as verified
    await pool.query(
      `UPDATE resolution_evidence
       SET verification_status = 'verified', verified_at = NOW(), verified_by = $1
       WHERE action_id = $2`,
      [reviewerId, actionId]
    );

    logger.info(`[RESOLUTION_VERIFICATION] Action #${actionId} RESOLVED by reviewer #${reviewerId}`);
    return { resolved: true, newStatus: 'resolved' };
  } else {
    // Return to in_progress for further work
    await updateActionStatus(
      actionId,
      'in_progress',
      reviewerId,
      input.notes || 'Reviewer requires further work before resolution'
    );

    logger.info(`[RESOLUTION_VERIFICATION] Action #${actionId} returned to in_progress by reviewer #${reviewerId}`);
    return { resolved: false, newStatus: 'in_progress' };
  }
}

// ── reopenAction ──────────────────────────────────────────────────────────────

export async function reopenAction(
  actionId: number,
  reason: string,
  officerId: number
): Promise<{ newStatus: string }> {
  const res = await pool!.query('SELECT status FROM civic_actions WHERE id = $1', [actionId]);
  if (res.rows.length === 0) throw new Error(`Action #${actionId} not found`);

  const currentStatus = res.rows[0].status as string;
  if (!['resolved', 'awaiting_verification'].includes(currentStatus)) {
    throw new Error(
      `Action #${actionId} can only be reopened from "resolved" or "awaiting_verification" (current: "${currentStatus}")`
    );
  }

  await updateActionStatus(actionId, 'reopened', officerId, reason);
  logger.info(`[RESOLUTION_VERIFICATION] Action #${actionId} REOPENED by user #${officerId}`);
  return { newStatus: 'reopened' };
}
