// backend/src/utils/videoFrames.ts
//
// Phase 3 — Real video frame extraction using FFmpeg.
//
// Replaces the earlier byte-offset "sampling" approach (which sliced raw
// container bytes and therefore never produced decodable images) with genuine
// decoding: the uploaded buffer is written to a temp file, probed with ffprobe,
// and representative frames are decoded to JPEG with ffmpeg.
//
// Requirements:
//   • `ffmpeg` and `ffprobe` must be on PATH (or pointed to by FFMPEG_PATH /
//     FFPROBE_PATH). When unavailable the caller falls back to sending the full
//     video inline to Gemini (subject to the inline size limit) or, failing
//     that, to a needsHumanReview fallback result. Byte sampling is never used.
//
// Limits (env-overridable):
//   MAX_VIDEO_DURATION_SECONDS  (default 120)  — rejected at upload time
//   MAX_VIDEO_FRAMES_SAMPLED    (default 3)    — representative frames per video
//
// Frame selection: N frames are taken at evenly spaced timestamps
// (duration * i / (N + 1)) so the beginning, middle and end of the clip are
// all represented without over-representing the first frame.

import { spawn, spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { randomUUID } from 'crypto';
import logger from './logger';

export const MAX_VIDEO_FRAMES_SAMPLED =
  parseInt(process.env.MAX_VIDEO_FRAMES_SAMPLED || '', 10) > 0
    ? parseInt(process.env.MAX_VIDEO_FRAMES_SAMPLED || '', 10)
    : 3;

export const MAX_VIDEO_DURATION_SECONDS =
  parseInt(process.env.MAX_VIDEO_DURATION_SECONDS || '', 10) > 0
    ? parseInt(process.env.MAX_VIDEO_DURATION_SECONDS || '', 10)
    : 120;

/** Thrown when a video exceeds MAX_VIDEO_DURATION_SECONDS (HTTP 400). */
export class VideoDurationLimitError extends Error {
  readonly statusCode = 400;
  constructor(durationSeconds: number, limitSeconds: number) {
    super(
      `Video duration ${durationSeconds.toFixed(1)}s exceeds the maximum allowed ` +
        `duration of ${limitSeconds}s. Please upload a shorter clip.`
    );
    this.name = 'VideoDurationLimitError';
  }
}

const TEMP_EXT: Record<string, string> = {
  'video/mp4': '.mp4',
  'video/webm': '.webm',
  'video/quicktime': '.mov',
};

function resolveBinary(envVar: string, fallback: string): string {
  return process.env[envVar] || fallback;
}

let ffmpegAvailable: boolean | null = null;
let ffprobeAvailable: boolean | null = null;

/** Returns true when a working ffmpeg binary can be executed. */
export function isFfmpegAvailable(): boolean {
  if (ffmpegAvailable !== null) return ffmpegAvailable;
  try {
    const res = spawnSync(resolveBinary('FFMPEG_PATH', 'ffmpeg'), ['-version'], {
      windowsHide: true,
      stdio: 'ignore',
    });
    ffmpegAvailable = res.status === 0;
  } catch {
    ffmpegAvailable = false;
  }
  if (!ffmpegAvailable) {
    logger.warn(
      '[VIDEO_FRAMES] ffmpeg not available — video analysis will fall back to ' +
        'inline video upload (≤ 20 MB) or a human-review result. Byte sampling is never used.'
    );
  }
  return ffmpegAvailable;
}

/** Returns true when a working ffprobe binary can be executed. */
export function isFfprobeAvailable(): boolean {
  if (ffprobeAvailable !== null) return ffprobeAvailable;
  try {
    const res = spawnSync(resolveBinary('FFPROBE_PATH', 'ffprobe'), ['-version'], {
      windowsHide: true,
      stdio: 'ignore',
    });
    ffprobeAvailable = res.status === 0;
  } catch {
    ffprobeAvailable = false;
  }
  return ffprobeAvailable;
}

/** Reset cached availability probes (for tests). */
export function _resetFfmpegAvailability(): void {
  ffmpegAvailable = null;
  ffprobeAvailable = null;
}

async function withTempVideo(buffer: Buffer, mimeType: string): Promise<string> {
  const ext = TEMP_EXT[mimeType] || '.bin';
  const tmpPath = path.join(os.tmpdir(), `civicmind_${randomUUID()}${ext}`);
  await fs.promises.writeFile(tmpPath, buffer);
  return tmpPath;
}

async function removeQuietly(filePath: string): Promise<void> {
  try {
    await fs.promises.unlink(filePath);
  } catch {
    // ignore
  }
}

/**
 * Probes the duration of a video buffer in seconds using ffprobe.
 * Returns null when ffprobe is unavailable or the duration cannot be read.
 */
export async function probeVideoDurationSeconds(
  buffer: Buffer,
  mimeType: string
): Promise<number | null> {
  if (!isFfprobeAvailable()) return null;

  const tmpPath = await withTempVideo(buffer, mimeType);
  try {
    const output = await new Promise<string>((resolve, reject) => {
      const child = spawn(
        resolveBinary('FFPROBE_PATH', 'ffprobe'),
        [
          '-v', 'error',
          '-show_entries', 'format=duration',
          '-of', 'default=noprint_wrappers=1:nokey=1',
          tmpPath,
        ],
        { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }
      );
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (d) => (stdout += d.toString()));
      child.stderr.on('data', (d) => (stderr += d.toString()));
      child.on('error', reject);
      child.on('close', (code) => {
        if (code === 0) resolve(stdout.trim());
        else reject(new Error(`ffprobe exited with code ${code}: ${stderr.slice(0, 300)}`));
      });
    });

    const duration = parseFloat(output);
    return Number.isFinite(duration) && duration > 0 ? duration : null;
  } catch (err: any) {
    logger.warn(`[VIDEO_FRAMES] Could not probe video duration: ${err.message}`);
    return null;
  } finally {
    await removeQuietly(tmpPath);
  }
}

