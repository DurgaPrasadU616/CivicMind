// backend/src/services/qstash.ts
//
// Phase 2B.3 — Minimal QStash publisher + webhook signature verification.
//
// QStash is the durable delivery mechanism for media-analysis jobs on
// serverless. When it is not configured, callers must NOT pretend that an
// in-process setImmediate() is durable; they fall back to inline execution and
// the DB-backed recovery sweep remains the safety net.

import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import { Request } from 'express';
import logger from '../utils/logger';

const QSTASH_PUBLISH_BASE = 'https://qstash.upstash.io/v2/publish';

export interface QStashPublishResult {
  messageId: string;
}

export function getMediaJobUrl(): string | null {
  const explicit = process.env.QSTASH_MEDIA_JOB_URL;
  if (explicit) return explicit;

  const base = process.env.PUBLIC_BASE_URL || process.env.APP_BASE_URL;
  if (!base) return null;

  return `${base.replace(/\/+$/, '')}/api/internal/jobs/media-analysis`;
}

export function isQStashConfigured(): boolean {
  return Boolean(
    process.env.QSTASH_TOKEN &&
      getMediaJobUrl() &&
      (process.env.QSTASH_CURRENT_SIGNING_KEY || process.env.QSTASH_NEXT_SIGNING_KEY)
  );
}

export async function publishQStashJob(
  destination: string,
  body: Record<string, unknown>,
  retries = 3
): Promise<QStashPublishResult> {
  const token = process.env.QSTASH_TOKEN;
  if (!token) {
    throw new Error('QSTASH_TOKEN is not configured.');
  }

  const publishUrl = `${QSTASH_PUBLISH_BASE}/${destination}`;
  const response = await fetch(publishUrl, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'Upstash-Retries': String(retries),
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(
      `QStash publish failed (${response.status} ${response.statusText})${detail ? `: ${detail}` : ''}`
    );
  }

  const payload = (await response.json().catch(() => ({}))) as { messageId?: string };
  return { messageId: payload.messageId || '' };
}

function bodyHash(rawBody: Buffer | string): string {
  return crypto.createHash('sha256').update(rawBody).digest('base64url');
}

/**
 * Verifies the Upstash-Signature JWT against the configured current/next
 * signing keys and confirms the signed body hash matches the raw request body.
 */
export function verifyQStashSignature(signature: string, rawBody: Buffer | string): boolean {
  if (!signature || !rawBody) return false;

  const keys = [
    process.env.QSTASH_CURRENT_SIGNING_KEY,
    process.env.QSTASH_NEXT_SIGNING_KEY,
  ].filter(Boolean) as string[];

  if (keys.length === 0) return false;

  const expectedBody = bodyHash(rawBody).replace(/=+$/, '');
  const expectedDestination = getMediaJobUrl();

  for (const key of keys) {
    try {
      const payload = jwt.verify(signature, key, {
        algorithms: ['HS256'],
        issuer: 'Upstash',
      }) as jwt.JwtPayload;

      if (expectedDestination && payload.sub && payload.sub !== expectedDestination) {
        continue;
      }

      const signedBody = String(payload.body || '').replace(/=+$/, '');
      if (signedBody && signedBody === expectedBody) {
        return true;
      }
    } catch (err: any) {
      logger.debug(`[QSTASH] Signature verification attempt failed: ${err?.message || err}`);
    }
  }

  return false;
}

/**
 * Internal recovery endpoints are callable by Vercel Cron (which sends
 * `Authorization: Bearer <CRON_SECRET>`) or by an operator with the secret.
 */
export function isCronAuthorized(req: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;

  const auth = req.header('authorization');
  if (auth && auth === `Bearer ${secret}`) return true;

  return req.header('x-cron-secret') === secret;
}
