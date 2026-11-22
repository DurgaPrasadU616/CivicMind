-- migrations/015_civic_actions.sql
--
-- Phase 5 — Civic Action & Resolution Intelligence
-- Tracks approved investigation recommendations through to verified civic resolution.
--
-- Tables:
--   1. civic_actions          — Master action tracking with full lifecycle
--   2. action_assignments     — Department/officer assignment history
--   3. action_status_history  — Append-only state machine audit log
--   4. resolution_evidence    — Before/after verification media
--   5. sla_configurations     — Configurable SLA deadlines per jurisdiction
--   6. action_notifications   — Deduplication for notification dispatch
--
-- ✅ Additive only — no existing columns or tables modified.
-- ✅ Idempotent — safe to re-run on any environment (IF NOT EXISTS).
-- ✅ Reversible — see DOWN section.
-- =============================================================================

-- ── 1. civic_actions ─────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS civic_actions (
    id                       SERIAL PRIMARY KEY,
    investigation_id         INT REFERENCES civic_investigations(id) ON DELETE SET NULL,
    recommendation_id        INT REFERENCES investigation_recommendations(id) ON DELETE SET NULL,
    cluster_id               INT REFERENCES cluster(id) ON DELETE SET NULL,
    action_title             VARCHAR(255) NOT NULL,
    description              TEXT NOT NULL,
    department_id            VARCHAR(100),
    department_name          VARCHAR(150),
    status                   VARCHAR(30) NOT NULL DEFAULT 'pending_approval'
                                 CHECK (status IN (
                                     'pending_approval',
                                     'approved',
                                     'assigned',
                                     'in_progress',
                                     'awaiting_verification',
                                     'resolved',
                                     'rejected',
                                     'on_hold',
                                     'overdue',
                                     'reopened',
                                     'cancelled'
                                 )),
    priority                 VARCHAR(20) NOT NULL DEFAULT 'medium'
                                 CHECK (priority IN ('low', 'medium', 'high', 'critical')),
    created_by               INT REFERENCES "user"(id) ON DELETE SET NULL,
    approved_by              INT REFERENCES "user"(id) ON DELETE SET NULL,
    assigned_by              INT REFERENCES "user"(id) ON DELETE SET NULL,
    created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    approved_at              TIMESTAMPTZ,
    assigned_at              TIMESTAMPTZ,
    expected_completion_date TIMESTAMPTZ,
    actual_completion_date   TIMESTAMPTZ,
    overdue_since            TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_civic_actions_status
    ON civic_actions(status, priority);

CREATE INDEX IF NOT EXISTS idx_civic_actions_investigation_id
    ON civic_actions(investigation_id);

CREATE INDEX IF NOT EXISTS idx_civic_actions_recommendation_id
    ON civic_actions(recommendation_id);

CREATE INDEX IF NOT EXISTS idx_civic_actions_cluster_id
    ON civic_actions(cluster_id);

CREATE INDEX IF NOT EXISTS idx_civic_actions_department_id
    ON civic_actions(department_id);

CREATE INDEX IF NOT EXISTS idx_civic_actions_created_at
    ON civic_actions(created_at DESC);

CREATE INDEX IF NOT EXISTS idx_civic_actions_expected_completion
    ON civic_actions(expected_completion_date)
    WHERE status NOT IN ('resolved', 'cancelled', 'rejected');

-- ── 2. action_assignments ────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS action_assignments (
    id                       SERIAL PRIMARY KEY,
    action_id                INT NOT NULL REFERENCES civic_actions(id) ON DELETE CASCADE,
    department_name          VARCHAR(150),
    department_id            VARCHAR(100),
    officer_id               INT REFERENCES "user"(id) ON DELETE SET NULL,
    officer_name             VARCHAR(150),
    assigned_by              INT REFERENCES "user"(id) ON DELETE SET NULL,
    expected_completion_date TIMESTAMPTZ,
    priority                 VARCHAR(20) CHECK (priority IN ('low', 'medium', 'high', 'critical')),
    notes                    TEXT,
    assigned_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    is_current               BOOLEAN NOT NULL DEFAULT TRUE
);

CREATE INDEX IF NOT EXISTS idx_action_assignments_action_id
    ON action_assignments(action_id, is_current);

-- ── 3. action_status_history ─────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS action_status_history (
    id              SERIAL PRIMARY KEY,
    action_id       INT NOT NULL REFERENCES civic_actions(id) ON DELETE CASCADE,
    previous_status VARCHAR(30),
    new_status      VARCHAR(30) NOT NULL,
    changed_by      INT REFERENCES "user"(id) ON DELETE SET NULL,
    change_reason   TEXT,
    metadata        JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_action_status_history_action_id
    ON action_status_history(action_id, created_at DESC);

-- ── 4. resolution_evidence ───────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS resolution_evidence (
    id                   SERIAL PRIMARY KEY,
    action_id            INT NOT NULL REFERENCES civic_actions(id) ON DELETE CASCADE,
    evidence_type        VARCHAR(30) NOT NULL
                             CHECK (evidence_type IN (
                                 'before',
                                 'after',
                                 'progress',
                                 'completion_report'
                             )),
    storage_key          VARCHAR(512) NOT NULL,
    original_filename    VARCHAR(255),
    mime_type            VARCHAR(100),
    file_size            BIGINT,
    uploaded_by          INT REFERENCES "user"(id) ON DELETE SET NULL,
    description          TEXT,
    ai_analysis          JSONB,
    ai_confidence_score  NUMERIC(4,3),
    needs_human_review   BOOLEAN NOT NULL DEFAULT TRUE,
    verification_status  VARCHAR(20) NOT NULL DEFAULT 'pending'
                             CHECK (verification_status IN ('pending', 'verified', 'rejected')),
    created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    verified_at          TIMESTAMPTZ,
    verified_by          INT REFERENCES "user"(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_resolution_evidence_action_id
    ON resolution_evidence(action_id, evidence_type);

-- ── 5. sla_configurations ────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS sla_configurations (
    id                   SERIAL PRIMARY KEY,
    state                VARCHAR(100),
    district             VARCHAR(100),
    municipality         VARCHAR(100),
    department_id        VARCHAR(100),
    complaint_category   VARCHAR(50),
    priority             VARCHAR(20) CHECK (priority IN ('low', 'medium', 'high', 'critical')),
    response_hours       INT NOT NULL CHECK (response_hours > 0),
    resolution_hours     INT NOT NULL CHECK (resolution_hours > 0),
    source_description   TEXT,
    is_verified          BOOLEAN NOT NULL DEFAULT FALSE,
    configuration_type   VARCHAR(20) NOT NULL DEFAULT 'estimated'
                             CHECK (configuration_type IN ('statutory', 'estimated', 'manual')),
    created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_sla_configurations_lookup
    ON sla_configurations(state, department_id, complaint_category, priority);

-- ── 6. action_notifications ──────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS action_notifications (
    id                SERIAL PRIMARY KEY,
    action_id         INT NOT NULL REFERENCES civic_actions(id) ON DELETE CASCADE,
    notification_type VARCHAR(50) NOT NULL,
    recipient_id      INT REFERENCES "user"(id) ON DELETE SET NULL,
    sent_at           TIMESTAMPTZ,
    delivery_status   VARCHAR(20) NOT NULL DEFAULT 'queued'
                          CHECK (delivery_status IN ('queued', 'sent', 'failed', 'skipped')),
    dedupe_key        VARCHAR(255) UNIQUE,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_action_notifications_action_id
    ON action_notifications(action_id);

-- ── 7. Trigger for updated_at ────────────────────────────────────────────────

CREATE OR REPLACE TRIGGER update_civic_actions_updated_at
    BEFORE UPDATE ON civic_actions
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

CREATE OR REPLACE TRIGGER update_sla_configurations_updated_at
    BEFORE UPDATE ON sla_configurations
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

-- ── 8. Seed reference SLA data ───────────────────────────────────────────────
-- Source: Phase 4 publicResearchService research. All is_verified=false,
-- configuration_type='estimated'. Do NOT treat these as official government mandates.

INSERT INTO sla_configurations
    (state, district, municipality, department_id, complaint_category, priority,
     response_hours, resolution_hours, source_description, is_verified, configuration_type)
VALUES
    -- Karnataka / BBMP
    ('Karnataka', 'Bengaluru Urban', 'BBMP', 'bbmp_roads', 'infrastructure', 'high',
     48, 168, 'BBMP estimated pothole response target — not a statutory mandate', false, 'estimated'),
    ('Karnataka', 'Bengaluru Urban', 'BBMP', 'bbmp_roads', 'infrastructure', 'critical',
     24, 72, 'BBMP critical road damage estimated response', false, 'estimated'),
    ('Karnataka', 'Bengaluru Urban', 'BWSSB', 'bwssb', 'utility', 'critical',
     4, 24, 'BWSSB pipe burst estimated response target', false, 'estimated'),
    ('Karnataka', 'Bengaluru Urban', 'BESCOM', 'bescom', 'utility', 'critical',
     6, 12, 'BESCOM power outage inspection estimated target', false, 'estimated'),
    ('Karnataka', 'Bengaluru Urban', 'BBMP', 'bbmp_sanitation', 'sanitation', 'high',
     24, 72, 'BBMP solid waste collection estimated target', false, 'estimated'),
    -- Andhra Pradesh
    ('Andhra Pradesh', NULL, NULL, 'ghmc', 'infrastructure', 'high',
     48, 192, 'GHMC estimated road repair response (Andhra Pradesh)', false, 'estimated'),
    ('Andhra Pradesh', NULL, NULL, 'apspdcl', 'utility', 'critical',
     8, 24, 'APSPDCL power restoration estimated target', false, 'estimated'),
    -- Generic fallback
    (NULL, NULL, NULL, NULL, 'infrastructure', 'medium',
     72, 336, 'Generic infrastructure SLA estimate — verify with local authority', false, 'estimated'),
    (NULL, NULL, NULL, NULL, 'utility', 'high',
     12, 48, 'Generic utility SLA estimate — verify with local authority', false, 'estimated'),
    (NULL, NULL, NULL, NULL, 'sanitation', 'medium',
     48, 168, 'Generic sanitation SLA estimate — verify with local authority', false, 'estimated')
ON CONFLICT DO NOTHING;

-- =============================================================================
-- DOWN (manual rollback):
--
--   DROP TABLE IF EXISTS action_notifications;
--   DROP TABLE IF EXISTS sla_configurations;
--   DROP TABLE IF EXISTS resolution_evidence;
--   DROP TABLE IF EXISTS action_status_history;
--   DROP TABLE IF EXISTS action_assignments;
--   DROP TABLE IF EXISTS civic_actions;
-- =============================================================================
