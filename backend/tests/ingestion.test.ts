// backend/tests/ingestion.test.ts
//
// Tests for ingestion pipelines: news RSS, social media mock, and shared helpers.
// Mocks the database pool (same pattern as complaints.test.ts).

import jwt from 'jsonwebtoken';
import app from '../src/index';
import { pool } from '../src/config/db';
import { clusterComplaint } from '../src/services/clustering';

process.env.JWT_SECRET = 'civicmind-super-secret-jwt-key-2026-secure';
const adminToken = jwt.sign({ id: 99, role: 'admin' }, process.env.JWT_SECRET, { expiresIn: '1h' });

// ── Mock database pool ──────────────────────────────────────────────────────
jest.mock('../src/config/db', () => {
  const mPool = { query: jest.fn() };
  return { pool: mPool, checkDbConnection: jest.fn().mockResolvedValue(true) };
});

// ── Mock clustering pipeline (prevents real DB/vector calls) ─────────────────
jest.mock('../src/services/clustering', () => ({
  clusterComplaint: jest.fn().mockResolvedValue(1),
  recalculateClusterSeverity: jest.fn().mockResolvedValue(40),
}));

// ── Mock embeddings (deterministic) ─────────────────────────────────────────
jest.mock('../src/services/embeddings', () => ({
  getEmbedding: jest.fn().mockResolvedValue(new Array(1536).fill(0.025)),
}));

// ── Mock recommendations + ranking (prevent async setImmediate side effects) ─
jest.mock('../src/services/recommendations', () => ({
  triggerRecommendationIfNeeded: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../src/services/ranking', () => ({
  updateClusterPriorityScore: jest.fn().mockResolvedValue(0),
}));

const mockPool = pool as unknown as { query: jest.Mock };
const mockClusterComplaint = clusterComplaint as jest.Mock;

// ── Import after mocks are set up ───────────────────────────────────────────
import { isCivicRelevant, inferCategory, ingestNewsFeeds } from '../src/services/ingestion/newsIngestion';
import { ingestSocialMediaPosts } from '../src/services/ingestion/socialIngestion';
import { generateIdempotencyKey, getSourceId, insertAndCluster } from '../src/services/ingestion/common';
import request from 'supertest';

