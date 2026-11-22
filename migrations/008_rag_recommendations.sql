-- migrations/008_rag_recommendations.sql
-- Upgrades recommendation engine to RAG by adding context storage and guideline documents

-- 1. Add tracking columns to recommended_action
ALTER TABLE recommended_action ADD COLUMN IF NOT EXISTS retrieved_context JSONB;
ALTER TABLE recommended_action ADD COLUMN IF NOT EXISTS confidence_score NUMERIC(5, 2);

-- 2. Create guideline_document table for internal SOPs
CREATE TABLE IF NOT EXISTS guideline_document (
    id SERIAL PRIMARY KEY,
    title VARCHAR(255) NOT NULL,
    category VARCHAR(50) NOT NULL,
    content TEXT NOT NULL,
    embedding vector(1536),
    source VARCHAR(255),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- 3. Add pgvector index for fast cosine distance search
-- Using ivfflat index (which we likely use for complaints) or hnsw if available.
-- Since this is a small table, a simple index or even exact search without an index is fine, 
-- but we create one for consistency.
CREATE INDEX IF NOT EXISTS idx_guideline_embedding ON guideline_document USING hnsw (embedding vector_cosine_ops);
