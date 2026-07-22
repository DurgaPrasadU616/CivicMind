-- migrations/003_recommendations.sql
-- Adds severity band tracking to cluster and creates recommended_action history table.

-- Track which severity band was last active so we only regenerate on escalation
ALTER TABLE cluster ADD COLUMN IF NOT EXISTS last_severity_band VARCHAR(10);

-- History table for recommended actions (never overwritten — use status to track active/superseded)
CREATE TABLE IF NOT EXISTS recommended_action (
    id SERIAL PRIMARY KEY,
    cluster_id INT NOT NULL REFERENCES cluster(id) ON DELETE CASCADE,
    action_text TEXT NOT NULL,
    generated_by VARCHAR(20) NOT NULL DEFAULT 'gemini', -- 'gemini' | 'rule_based'
    status VARCHAR(20) NOT NULL DEFAULT 'active',       -- 'active' | 'superseded'
    generated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_rec_action_cluster_id ON recommended_action(cluster_id);
CREATE INDEX IF NOT EXISTS idx_rec_action_status ON recommended_action(cluster_id, status);
