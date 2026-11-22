// backend/src/services/mediaAnalysis.ts
//
// Phase 3 — Multimodal Civic Intelligence Analysis Service
//
// Analyzes image, audio, and video evidence uploaded with civic complaints
// using the Gemini multimodal API. Produces a structured analysis result
// that is validated with Zod before being stored.
//
// Key safety constraints:
//   • Never claims an image proves something not visibly present.
//   • Never auto-resolves or escalates complaints based on AI analysis.
//   • Sets needsHumanReview=true when confidence is low or AI output is malformed.
//   • Preserves deterministic fallback when Gemini API is unavailable.
//   • Never logs raw media bytes, API keys, or personal data.
//   • Video: extracts up to MAX_VIDEO_FRAMES_SAMPLED REAL frames with FFmpeg
//     (evenly spaced across the clip) and sends those JPEGs to Gemini. Byte
//     offset "sampling" is NOT used — it cannot produce decodable images.
//     If FFmpeg is unavailable, the full video is sent inline (≤ 20 MB);
//     otherwise the result falls back to needsHumanReview=true.
//
// Supported formats (validated by MIME type + magic bytes):
//   Images: image/jpeg, image/png, image/webp, image/gif
//   Audio:  audio/mpeg, audio/mp4, audio/wav, audio/ogg, audio/webm,
//           audio/x-wav, audio/x-m4a
//   Video:  video/mp4, video/webm, video/quicktime
//
// Size limits (bytes):
//   Image: 10 MB   Audio: 25 MB   Video: 50 MB (multer hard cap = video limit)
//
// Duration limits:
//   Video: MAX_VIDEO_DURATION_SECONDS (default 120 s) — enforced at upload time
//          with ffprobe. Rejected with HTTP 400 when exceeded. When ffprobe is
//          not installed the limit cannot be enforced (logged as a warning).
//   Audio: no duration limit is enforced yet (size cap only) — known limitation.
//
// Model used: gemini-2.5-flash (multimodal, vision + audio capable)
//
// Environment variables:
//   GEMINI_API_KEY                (required for live analysis)
//   MEDIA_ANALYSIS_MODEL          (default: gemini-2.5-flash)
//   MEDIA_ANALYSIS_CONFIDENCE_THRESHOLD  (default: 0.60 — below this → needsHumanReview)
//   MAX_VIDEO_FRAMES_SAMPLED      (default: 3)
//   MAX_VIDEO_DURATION_SECONDS    (default: 120)
//   FFMPEG_PATH / FFPROBE_PATH    (default: `ffmpeg` / `ffprobe` on PATH)

import { GoogleGenerativeAI, Part } from '@google/generative-ai';
import { z } from 'zod';
import logger from '../utils/logger';
import {
  extractVideoFrames,
  MAX_VIDEO_FRAMES_SAMPLED,
  MAX_VIDEO_DURATION_SECONDS,
} from '../utils/videoFrames';

export { MAX_VIDEO_FRAMES_SAMPLED, MAX_VIDEO_DURATION_SECONDS };

// ── Constants ─────────────────────────────────────────────────────────────────

export const SUPPORTED_IMAGE_TYPES = new Set([
  'image/jpeg', 'image/png', 'image/webp', 'image/gif',
]);

export const SUPPORTED_AUDIO_TYPES = new Set([
  'audio/mpeg', 'audio/mp4', 'audio/wav', 'audio/ogg', 'audio/webm',
  'audio/x-wav', 'audio/x-m4a',
]);

export const SUPPORTED_VIDEO_TYPES = new Set([
  'video/mp4', 'video/webm', 'video/quicktime',
]);

export const ALL_SUPPORTED_TYPES = new Set([
  ...SUPPORTED_IMAGE_TYPES,
  ...SUPPORTED_AUDIO_TYPES,
  ...SUPPORTED_VIDEO_TYPES,
]);

// Max sizes (bytes)
export const MAX_IMAGE_SIZE_BYTES = parseInt(process.env.MAX_IMAGE_SIZE_BYTES || '', 10) || 10 * 1024 * 1024;   // 10 MB
export const MAX_AUDIO_SIZE_BYTES = parseInt(process.env.MAX_AUDIO_SIZE_BYTES || '', 10) || 25 * 1024 * 1024;   // 25 MB
export const MAX_VIDEO_SIZE_BYTES = parseInt(process.env.MAX_VIDEO_SIZE_BYTES || '', 10) || 50 * 1024 * 1024;   // 50 MB
// MAX_VIDEO_FRAMES_SAMPLED / MAX_VIDEO_DURATION_SECONDS come from
// ../utils/videoFrames (single source of truth) and are re-exported above.

