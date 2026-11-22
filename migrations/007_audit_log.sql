-- migrations/007_audit_log.sql
-- Adds the immutable audit trail (action_log) for cluster resolution workflow.
-- Enforces cluster.status as a constrained set, renames 'pending' → 'open',
-- and adds a needs_review flag for resolved clusters receiving new complaints.
-- Idempotent — safe to re-run on any environment.

-- ============================================================
-- 1. Rename the 'pending' status to 'open' on existing rows.
--    'open' is cleaner semantics: a cluster is "open" until
--    work begins (in_progress), not merely "pending" something.
-- ============================================================
UPDATE cluster SET status = 'open' WHERE status = 'pending';

-- ============================================================
-- 2. Change the DEFAULT for cluster.status to 'open'.
-- ============================================================
ALTER TABLE cluster ALTER COLUMN status SET DEFAULT 'open';

-- ============================================================
-- 3. Drop any existing status check constraint on cluster
--    (idempotent: ignore if it doesn't exist) and add the
--    4-value enum-like CHECK constraint.
-- ============================================================
DO $$
BEGIN
    -- Drop old constraint if present
    IF EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'cluster'::regclass
          AND conname LIKE '%status%'
    ) THEN
        -- Find and drop it dynamically
        EXECUTE (
            SELECT 'ALTER TABLE cluster DROP CONSTRAINT ' || conname
            FROM pg_constraint
            WHERE conrelid = 'cluster'::regclass
              AND conname LIKE '%status%'
            LIMIT 1
        );
    END IF;
EXCEPTION
    WHEN OTHERS THEN NULL;
END $$;

ALTER TABLE cluster ADD CONSTRAINT cluster_status_check
    CHECK (status IN ('open', 'in_progress', 'resolved', 'escalated'));

-- ============================================================
-- 4. Add needs_review flag.
--    Set to TRUE when a new complaint arrives for a cluster
--    that is already 'resolved' — signals officials to check
--    without auto-reopening (which would silently undo a human
--    resolution without an audit log entry).
-- ============================================================
ALTER TABLE cluster ADD COLUMN IF NOT EXISTS needs_review BOOLEAN NOT NULL DEFAULT FALSE;

-- ============================================================
-- 5. Create the action_log table.
--    APPEND-ONLY by application contract: no UPDATE or DELETE
--    path exists anywhere in the codebase for this table.
--    In managed cloud Postgres (Railway/Render/Neon/Supabase)
--    DB-level REVOKE on the app role is feasible but requires
--    a superuser migration step outside this file; the
--    application layer enforces the constraint instead.
-- ============================================================
CREATE TABLE IF NOT EXISTS action_log (
    id              SERIAL PRIMARY KEY,
    cluster_id      INT NOT NULL REFERENCES cluster(id) ON DELETE CASCADE,
    admin_id        INT NOT NULL REFERENCES "user"(id) ON DELETE RESTRICT,
    action_taken    VARCHAR(50) NOT NULL DEFAULT 'status_change',
    previous_status VARCHAR(20) NOT NULL,
    new_status      VARCHAR(20) NOT NULL,
    note            TEXT,          -- optional comment from the official
    logged_at       TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

-- ============================================================
-- 6. Indexes.
--    (cluster_id, logged_at DESC) — primary access pattern:
--    "give me all history for this cluster, newest first".
-- ============================================================
CREATE INDEX IF NOT EXISTS idx_action_log_cluster_logged
    ON action_log (cluster_id, logged_at DESC);

-- Covering index on admin_id for the join in GET /history
CREATE INDEX IF NOT EXISTS idx_action_log_admin_id
    ON action_log (admin_id);
