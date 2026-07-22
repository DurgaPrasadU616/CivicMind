// backend/src/services/ingestion/ingestionLogService.ts
//
// Service to log and query ingestion run history in the ingestion_log table.

import { pool } from '../../config/db';

export interface IngestionLogEntry {
  sourceType: string;
  processed: number;
  created: number;
  duplicates: number;
  errors: number;
  failedFeeds?: string[] | null;
  status: 'success' | 'partial' | 'failed';
}

export interface IngestionLogRow {
  id: number;
  source_type: string;
  run_at: string;
  processed: number;
  created: number;
  duplicates: number;
  errors: number;
  failed_feeds: string[] | null;
  status: 'success' | 'partial' | 'failed';
}

export const logIngestionRun = async (entry: IngestionLogEntry): Promise<number | null> => {
  if (!pool) {
    console.warn('[INGEST_LOG] Database pool unavailable. Skipping log entry.');
    return null;
  }

  try {
    const res = await pool.query(
      `INSERT INTO ingestion_log (source_type, processed, created, duplicates, errors, failed_feeds, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id`,
      [
        entry.sourceType,
        entry.processed,
        entry.created,
        entry.duplicates,
        entry.errors,
        entry.failedFeeds && entry.failedFeeds.length > 0 ? entry.failedFeeds : null,
        entry.status,
      ]
    );

    return res.rows[0]?.id ?? null;
  } catch (err: any) {
    console.error('[INGEST_LOG] Failed to write ingestion_log row:', err.message);
    return null;
  }
};

export const getIngestionLogs = async (
  limit = 10,
  offset = 0
): Promise<{ logs: IngestionLogRow[]; total: number }> => {
  if (!pool) {
    return { logs: [], total: 0 };
  }

  const countRes = await pool.query('SELECT COUNT(*) FROM ingestion_log');
  const total = parseInt(countRes.rows[0]?.count ?? '0', 10);

  const logsRes = await pool.query(
    `SELECT id, source_type, run_at, processed, created, duplicates, errors, failed_feeds, status
     FROM ingestion_log
     ORDER BY run_at DESC
     LIMIT $1 OFFSET $2`,
    [limit, offset]
  );

  return {
    logs: logsRes.rows,
    total,
  };
};