export const CIVIC_CATEGORIES = [
  'infrastructure', 'sanitation', 'utility', 'noise', 'safety', 'other',
] as const;

export type CivicCategory = typeof CIVIC_CATEGORIES[number];

// ── Zod schema for AI analysis output ────────────────────────────────────────

export const MediaAnalysisResultSchema = z.object({
  mediaType: z.enum(['image', 'audio', 'video']),
  description: z.string().min(1).max(2000),
  detectedCategory: z.enum(CIVIC_CATEGORIES).nullable(),
  severityIndicators: z.array(z.string()).default([]),
  confidence: z.number().min(0).max(1),
  needsHumanReview: z.boolean(),
  /**
   * True when the AI pipeline could not produce a result at all (Gemini
   * unreachable, malformed output, missing API key). Distinct from a valid
   * low-confidence result, which stays analysisFailed=false and only sets
   * needsHumanReview=true. Callers persist 'failed' for these so the citizen
   * gets a visible retry instead of a silent empty description.
   */
  analysisFailed: z.boolean().optional(),
  /** Internal reason used to classify retryable versus permanent failures. */
  failureReason: z.string().optional(),
  rawTranscript: z.string().nullable().optional(),   // audio only
  frameCount: z.number().int().optional(),            // video only
});

export type MediaAnalysisResult = z.infer<typeof MediaAnalysisResultSchema>;

// ── Fallback result (used when Gemini is unavailable or analysis fails) ───────

function buildFallbackResult(mediaType: 'image' | 'audio' | 'video', reason: string): MediaAnalysisResult {
  logger.warn(`[MEDIA_ANALYSIS] Using fallback result — ${reason}`);
  return {
    mediaType,
    description: 'Media could not be analyzed automatically. Please have a human reviewer inspect this attachment.',
    detectedCategory: null,
    severityIndicators: [],
    confidence: 0,
    needsHumanReview: true,
    analysisFailed: true,
    failureReason: reason,
  };
}

// ── Prompt builders ───────────────────────────────────────────────────────────

function buildImagePrompt(): string {
  return `You are a civic issue classification assistant. Analyze this image and identify any visible civic problems.

Respond ONLY with a JSON object matching exactly this schema:
{
  "description": "<concise description of the visible civic issue (1-3 sentences max)>",
  "detectedCategory": "<one of: infrastructure | sanitation | utility | noise | safety | other | null>",
  "severityIndicators": ["<observable indicator 1>", "<observable indicator 2>"],
  "confidence": <0.0 to 1.0 — your confidence that this is a civic issue>
}

STRICT RULES:
- Only describe what is DIRECTLY VISIBLE in the image. Never infer or assume.
- Do NOT claim the image "proves" anything beyond what can be seen.
- If no civic issue is visible, set detectedCategory to null and confidence to 0.
- severityIndicators must only list things actually visible (e.g. "standing water", "cracked pavement").
- description must be factual, not speculative.
- Return only valid JSON. No markdown, no explanation.`;
}

function buildAudioPrompt(): string {
  return `You are a civic issue transcription and classification assistant. Transcribe the spoken content in this audio recording.

Respond ONLY with a JSON object matching exactly this schema:
{
  "description": "<summary of the civic complaint described in the audio (1-3 sentences)>",
  "rawTranscript": "<verbatim transcription of the audio content>",
  "detectedCategory": "<one of: infrastructure | sanitation | utility | noise | safety | other | null>",
  "severityIndicators": ["<issue mentioned in audio>"],
  "confidence": <0.0 to 1.0 — your confidence in the transcription quality and category>
}

STRICT RULES:
- Preserve the original language in rawTranscript.
- If the audio is unclear or no civic complaint is detected, set confidence below 0.5 and detectedCategory to null.
- Return only valid JSON. No markdown, no explanation.`;
}

function buildVideoFramePrompt(frameCount: number): string {
  return `You are a civic issue classification assistant. You are analyzing ${frameCount} representative frame(s) sampled from a video.

Respond ONLY with a JSON object matching exactly this schema:
{
  "description": "<concise description of the civic issue visible in the frames (1-3 sentences)>",
  "detectedCategory": "<one of: infrastructure | sanitation | utility | noise | safety | other | null>",
  "severityIndicators": ["<observable indicator 1>"],
  "confidence": <0.0 to 1.0>
}

STRICT RULES:
- Only describe what is DIRECTLY VISIBLE in the sampled frames.
- Do NOT claim continuous events (e.g. "flooding all night") from ${frameCount} still frame(s).
- If the frames show no clear civic issue, set detectedCategory to null and confidence below 0.5.
- Return only valid JSON. No markdown, no explanation.`;
}

