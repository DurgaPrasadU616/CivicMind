// backend/src/services/ingestion/common.ts
//
// Shared helpers for all ingestion pipelines (news, social, survey, NGO).
// Provides: source lookup, dedup-aware insert, complaint clustering.

import { pool } from '../../config/db';
import { clusterComplaint } from '../clustering';
import { createHash } from 'crypto';

// ── Source ID lookup ─────────────────────────────────────────────────────────
// Maps a source name (e.g. 'news_rss') to its numeric ID in the source table.
export const getSourceId = async (sourceName: string): Promise<number | null> => {
  if (!pool) return null;
  const res = await pool.query('SELECT id FROM source WHERE name = $1', [sourceName]);
  return res.rows.length > 0 ? res.rows[0].id : null;
};

// ── Deterministic idempotency key ───────────────────────────────────────────
// Generates a v4-ish UUID from an arbitrary string so the same article/post
// is never inserted twice (UNIQUE constraint on idempotency_key in complaint).
export const generateIdempotencyKey = (raw: string): string => {
  const hex = createHash('sha256').update(raw).digest('hex');
  // Format as UUID v4-like string: 8-4-4-4-12
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    '4' + hex.slice(13, 16), // version 4 marker
    '8' + hex.slice(17, 20), // variant 10xx
    hex.slice(20, 32),
  ].join('-');
};

// ── Insert + cluster pipeline ───────────────────────────────────────────────
// Inserts a complaint row and runs it through the existing embed → cluster →
// severity-score → priority-score pipeline.  Returns the new complaint ID or
// null if a duplicate was detected.
export const insertAndCluster = async (opts: {
  sourceId: number;
  text: string;
  category: string;
  idempotencyKey: string;
  latitude?: number | null;
  longitude?: number | null;
  metaData?: Record<string, unknown>;
}): Promise<number | null> => {
  if (!pool) throw new Error('Database pool unavailable');

  const {
    sourceId,
    text,
    category,
    idempotencyKey,
    latitude = null,
    longitude = null,
    metaData = {},
  } = opts;

  // Dedup: ON CONFLICT on the unique idempotency_key → skip
  const result = await pool.query(
    `INSERT INTO complaint (source_id, text, category, latitude, longitude, idempotency_key, meta_data)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (idempotency_key) DO NOTHING
     RETURNING id`,
    [sourceId, text, category, latitude, longitude, idempotencyKey, JSON.stringify(metaData)]
  );

  if (result.rows.length === 0) {
    // Duplicate — skipped
    return null;
  }

  const complaintId = result.rows[0].id as number;

  // Run through the shared embed → cluster → score pipeline
  await clusterComplaint(complaintId);

  return complaintId;
};
