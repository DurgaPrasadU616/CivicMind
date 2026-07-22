-- migrations/006_ingestion_log.sql
-- Table for logging background/scheduled ingestion pipeline runs.
-- Idempotent — safe to re-run on any environment.

CREATE TABLE IF NOT EXISTS ingestion_log (
    id           SERIAL PRIMARY KEY,
    source_type  VARCHAR(50) NOT NULL,
    run_at       TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP NOT NULL,
    processed    INT NOT NULL DEFAULT 0,
    created      INT NOT NULL DEFAULT 0,
    duplicates   INT NOT NULL DEFAULT 0,
    errors       INT NOT NULL DEFAULT 0,
    failed_feeds TEXT[],
    status       VARCHAR(20) NOT NULL CHECK (status IN ('success', 'partial', 'failed'))
);

-- Index on run_at DESC for fast dashboard audit queries
CREATE INDEX IF NOT EXISTS idx_ingestion_log_run_at ON ingestion_log(run_at DESC);

-- Service Account support on user table
ALTER TABLE "user" ADD COLUMN IF NOT EXISTS is_service_account BOOLEAN NOT NULL DEFAULT FALSE;

-- Update role check constraint on user table to allow 'service_account'
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'user_role_check'
    ) THEN
        ALTER TABLE "user" DROP CONSTRAINT user_role_check;
    END IF;
    ALTER TABLE "user" ADD CONSTRAINT user_role_check CHECK (role IN ('citizen', 'ngo', 'govt', 'admin', 'service_account'));
EXCEPTION
    WHEN OTHERS THEN NULL;
END $$;