// ── AI response parser ────────────────────────────────────────────────────────

function parseAIResponse(
  raw: string,
  mediaType: 'image' | 'audio' | 'video',
  frameCount?: number
): MediaAnalysisResult {
  const confidenceThreshold = parseFloat(process.env.MEDIA_ANALYSIS_CONFIDENCE_THRESHOLD || '0.60');

  // Strip any markdown code fences the model may add despite instructions
  const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '').trim();

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    logger.warn('[MEDIA_ANALYSIS] AI response is not valid JSON — triggering human review');
    return buildFallbackResult(mediaType, 'AI response is not valid JSON');
  }

  const confidence = typeof parsed.confidence === 'number'
    ? Math.max(0, Math.min(1, parsed.confidence))
    : 0;

  const needsHumanReview = confidence < confidenceThreshold;

  const rawCategory = typeof parsed.detectedCategory === 'string'
    ? (CIVIC_CATEGORIES as readonly string[]).includes(parsed.detectedCategory)
      ? parsed.detectedCategory as CivicCategory
      : null
    : null;

  const result = {
    mediaType,
    description: typeof parsed.description === 'string' && parsed.description.length > 0
      ? parsed.description.slice(0, 2000)
      : 'No description available.',
    detectedCategory: rawCategory,
    severityIndicators: Array.isArray(parsed.severityIndicators)
      ? (parsed.severityIndicators as unknown[]).filter((s): s is string => typeof s === 'string').slice(0, 10)
      : [],
    confidence,
    needsHumanReview,
    rawTranscript: typeof parsed.rawTranscript === 'string' ? parsed.rawTranscript : undefined,
    frameCount,
  };

  const validated = MediaAnalysisResultSchema.safeParse(result);
  if (!validated.success) {
    logger.warn(`[MEDIA_ANALYSIS] Zod validation failed: ${validated.error.message}`);
    return buildFallbackResult(mediaType, `Zod validation failed: ${validated.error.message}`);
  }

  return validated.data;
}

// ── Video frame extraction ────────────────────────────────────────────────────
//
// Real decoding is performed by FFmpeg (see ../utils/videoFrames):
//   1. The buffer is written to a temp file.
//   2. ffprobe reads the duration (also used for the upload duration limit).
//   3. ffmpeg decodes MAX_VIDEO_FRAMES_SAMPLED JPEG frames at evenly spaced
//      timestamps across the clip.
//
// Those JPEGs are then sent to Gemini as image parts. If FFmpeg is unavailable
// or cannot decode the file, we fall back to sending the full video inline
// (Gemini accepts video/mp4 up to ~20 MB inline). Byte offset sampling is
// deliberately NOT used: raw container bytes are not decodable images.

/** Inline size cap for sending a whole video to Gemini. */
const INLINE_VIDEO_LIMIT = 20 * 1024 * 1024; // 20 MB

// ── Main analysis functions ───────────────────────────────────────────────────

/**
 * Analyzes an image buffer using Gemini Vision.
 */
export async function analyzeImage(
  imageBuffer: Buffer,
  mimeType: string
): Promise<MediaAnalysisResult> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return buildFallbackResult('image', 'GEMINI_API_KEY not configured');
  }

  const modelName = process.env.MEDIA_ANALYSIS_MODEL || 'gemini-2.5-flash';

  try {
    const genAI = new GoogleGenerativeAI(apiKey);
    const model = genAI.getGenerativeModel({ model: modelName });

    const imagePart: Part = {
      inlineData: {
        data: imageBuffer.toString('base64'),
        mimeType: mimeType as any,
      },
    };

    const result = await model.generateContent([buildImagePrompt(), imagePart]);
    const responseText = result.response.text();

    logger.debug(`[MEDIA_ANALYSIS] Image analysis raw response (${responseText.length} chars)`);
    return parseAIResponse(responseText, 'image');
  } catch (err: any) {
    logger.error(`[MEDIA_ANALYSIS] Image analysis failed (${err?.name || 'Error'}).`);
    return buildFallbackResult('image', err.message);
  }
}

/**
 * Transcribes and classifies an audio buffer using Gemini.
 */
export async function analyzeAudio(
  audioBuffer: Buffer,
  mimeType: string
): Promise<MediaAnalysisResult> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return buildFallbackResult('audio', 'GEMINI_API_KEY not configured');
  }

  const modelName = process.env.MEDIA_ANALYSIS_MODEL || 'gemini-2.5-flash';

  try {
    const genAI = new GoogleGenerativeAI(apiKey);
    const model = genAI.getGenerativeModel({ model: modelName });

    const audioPart: Part = {
      inlineData: {
        data: audioBuffer.toString('base64'),
        mimeType: mimeType as any,
      },
    };

    const result = await model.generateContent([buildAudioPrompt(), audioPart]);
    const responseText = result.response.text();

    logger.debug(`[MEDIA_ANALYSIS] Audio analysis raw response (${responseText.length} chars)`);
    return parseAIResponse(responseText, 'audio');
  } catch (err: any) {
    logger.error(`[MEDIA_ANALYSIS] Audio analysis failed (${err?.name || 'Error'}).`);
    return buildFallbackResult('audio', err.message);
  }
}

