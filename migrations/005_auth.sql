-- migrations/005_auth.sql
-- Adds the user table for real JWT-based authentication.
-- Idempotent — safe to re-run on any environment.

CREATE TABLE IF NOT EXISTS "user" (
    id           SERIAL PRIMARY KEY,
    name         VARCHAR(100) NOT NULL,
    email        VARCHAR(255) NOT NULL,
    password_hash TEXT NOT NULL,
    role         VARCHAR(20)  NOT NULL DEFAULT 'citizen'
                   CHECK (role IN ('citizen', 'ngo', 'govt', 'admin')),
    created_at   TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Enforce unique emails (idempotent)
CREATE UNIQUE INDEX IF NOT EXISTS idx_user_email ON "user"(email);

-- Speed up role-based queries
CREATE INDEX IF NOT EXISTS idx_user_role ON "user"(role);
