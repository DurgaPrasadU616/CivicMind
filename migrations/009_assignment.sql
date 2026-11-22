-- migrations/009_assignment.sql

-- Add assignment tracking to cluster
ALTER TABLE cluster ADD COLUMN IF NOT EXISTS assigned_department VARCHAR(100);
ALTER TABLE cluster ADD COLUMN IF NOT EXISTS assigned_officer_id INT REFERENCES "user"(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_cluster_assigned_dept ON cluster(assigned_department);
CREATE INDEX IF NOT EXISTS idx_cluster_assigned_officer ON cluster(assigned_officer_id);
