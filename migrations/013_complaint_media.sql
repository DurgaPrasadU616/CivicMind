-- migrations/013_complaint_media.sql
--
-- Phase 3 — Multimodal Complaint Intelligence
-- Creates the complaint_media table to track uploaded images, audio, and video
-- attached to civic complaints.
--
-- Design decisions:
--   • ADDITIVE ONLY — no existing columns are dropped or renamed.
--   • Idempotent — safe to run multiple times (IF NOT EXISTS guards).
--   • Reversible — see DOWN section.
--   • storage_key is an opaque identifier managed by the StorageProvider
--     (filesystem path segment, S3 key, GCS object name, etc.).
--   • extracted_description and detected_category are populated by the
--     Gemini multimodal analysis pipeline AFTER upload.
--   • processing_status tracks the analysis lifecycle:
--       pending  → queued for analysis
--       processing → AI analysis in progress
--       completed → analysis succeeded
--       failed    → analysis failed (error_message populated)
--       skipped   → media bypassed analysis (e.g. unsupported format)
-- ============================================================================

-- ── 1. Create complaint_media table ─────────────────────────────────────────

CREATE TABLE IF NOT EXISTS complaint_media (
    id                   SERIAL PRIMARY KEY,

    -- Link to parent complaint (required — orphan media is not allowed)
    complaint_id         INT NOT NULL REFERENCES complaint(id) ON DELETE CASCADE,

    -- Type of media file uploaded
    media_type           VARCHAR(10) NOT NULL
                             CHECK (media_type IN ('image', 'audio', 'video')),

    -- Opaque key used to retrieve the file from the StorageProvider.
    -- For local disk: relative path under MEDIA_STORAGE_DIR.
    -- For S3/GCS: object key.
    storage_key          TEXT NOT NULL,

    -- Original filename provided by the uploader (sanitised; informational only)
    original_filename    VARCHAR(255) NOT NULL,

    -- MIME type as reported by the upload (validated against allow-list)
    mime_type            VARCHAR(100) NOT NULL,

    -- File size in bytes (validated against MAX_MEDIA_SIZE_BYTES)
    file_size            INT NOT NULL,

    -- AI analysis lifecycle status
    processing_status    VARCHAR(20) NOT NULL DEFAULT 'pending'
                             CHECK (processing_status IN (
                                 'pending', 'processing', 'completed', 'failed', 'skipped'
                             )),

    -- AI-generated plain-text description of the civic issue visible in the media
    extracted_description TEXT,

    -- Civic category suggested by AI analysis
    detected_category    VARCHAR(50),

    -- AI confidence score for detected_category (0.0–1.0)
    confidence_score     NUMERIC(4,3),

    -- Timestamps
    created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    processed_at         TIMESTAMPTZ,

    -- Error detail when processing_status = 'failed'
    error_message        TEXT,

    -- Whether the AI flagged this media for human review
    needs_human_review   BOOLEAN NOT NULL DEFAULT FALSE
);

-- ── 2. Indexes ───────────────────────────────────────────────────────────────

-- Primary access pattern: "get all media for this complaint"
CREATE INDEX IF NOT EXISTS idx_complaint_media_complaint_id
    ON complaint_media (complaint_id);

-- Dashboard / monitoring: "find all pending or failed media jobs"
CREATE INDEX IF NOT EXISTS idx_complaint_media_processing_status
    ON complaint_media (processing_status, created_at DESC);

-- ── 3. Comments ─────────────────────────────────────────────────────────────

COMMENT ON TABLE complaint_media IS
    'Phase 3: Multimodal media attachments (images, audio, video) uploaded alongside civic complaints. '
    'AI analysis results (extracted_description, detected_category) are populated asynchronously.';

-- ============================================================================
-- DOWN (manual rollback):
--
--   DROP TABLE IF EXISTS complaint_media;
-- ============================================================================
