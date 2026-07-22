-- migrations/001_init.sql

-- Enable uuid-ossp extension in case we want to generate UUIDs in database (optional, since client provides them for idempotency)
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Table to store ingestion sources
CREATE TABLE IF NOT EXISTS source (
    id SERIAL PRIMARY KEY,
    name VARCHAR(50) UNIQUE NOT NULL,
    description TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Table to store citizen complaints
CREATE TABLE IF NOT EXISTS complaint (
    id SERIAL PRIMARY KEY,
    source_id INT NOT NULL REFERENCES source(id) ON DELETE RESTRICT,
    text TEXT NOT NULL,
    category VARCHAR(50) NOT NULL,
    latitude DECIMAL(10, 8),
    longitude DECIMAL(11, 8),
    status VARCHAR(20) NOT NULL DEFAULT 'pending',
    severity_score INT,
    priority_score INT,
    idempotency_key UUID UNIQUE NOT NULL,
    meta_data JSONB DEFAULT '{}'::jsonb,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Indexes for performance & query optimization
CREATE INDEX IF NOT EXISTS idx_complaint_source_id ON complaint(source_id);
CREATE INDEX IF NOT EXISTS idx_complaint_status ON complaint(status);
CREATE INDEX IF NOT EXISTS idx_complaint_idempotency_key ON complaint(idempotency_key);
CREATE INDEX IF NOT EXISTS idx_complaint_created_at ON complaint(created_at DESC);

-- Trigger to automatically update updated_at on modify
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$$ language 'plpgsql';

CREATE OR REPLACE TRIGGER update_complaint_updated_at
    BEFORE UPDATE ON complaint
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

-- Seed initial ingestion sources
INSERT INTO source (name, description) VALUES
('citizen_portal', 'Complaints submitted directly by citizens through the official web portal'),
('social_media', 'Complaints scraped or ingested from social media sites (e.g. Twitter/X, Facebook)'),
('survey', 'Responses and issues collected from citizen satisfaction or feedback surveys'),
('ngo_report', 'Structured reports provided by verified NGOs or civic groups'),
('news_rss', 'Flagged civic issues parsed from news websites and RSS feeds')
ON CONFLICT (name) DO UPDATE SET description = EXCLUDED.description;
