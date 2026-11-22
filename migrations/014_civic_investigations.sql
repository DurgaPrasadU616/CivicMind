-- migrations/014_civic_investigations.sql
--
-- Phase 4 — Autonomous Civic Investigation Agent
-- Creates tables for tracking automated investigations, collected evidence,
-- AI investigation reports, actionable recommendations, and audit activity.
--
-- Tables:
--   1. civic_investigations          — Primary investigation records
--   2. investigation_evidence        — Evidence items (complaints, media, public research)
--   3. investigation_reports         — Versioned AI-generated investigation reports
--   4. investigation_recommendations — Actionable recommendations with approval workflow
--   5. investigation_activity        — Activity / timeline audit log
--
-- ✅ Additive only — no existing columns or tables modified.
-- ✅ Idempotent — safe to re-run on any environment (IF NOT EXISTS).
-- ✅ Reversible — see DOWN section.
-- =============================================================================

-- ── 1. civic_investigations ──────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS civic_investigations (
    id                     SERIAL PRIMARY KEY,
    cluster_id             INT NOT NULL REFERENCES cluster(id) ON DELETE CASCADE,
    status                 VARCHAR(30) NOT NULL DEFAULT 'pending'
                               CHECK (status IN (
                                   'pending',
                                   'running',
                                   'completed',
                                   'failed',
                                   'review_pending',
                                   'approved',
                                   'rejected',
                                   'resolved'
                               )),
    priority               VARCHAR(20) NOT NULL DEFAULT 'medium'
                               CHECK (priority IN ('low', 'medium', 'high', 'critical')),
    investigation_summary  TEXT,
    department_suggestion  VARCHAR(100),
    confidence_score       NUMERIC(4,3),
    created_by             INT REFERENCES "user"(id) ON DELETE SET NULL,
    started_at             TIMESTAMPTZ,
    completed_at           TIMESTAMPTZ,
    created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at             TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_investigations_cluster_id
    ON civic_investigations(cluster_id);

CREATE INDEX IF NOT EXISTS idx_investigations_status
    ON civic_investigations(status, priority);

CREATE INDEX IF NOT EXISTS idx_investigations_created_at
    ON civic_investigations(created_at DESC);

-- ── 2. investigation_evidence ────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS investigation_evidence (
    id                   SERIAL PRIMARY KEY,
    investigation_id     INT NOT NULL REFERENCES civic_investigations(id) ON DELETE CASCADE,
    complaint_id         INT REFERENCES complaint(id) ON DELETE SET NULL,
    media_id             INT REFERENCES complaint_media(id) ON DELETE SET NULL,
    evidence_type        VARCHAR(30) NOT NULL
                             CHECK (evidence_type IN (
                                 'complaint',
                                 'media',
                                 'public_source',
                                 'historical',
                                 'department_policy'
                             )),
    source_url           TEXT,
    source_title         VARCHAR(255),
    evidence_description TEXT NOT NULL,
    verification_status  VARCHAR(20) NOT NULL DEFAULT 'unverified'
                             CHECK (verification_status IN (
                                 'verified',
                                 'unverified',
                                 'ai_inferred'
                             )),
    retrieved_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_investigation_evidence_inv_id
    ON investigation_evidence(investigation_id);

CREATE INDEX IF NOT EXISTS idx_investigation_evidence_type
    ON investigation_evidence(investigation_id, evidence_type);

-- ── 3. investigation_reports ─────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS investigation_reports (
    id                   SERIAL PRIMARY KEY,
    investigation_id     INT NOT NULL REFERENCES civic_investigations(id) ON DELETE CASCADE,
    report_json          JSONB NOT NULL,
    report_version       INT NOT NULL DEFAULT 1,
    generated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    reviewed_by          INT REFERENCES "user"(id) ON DELETE SET NULL,
    review_status        VARCHAR(25) NOT NULL DEFAULT 'pending'
                             CHECK (review_status IN (
                                 'pending',
                                 'approved',
                                 'rejected',
                                 'revision_requested'
                             )),
    review_notes         TEXT
);

CREATE INDEX IF NOT EXISTS idx_investigation_reports_inv_id
    ON investigation_reports(investigation_id, report_version DESC);

-- ── 4. investigation_recommendations ─────────────────────────────────────────

CREATE TABLE IF NOT EXISTS investigation_recommendations (
    id                   SERIAL PRIMARY KEY,
    investigation_id     INT NOT NULL REFERENCES civic_investigations(id) ON DELETE CASCADE,
    action_title         VARCHAR(200) NOT NULL,
    description          TEXT NOT NULL,
    department_id        VARCHAR(100),
    priority             VARCHAR(20) NOT NULL DEFAULT 'medium'
                             CHECK (priority IN ('low', 'medium', 'high', 'critical')),
    confidence_score     NUMERIC(4,3),
    approval_status      VARCHAR(20) NOT NULL DEFAULT 'pending'
                             CHECK (approval_status IN (
                                 'pending',
                                 'approved',
                                 'rejected',
                                 'modified'
                             )),
    created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_investigation_recs_inv_id
    ON investigation_recommendations(investigation_id);

-- ── 5. investigation_activity ────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS investigation_activity (
    id                   SERIAL PRIMARY KEY,
    investigation_id     INT NOT NULL REFERENCES civic_investigations(id) ON DELETE CASCADE,
    actor_id             INT REFERENCES "user"(id) ON DELETE SET NULL,
    activity_type        VARCHAR(50) NOT NULL,
    description          TEXT NOT NULL,
    metadata             JSONB DEFAULT '{}'::jsonb,
    created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_investigation_activity_inv_id
    ON investigation_activity(investigation_id, created_at DESC);

-- ── 6. Trigger to automatically update updated_at on modify ──────────────────

CREATE OR REPLACE TRIGGER update_civic_investigations_updated_at
    BEFORE UPDATE ON civic_investigations
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

-- =============================================================================
-- DOWN (manual rollback):
--
--   DROP TABLE IF EXISTS investigation_activity;
--   DROP TABLE IF EXISTS investigation_recommendations;
--   DROP TABLE IF EXISTS investigation_reports;
--   DROP TABLE IF EXISTS investigation_evidence;
--   DROP TABLE IF EXISTS civic_investigations;
-- =============================================================================
