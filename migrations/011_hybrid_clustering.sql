-- migrations/011_hybrid_clustering.sql
--
-- Phase 1 — Adds geographic centroid and temporal/hybrid scoring columns to
-- the cluster table.  Used by the Phase 2 hybrid clustering algorithm.
--
-- ✅ Additive only — no existing column is dropped or renamed.
-- ✅ Idempotent — safe to run multiple times on any environment.
-- ✅ Reversible — see DOWN section at bottom (manual rollback).
--
-- New columns:
--   cluster.geo_centroid_lat  DECIMAL(10,8)  — mean latitude of all linked complaints
--   cluster.geo_centroid_lng  DECIMAL(11,8)  — mean longitude of all linked complaints
--   cluster.temporal_weight   NUMERIC(5,4)   — recency multiplier (0.0–1.0, default 1.0)
--   cluster.hybrid_score      NUMERIC(5,2)   — combined semantic + geo + temporal score
--
--   complaint.recency_weight  NUMERIC(5,4)   — per-complaint temporal decay weight
-- =============================================================================

-- ── 1. cluster: geographic centroid ─────────────────────────────────────────
ALTER TABLE cluster ADD COLUMN IF NOT EXISTS geo_centroid_lat  DECIMAL(10,8);
ALTER TABLE cluster ADD COLUMN IF NOT EXISTS geo_centroid_lng  DECIMAL(11,8);

-- ── 2. cluster: temporal scoring ────────────────────────────────────────────
-- temporal_weight: starts at 1.0 (fully current), decays toward 0 with age.
-- Recomputed by the Phase 2 hybrid clustering service on each ingestion cycle.
ALTER TABLE cluster ADD COLUMN IF NOT EXISTS temporal_weight   NUMERIC(5,4) NOT NULL DEFAULT 1.0;

-- ── 3. cluster: composite hybrid score ──────────────────────────────────────
-- hybrid_score = weighted sum of (semantic_similarity * 0.60)
--                               + (geo_proximity_score * 0.25)
--                               + (temporal_weight * 0.15)
-- Set to 0 by default; backfilled by Phase 2 on first run.
ALTER TABLE cluster ADD COLUMN IF NOT EXISTS hybrid_score      NUMERIC(5,2) NOT NULL DEFAULT 0;

-- ── 4. complaint: per-complaint recency weight ───────────────────────────────
-- Allows the clustering engine to down-weight older complaints when computing
-- a cluster centroid or matching a new complaint to existing clusters.
ALTER TABLE complaint ADD COLUMN IF NOT EXISTS recency_weight  NUMERIC(5,4) NOT NULL DEFAULT 1.0;

-- ── 5. Indexes ───────────────────────────────────────────────────────────────

-- Geographic bounding-box queries during nearby cluster search
CREATE INDEX IF NOT EXISTS idx_cluster_geo_centroid
    ON cluster (geo_centroid_lat, geo_centroid_lng);

-- Sort by hybrid score (Phase 2 replaces priority_score sort)
CREATE INDEX IF NOT EXISTS idx_cluster_hybrid_score
    ON cluster (hybrid_score DESC);

-- ── 6. Backfill geo centroid for existing clusters ───────────────────────────
-- Populate geo_centroid_lat/lng from the average coordinates of linked complaints.
-- Clusters with no geotagged complaints remain NULL (handled gracefully in code).
UPDATE cluster cl
SET
  geo_centroid_lat = sub.avg_lat,
  geo_centroid_lng = sub.avg_lng
FROM (
  SELECT
    cluster_id,
    AVG(latitude)  AS avg_lat,
    AVG(longitude) AS avg_lng
  FROM complaint
  WHERE cluster_id IS NOT NULL
    AND latitude  IS NOT NULL
    AND longitude IS NOT NULL
  GROUP BY cluster_id
) sub
WHERE cl.id = sub.cluster_id
  AND cl.geo_centroid_lat IS NULL;   -- only rows not yet populated

-- =============================================================================
-- DOWN (manual rollback — run only when intentionally reverting Phase 2 work):
--
--   ALTER TABLE cluster  DROP COLUMN IF EXISTS geo_centroid_lat;
--   ALTER TABLE cluster  DROP COLUMN IF EXISTS geo_centroid_lng;
--   ALTER TABLE cluster  DROP COLUMN IF EXISTS temporal_weight;
--   ALTER TABLE cluster  DROP COLUMN IF EXISTS hybrid_score;
--   ALTER TABLE complaint DROP COLUMN IF EXISTS recency_weight;
--   DROP INDEX IF EXISTS idx_cluster_geo_centroid;
--   DROP INDEX IF EXISTS idx_cluster_hybrid_score;
-- =============================================================================