/**
 * Effective duration limit, resolved at CALL time so tests/deployments can
 * override MAX_VIDEO_DURATION_SECONDS without reloading the module.
 * Falls back to the module-load constant (env at import time, else 120).
 */
export function getMaxVideoDurationSeconds(): number {
  const fromEnv = parseInt(process.env.MAX_VIDEO_DURATION_SECONDS || '', 10);
  return fromEnv > 0 ? fromEnv : MAX_VIDEO_DURATION_SECONDS;
}

/**
 * Validates a video against MAX_VIDEO_DURATION_SECONDS.
 * Throws VideoDurationLimitError when the limit is exceeded.
 * No-ops when ffprobe is unavailable (limit cannot be enforced — logged once).
 */
export async function enforceVideoDurationLimit(
  buffer: Buffer,
  mimeType: string
): Promise<void> {
  const duration = await probeVideoDurationSeconds(buffer, mimeType);
  if (duration === null) {
    logger.warn(
      '[VIDEO_FRAMES] Duration limit not enforced (ffprobe unavailable or duration unreadable).'
    );
    return;
  }
  const maxSeconds = getMaxVideoDurationSeconds();
  if (duration > maxSeconds) {
    throw new VideoDurationLimitError(duration, maxSeconds);
  }
}

/**
 * Extracts up to `count` representative frames from a video buffer as JPEG
 * buffers, evenly spaced across the clip's duration.
 *
 * Returns an empty array when ffmpeg is unavailable, when the video cannot be
 * decoded, or when no frames could be produced. Callers must treat an empty
 * array as "frame extraction unavailable" and fall back accordingly.
 */
export async function extractVideoFrames(
  buffer: Buffer,
  mimeType: string,
  count: number = MAX_VIDEO_FRAMES_SAMPLED
): Promise<Buffer[]> {
  if (buffer.length === 0 || count <= 0) return [];
  if (!isFfmpegAvailable()) return [];

  const tmpPath = await withTempVideo(buffer, mimeType);
  const frames: Buffer[] = [];

  try {
    const duration = await probeVideoDurationSeconds(buffer, mimeType);

    // Evenly spaced sample points across the clip (skip exact 0s and the end).
    const samplePoints: number[] = [];
    if (duration && duration > 0) {
      for (let i = 1; i <= count; i++) {
        samplePoints.push((duration * i) / (count + 1));
      }
    } else {
      // Unknown duration — try the first frame only.
      samplePoints.push(0);
    }

    for (const t of samplePoints) {
      const frame = await decodeFrameAt(tmpPath, t);
      if (frame && frame.length > 0 && isJpeg(frame)) {
        frames.push(frame);
      }
    }

    if (frames.length > 0) {
      logger.debug(
        `[VIDEO_FRAMES] Extracted ${frames.length}/${count} representative frame(s) ` +
          `(${duration ? duration.toFixed(1) + 's' : 'duration unknown'} video)`
      );
    } else {
      logger.warn('[VIDEO_FRAMES] ffmpeg produced no decodable frames for this video.');
    }
  } catch (err: any) {
    logger.warn(`[VIDEO_FRAMES] Frame extraction failed: ${err.message}`);
  } finally {
    await removeQuietly(tmpPath);
  }

  return frames;
}

function isJpeg(buf: Buffer): boolean {
  return buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
}

/** Decodes a single frame at `timestampSeconds` to JPEG via ffmpeg stdout. */
function decodeFrameAt(filePath: string, timestampSeconds: number): Promise<Buffer | null> {
  return new Promise((resolve) => {
    const args = [
      '-hide_banner',
      '-loglevel', 'error',
      '-ss', timestampSeconds.toFixed(3),
      '-i', filePath,
      '-frames:v', '1',
      '-q:v', '3',
      '-f', 'mjpeg',
      'pipe:1',
    ];

    const child = spawn(resolveBinary('FFMPEG_PATH', 'ffmpeg'), args, {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const chunks: Buffer[] = [];
    let stderr = '';
    child.stdout.on('data', (d) => chunks.push(Buffer.from(d)));
    child.stderr.on('data', (d) => (stderr += d.toString()));
    child.on('error', () => resolve(null));
    child.on('close', (code) => {
      if (code === 0 && chunks.length > 0) {
        resolve(Buffer.concat(chunks));
      } else {
        logger.debug(
          `[VIDEO_FRAMES] ffmpeg frame decode failed (code ${code}): ${stderr.slice(0, 200)}`
        );
        resolve(null);
      }
    });
  });
}
