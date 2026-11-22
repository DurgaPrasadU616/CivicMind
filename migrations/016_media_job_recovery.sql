-- Phase 2B.5: bounded retries, durable recovery leases, and attempt history.
-- Additive only. Do not apply to production without explicit approval.

ALTER TABLE complaint_media
    ADD COLUMN IF NOT EXISTS attempt_count INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS next_retry_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS lease_token UUID,
    ADD COLUMN IF NOT EXISTS lease_until TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS manual_intervention BOOLEAN NOT NULL DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS failure_history JSONB NOT NULL DEFAULT '[]'::JSONB;

-- Existing failed rows lack enough classification/history to safely auto-retry.
-- Leave them visible for explicit manual review/retry instead of replaying them blindly.
UPDATE complaint_media
SET manual_intervention = TRUE,
    failure_history = failure_history || jsonb_build_array(
        jsonb_build_object(
            'at', NOW(),
            'status', 'manual_intervention',
            'reason', 'legacy_failed_row_requires_review'
        )
    )
WHERE processing_status = 'failed'
  AND manual_intervention = FALSE;

-- Give already-running workers a full lease window after migration before a
-- recovery invocation may reclaim them. New jobs use the same 30-minute lease.
UPDATE complaint_media
SET lease_until = NOW() + INTERVAL '30 minutes'
WHERE processing_status = 'processing'
  AND lease_until IS NULL;

CREATE INDEX IF NOT EXISTS idx_complaint_media_recovery_due
    ON complaint_media (next_retry_at, created_at, id)
    WHERE processing_status IN ('pending', 'failed', 'processing')
      AND manual_intervention = FALSE;

COMMENT ON COLUMN complaint_media.attempt_count IS
    'Number of worker claims for the current media analysis lifecycle; bounded by MAX_MEDIA_ANALYSIS_ATTEMPTS.';
COMMENT ON COLUMN complaint_media.next_retry_at IS
    'Earliest time a retryable failed media job may be claimed by a worker.';
COMMENT ON COLUMN complaint_media.lease_until IS
    'Expiration time for the PostgreSQL-backed media worker claim; expired claims are reclaimable.';
COMMENT ON COLUMN complaint_media.manual_intervention IS
    'True when media is permanent-invalid, has exhausted bounded retries, or is an unclassified legacy failure.';
COMMENT ON COLUMN complaint_media.failure_history IS
    'Append-only JSONB history of analysis attempts and manual-intervention decisions.';

-- Manual rollback (only after stopping media workers):
-- DROP INDEX IF EXISTS idx_complaint_media_recovery_due;
-- ALTER TABLE complaint_media
--   DROP COLUMN IF EXISTS attempt_count,
--   DROP COLUMN IF EXISTS next_retry_at,
--   DROP COLUMN IF EXISTS lease_token,
--   DROP COLUMN IF EXISTS lease_until,
--   DROP COLUMN IF EXISTS manual_intervention,
--   DROP COLUMN IF EXISTS failure_history;
