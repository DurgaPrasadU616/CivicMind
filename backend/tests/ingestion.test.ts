// backend/tests/ingestion.test.ts
//
// Tests for ingestion pipelines: news RSS, social media mock, shared helpers,
// ingestion audit logging, service account permissions, and dedup verification.

import jwt from 'jsonwebtoken';
import app from '../src/index';
import { pool } from '../src/config/db';
import { clusterComplaint } from '../src/services/clustering';

process.env.JWT_SECRET = 'civicmind-super-secret-jwt-key-2026-secure';
const adminToken = jwt.sign({ id: 99, role: 'admin' }, process.env.JWT_SECRET, { expiresIn: '1h' });
const govtToken = jwt.sign({ id: 88, role: 'govt' }, process.env.JWT_SECRET, { expiresIn: '1h' });
const serviceAccountToken = jwt.sign({ id: 77, role: 'service_account' }, process.env.JWT_SECRET, { expiresIn: '1h' });
const citizenToken = jwt.sign({ id: 1, role: 'citizen' }, process.env.JWT_SECRET, { expiresIn: '1h' });

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

// ── Mock recommendations + ranking ──────────────────────────────────────────
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

describe('Ingestion Pipeline & Audit Logging Tests', () => {
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
  describe('News RSS keyword filtering & category inference', () => {
    it('should identify civic-relevant text and reject non-civic text', () => {
      expect(isCivicRelevant('Major pothole on Outer Ring Road')).toBe(true);
      expect(isCivicRelevant('Water supply contaminated in Sector 4')).toBe(true);
      expect(isCivicRelevant('Bollywood movie releases this Friday')).toBe(false);
    });

    it('should map keywords to correct categories', () => {
      expect(inferCategory('Pothole on the road caused accident')).toBe('infrastructure');
      expect(inferCategory('Garbage waste piled up near school')).toBe('sanitation');
      expect(inferCategory('No water supply for 3 days')).toBe('utility');
      expect(inferCategory('Random text')).toBe('other');
    });
  });

  describe('ingestNewsFeeds & ingestion_log auditing', () => {
    it('should write failed status to ingestion_log when source is missing', async () => {
      mockPool.query.mockResolvedValueOnce({ rows: [] }); // source lookup returns empty
      mockPool.query.mockResolvedValueOnce({ rows: [{ id: 501 }] }); // log write

      const result = await ingestNewsFeeds();
      expect(result.errors).toContain('Source "news_rss" not found in database.');
      expect(result.status).toBe('failed');
      expect(result.logId).toBe(501);
    });

    it('should log partial status when 1 of 3 RSS feeds fails', async () => {
      // Source lookup
      mockPool.query.mockResolvedValueOnce({ rows: [{ id: 1 }] });

      // Mock fetch results for custom 2 feeds (1 valid, 1 invalid URL)
      const feeds = ['https://valid-rss.example.com/feed.xml', 'https://invalid-rss.example.com/feed.xml'];

      // Global fetch mock to simulate 1 working, 1 500 error
      const originalFetch = global.fetch;
      global.fetch = jest.fn().mockImplementation((url: string) => {
        if (url.includes('invalid')) {
          return Promise.resolve({ ok: false, status: 500 });
        }
        return Promise.resolve({
          ok: true,
          text: async () => `
            <rss version="2.0">
              <channel>
                <item>
                  <title>Road pothole causing traffic jam</title>
                  <description>Pothole on main highway causing accidents</description>
                  <link>https://valid-rss.example.com/item/1</link>
                </item>
              </channel>
            </rss>`,
        });
      }) as any;

      // Insert for the 1 valid item
      mockPool.query.mockResolvedValueOnce({ rows: [{ id: 10 }] });
      // Log entry insert
      mockPool.query.mockResolvedValueOnce({ rows: [{ id: 502 }] });

      const result = await ingestNewsFeeds(feeds);

      global.fetch = originalFetch;

      expect(result.status).toBe('partial');
      expect(result.failedFeeds).toContain('https://invalid-rss.example.com/feed.xml');
      expect(result.insertedCount).toBe(1);
      expect(result.logId).toBe(502);
    });
  });

  // ─── Social Media Ingestion ──────────────────────────────────────────────
  describe('ingestSocialMediaPosts & ingestion_log auditing', () => {
    it('should ingest mock posts and log success status to ingestion_log', async () => {
      // Source lookup
      mockPool.query.mockResolvedValueOnce({ rows: [{ id: 2 }] });

      // 20 posts × insert mock
      for (let i = 0; i < 20; i++) {
        mockPool.query.mockResolvedValueOnce({ rows: [{ id: 200 + i }] });
      }

      // Ingestion log insert
      mockPool.query.mockResolvedValueOnce({ rows: [{ id: 503 }] });

      const result = await ingestSocialMediaPosts();

      expect(result.status).toBe('success');
      expect(result.insertedCount).toBe(20);
      expect(result.skippedDuplicate).toBe(0);
      expect(result.logId).toBe(503);
    });
  });

  // ─── Dedup Verification on Rerun ─────────────────────────────────────────
  describe('Ingestion Same-Day Rerun Dedup', () => {
    it('should skip 100% of posts and insert 0 duplicates when social ingestion is triggered twice', async () => {
      // Source lookup for 2nd run
      mockPool.query.mockResolvedValueOnce({ rows: [{ id: 2 }] });

      // 20 posts return empty rows (ON CONFLICT DO NOTHING)
      for (let i = 0; i < 20; i++) {
        mockPool.query.mockResolvedValueOnce({ rows: [] });
      }

      // Log entry insert
      mockPool.query.mockResolvedValueOnce({ rows: [{ id: 504 }] });

      const result = await ingestSocialMediaPosts();

      expect(result.insertedCount).toBe(0);
      expect(result.skippedDuplicate).toBe(20);
      expect(result.status).toBe('success');
      expect(mockClusterComplaint).not.toHaveBeenCalled();
    });
  });

  // ─── Service Account Authorization & Permission Isolation ────────────────
  describe('Service Account Security & Permissions', () => {
    it('should ALLOW Service Account to call POST /api/ingest/news', async () => {
      mockPool.query.mockResolvedValueOnce({ rows: [{ id: 1 }] }); // source lookup
      mockPool.query.mockResolvedValueOnce({ rows: [{ id: 505 }] }); // log insert

      const res = await request(app)
        .post('/api/ingest/news')
        .set('Authorization', `Bearer ${serviceAccountToken}`);

      expect(res.status).toBe(200);
      expect(res.body.message).toBe('News RSS ingestion complete');
    });

    it('should ALLOW Service Account to call POST /api/ingest/social', async () => {
      mockPool.query.mockResolvedValueOnce({ rows: [{ id: 2 }] }); // source lookup
      for (let i = 0; i < 20; i++) {
        mockPool.query.mockResolvedValueOnce({ rows: [{ id: 300 + i }] });
      }
      mockPool.query.mockResolvedValueOnce({ rows: [{ id: 506 }] }); // log insert

      const res = await request(app)
        .post('/api/ingest/social')
        .set('Authorization', `Bearer ${serviceAccountToken}`);

      expect(res.status).toBe(200);
      expect(res.body.message).toBe('Social media ingestion complete');
    });

    it('should REJECT Service Account (403 Forbidden) on admin audit route GET /api/ingestion/log', async () => {
      const res = await request(app)
        .get('/api/ingestion/log')
        .set('Authorization', `Bearer ${serviceAccountToken}`);

      expect(res.status).toBe(403);
      expect(res.body.error).toContain('Insufficient permissions');
    });

    it('should ALLOW Govt/Admin accounts to access GET /api/ingestion/log', async () => {
      mockPool.query.mockResolvedValueOnce({ rows: [{ count: '1' }] }); // count query
      mockPool.query.mockResolvedValueOnce({
        rows: [
          {
            id: 1,
            source_type: 'news_rss',
            run_at: new Date().toISOString(),
            processed: 10,
            created: 5,
            duplicates: 5,
            errors: 0,
            failed_feeds: null,
            status: 'success',
          },
        ],
      }); // log query

      const res = await request(app)
        .get('/api/ingestion/log')
        .set('Authorization', `Bearer ${govtToken}`);

      expect(res.status).toBe(200);
      expect(res.body.logs).toHaveLength(1);
      expect(res.body.logs[0].source_type).toBe('news_rss');
    });
  });
});