describe('Ingestion Pipeline Tests', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockClusterComplaint.mockResolvedValue(1);
  });

  // ─── Common helpers ─────────────────────────────────────────────────────
  describe('generateIdempotencyKey', () => {
    it('should produce deterministic UUID-format keys from the same input', () => {
      const key1 = generateIdempotencyKey('https://example.com/article/1');
      const key2 = generateIdempotencyKey('https://example.com/article/1');
      expect(key1).toBe(key2);
      // UUID format: 8-4-4-4-12
      expect(key1).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    });

    it('should produce different keys for different inputs', () => {
      const key1 = generateIdempotencyKey('article-alpha');
      const key2 = generateIdempotencyKey('article-beta');
      expect(key1).not.toBe(key2);
    });
  });

  describe('getSourceId', () => {
    it('should return numeric ID for a valid source name', async () => {
      mockPool.query.mockResolvedValueOnce({ rows: [{ id: 5 }] });
      const id = await getSourceId('news_rss');
      expect(id).toBe(5);
    });

    it('should return null for unknown source name', async () => {
      mockPool.query.mockResolvedValueOnce({ rows: [] });
      const id = await getSourceId('nonexistent');
      expect(id).toBeNull();
    });
  });

  describe('insertAndCluster', () => {
    it('should insert a complaint and call clusterComplaint', async () => {
      // INSERT returns a new row
      mockPool.query.mockResolvedValueOnce({ rows: [{ id: 42 }] });

      const id = await insertAndCluster({
        sourceId: 1,
        text: 'Road pothole near MG Road',
        category: 'infrastructure',
        idempotencyKey: generateIdempotencyKey('test-1'),
      });

      expect(id).toBe(42);
      expect(mockClusterComplaint).toHaveBeenCalledWith(42);
    });

    it('should return null and skip clustering on duplicate (ON CONFLICT)', async () => {
      // INSERT returns empty (conflict)
      mockPool.query.mockResolvedValueOnce({ rows: [] });

      const id = await insertAndCluster({
        sourceId: 1,
        text: 'Duplicate complaint',
        category: 'infrastructure',
        idempotencyKey: generateIdempotencyKey('test-dup'),
      });

      expect(id).toBeNull();
      expect(mockClusterComplaint).not.toHaveBeenCalled();
    });
  });

  // ─── News RSS ingestion ──────────────────────────────────────────────────
  describe('News RSS keyword filtering', () => {
    it('should identify civic-relevant text', () => {
      expect(isCivicRelevant('Major pothole on Outer Ring Road')).toBe(true);
      expect(isCivicRelevant('Water supply contaminated in Sector 4')).toBe(true);
      expect(isCivicRelevant('Streetlights not working in JP Nagar')).toBe(true);
      expect(isCivicRelevant('Garbage heap near Central Park')).toBe(true);
      expect(isCivicRelevant('Electricity outage in Rajajinagar')).toBe(true);
      expect(isCivicRelevant('Traffic jam on Hosur Road')).toBe(true);
    });

    it('should reject non-civic text', () => {
      expect(isCivicRelevant('Bollywood movie releases this Friday')).toBe(false);
      expect(isCivicRelevant('Cricket match result India vs Australia')).toBe(false);
      expect(isCivicRelevant('Stock market rallied on Monday')).toBe(false);
    });
  });

  describe('News RSS category inference', () => {
    it('should map keywords to correct categories', () => {
      expect(inferCategory('Pothole on the road caused accident')).toBe('infrastructure');
      expect(inferCategory('Garbage waste piled up near school')).toBe('sanitation');
      expect(inferCategory('No water supply for 3 days')).toBe('utility');
      expect(inferCategory('Streetlights completely dead')).toBe('utility');
      expect(inferCategory('Loud speaker noise at 5 AM')).toBe('noise');
      expect(inferCategory('Hit and run crime near station')).toBe('safety');
    });

    it('should default to other for unmatched text', () => {
      expect(inferCategory('Random text with no civic keywords')).toBe('other');
    });
  });

  describe('ingestNewsFeeds', () => {
    it('should return source-not-found error when news_rss source is missing', async () => {
      mockPool.query.mockResolvedValueOnce({ rows: [] }); // source lookup fails

      const result = await ingestNewsFeeds();
      expect(result.errors).toContain('Source "news_rss" not found in database.');
      expect(result.insertedCount).toBe(0);
    });
  });

  // ─── Social media ingestion ──────────────────────────────────────────────
  describe('Social media mock ingestion', () => {
    it('should return source-not-found error when social_media source is missing', async () => {
      mockPool.query.mockResolvedValueOnce({ rows: [] });

      const result = await ingestSocialMediaPosts();
      expect(result.errors).toContain('Source "social_media" not found in database.');
      expect(result.insertedCount).toBe(0);
    });

    it('should ingest mock posts through the pipeline without errors', async () => {
      // Source lookup
      mockPool.query.mockResolvedValueOnce({ rows: [{ id: 2 }] });

      // Mock 20 posts × 1 INSERT each (all succeed, none duplicate)
      for (let i = 0; i < 20; i++) {
        mockPool.query.mockResolvedValueOnce({ rows: [{ id: 100 + i }] });
      }

      const result = await ingestSocialMediaPosts();

      expect(result.errors).toHaveLength(0);
      expect(result.insertedCount).toBe(20);
      expect(result.skippedDuplicate).toBe(0);
      expect(result.totalPosts).toBe(20);
      // clusterComplaint should have been called once per inserted post
      expect(mockClusterComplaint).toHaveBeenCalledTimes(20);
    });

    it('should skip duplicate posts gracefully', async () => {
      // Source lookup
      mockPool.query.mockResolvedValueOnce({ rows: [{ id: 2 }] });

      // All 20 inserts return empty (all duplicates)
      for (let i = 0; i < 20; i++) {
        mockPool.query.mockResolvedValueOnce({ rows: [] });
      }

      const result = await ingestSocialMediaPosts();

      expect(result.insertedCount).toBe(0);
      expect(result.skippedDuplicate).toBe(20);
      expect(mockClusterComplaint).not.toHaveBeenCalled();
    });
  });

  // ─── Source ID attachment via HTTP routes ────────────────────────────────
  describe('POST /api/ingest/news', () => {
    it('should reject unauthenticated requests', async () => {
      const res = await request(app).post('/api/ingest/news');
      expect(res.status).toBe(401);
    });

    it('should reject citizen role', async () => {
      const citizenToken = jwt.sign({ id: 1, role: 'citizen' }, process.env.JWT_SECRET!, { expiresIn: '1h' });
      const res = await request(app)
        .post('/api/ingest/news')
        .set('Authorization', `Bearer ${citizenToken}`);
      expect(res.status).toBe(403);
    });
  });

  describe('POST /api/ingest/social', () => {
    it('should reject unauthenticated requests', async () => {
      const res = await request(app).post('/api/ingest/social');
      expect(res.status).toBe(401);
    });

    it('should accept admin role', async () => {
      // Mock source lookup returning ID
      mockPool.query.mockResolvedValueOnce({ rows: [{ id: 2 }] });
      // Mock all 20 inserts as new (returning IDs)
      for (let i = 0; i < 20; i++) {
        mockPool.query.mockResolvedValueOnce({ rows: [{ id: 200 + i }] });
      }

      const res = await request(app)
        .post('/api/ingest/social')
        .set('Authorization', `Bearer ${adminToken}`);

      expect(res.status).toBe(200);
      expect(res.body.message).toBe('Social media ingestion complete');
      expect(res.body.data.insertedCount).toBe(20);
    });
  });
});