/**
 * Analyzes a video by extracting REAL representative frames with FFmpeg and
 * sending those JPEG frames to Gemini Vision.
 *
 * Fallback order:
 *   1. FFmpeg frame extraction (preferred — decodes actual frames).
 *   2. Full video inline upload when ≤ 20 MB (Gemini decodes server-side).
 *   3. Deterministic fallback result with needsHumanReview=true.
 *
 * The prompt forbids claiming continuous events from a small set of still frames.
 */
export async function analyzeVideo(
  videoBuffer: Buffer,
  mimeType: string
): Promise<MediaAnalysisResult> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return buildFallbackResult('video', 'GEMINI_API_KEY not configured');
  }

  const modelName = process.env.MEDIA_ANALYSIS_MODEL || 'gemini-2.5-flash';

  try {
    const genAI = new GoogleGenerativeAI(apiKey);
    const model = genAI.getGenerativeModel({ model: modelName });

    let parts: (string | Part)[];

    // 1) Preferred: real frames decoded by FFmpeg (evenly spaced across clip)
    const frames = await extractVideoFrames(videoBuffer, mimeType, MAX_VIDEO_FRAMES_SAMPLED);

    if (frames.length > 0) {
      logger.debug(
        `[MEDIA_ANALYSIS] Analyzing video via ${frames.length} FFmpeg-extracted frame(s)`
      );
      parts = [buildVideoFramePrompt(frames.length)];
      for (const frame of frames) {
        parts.push({
          inlineData: {
            data: frame.toString('base64'),
            mimeType: 'image/jpeg',
          },
        });
      }
    } else if (videoBuffer.length <= INLINE_VIDEO_LIMIT) {
      // 2) Fallback: let Gemini decode the whole clip inline (≤ 20 MB)
      logger.debug('[MEDIA_ANALYSIS] FFmpeg unavailable/failed — sending full video inline');
      const videoPart: Part = {
        inlineData: {
          data: videoBuffer.toString('base64'),
          mimeType: mimeType as any,
        },
      };
      parts = [buildVideoFramePrompt(1), videoPart];
    } else {
      // 3) Too large for inline and no decoder available — never byte-sample
      logger.warn(
        `[MEDIA_ANALYSIS] Video is ${videoBuffer.length} bytes (> ${INLINE_VIDEO_LIMIT} inline limit) ` +
          'and FFmpeg frame extraction failed — returning human-review fallback'
      );
      return buildFallbackResult(
        'video',
        'Video could not be decoded (FFmpeg unavailable) and exceeds the inline size limit'
      );
    }

    const result = await model.generateContent(parts);
    const responseText = result.response.text();

    logger.debug(`[MEDIA_ANALYSIS] Video analysis raw response (${responseText.length} chars)`);
    return parseAIResponse(responseText, 'video', frames.length || 1);
  } catch (err: any) {
    logger.error(`[MEDIA_ANALYSIS] Video analysis failed (${err?.name || 'Error'}).`);
    return buildFallbackResult('video', err.message);
  }
}

/**
 * Dispatches to the correct analysis function based on MIME type.
 */
export async function analyzeMedia(
  buffer: Buffer,
  mimeType: string
): Promise<MediaAnalysisResult> {
  if (SUPPORTED_IMAGE_TYPES.has(mimeType)) {
    return analyzeImage(buffer, mimeType);
  }
  if (SUPPORTED_AUDIO_TYPES.has(mimeType)) {
    return analyzeAudio(buffer, mimeType);
  }
  if (SUPPORTED_VIDEO_TYPES.has(mimeType)) {
    return analyzeVideo(buffer, mimeType);
  }
  return buildFallbackResult('image', `Unsupported MIME type: ${mimeType}`);
}

/**
 * Returns the MediaAnalysisResult.mediaType from a MIME type string.
 * Defaults to 'image' for unknown types.
 */
export function getMediaType(mimeType: string): 'image' | 'audio' | 'video' {
  if (SUPPORTED_AUDIO_TYPES.has(mimeType)) return 'audio';
  if (SUPPORTED_VIDEO_TYPES.has(mimeType)) return 'video';
  return 'image';
}
