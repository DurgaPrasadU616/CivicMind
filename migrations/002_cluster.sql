-- migrations/002_cluster.sql

-- Enable pgvector extension (supported on standard platforms like Railway, Render, Neon, Supabase)
CREATE EXTENSION IF NOT EXISTS vector;

-- Table to store aggregated clusters
CREATE TABLE IF NOT EXISTS cluster (
    id SERIAL PRIMARY KEY,
    title VARCHAR(255) NOT NULL,
    category VARCHAR(50) NOT NULL,
    region VARCHAR(50) NOT NULL,
    severity_score INT DEFAULT 40,
    complaint_count INT DEFAULT 0,
    status VARCHAR(20) NOT NULL DEFAULT 'pending',
    recommended_action TEXT,
    centroid vector(1536), -- 1536-dimensional centroid representing the cluster's text content
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Modify complaints table to link to cluster and store vector embedding
ALTER TABLE complaint ADD COLUMN IF NOT EXISTS embedding vector(1536);
ALTER TABLE complaint ADD COLUMN IF NOT EXISTS cluster_id INT REFERENCES cluster(id) ON DELETE SET NULL;

-- Index to optimize querying of linked complaints
CREATE INDEX IF NOT EXISTS idx_complaint_cluster_id ON complaint(cluster_id);
