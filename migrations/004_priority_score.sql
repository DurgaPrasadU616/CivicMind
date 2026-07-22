-- migrations/004_priority_score.sql
-- Adds the priority_score column to the cluster table (and complaint table as a safety guard),
-- which powers the staleness-aware ranking feature in ranking.ts.
--
-- Formula (computed in code, stored here):
--   priority_score = severity_score * urgency_decay(days_since_first_report) * resource_cost_factor
--
-- This migration is fully idempotent — safe to re-run on any environment.

-- ============================================================
-- 1. cluster.priority_score
--    The primary write target for updateClusterPriorityScore().
--    Default 0 so existing rows don't break reads immediately;
--    the background refresh in GET /api/clusters will populate
--    correct values on first access after migration.
-- ============================================================
ALTER TABLE cluster ADD COLUMN IF NOT EXISTS priority_score NUMERIC(5,2) DEFAULT 0;

-- ============================================================
-- 2. complaint.priority_score (safety guard)
--    Defined in 001_init.sql as INT, but may be absent on
--    databases created before that column was added.
--    ADD COLUMN IF NOT EXISTS is a no-op when it already exists.
-- ============================================================
ALTER TABLE complaint ADD COLUMN IF NOT EXISTS priority_score NUMERIC(5,2) DEFAULT 0;

-- ============================================================
-- 3. Index on cluster.priority_score
--    Speeds up ORDER BY priority_score DESC in GET /api/clusters.
-- ============================================================
CREATE INDEX IF NOT EXISTS idx_cluster_priority_score ON cluster(priority_score DESC);

-- ============================================================
-- 4. Backfill: set priority_score = severity_score for any
--    existing clusters that have never been scored, so the
--    initial sort order is sensible before the first live
--    background refresh runs.
-- ============================================================
UPDATE cluster
SET priority_score = severity_score
WHERE priority_score IS NULL OR priority_score = 0;
