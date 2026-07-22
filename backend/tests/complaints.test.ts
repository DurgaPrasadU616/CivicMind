import request from 'supertest';
import jwt from 'jsonwebtoken';
import app from '../src/index';
import { pool, checkDbConnection } from '../src/config/db';
import { clusterComplaint, recalculateClusterSeverity } from '../src/services/clustering';
import { getEmbedding } from '../src/services/embeddings';
import { triggerRecommendationIfNeeded } from '../src/services/recommendations';
import { updateClusterPriorityScore } from '../src/services/ranking';

// Valid govt JWT for routes that require authentication
process.env.JWT_SECRET = 'civicmind-super-secret-jwt-key-2026-secure';
const govtToken = jwt.sign({ id: 99, role: 'govt' }, process.env.JWT_SECRET, { expiresIn: '1h' });

// Mock the database pool and health check helper
jest.mock('../src/config/db', () => {
  const mPool = {
    query: jest.fn(),
  };
  return {
    pool: mPool,
    checkDbConnection: jest.fn(),
  };
});

// Mock embeddings API
jest.mock('../src/services/embeddings', () => ({
  getEmbedding: jest.fn(),
}));

// Mock the recommendations service to prevent async setImmediate DB calls
// from bleeding into subsequent tests. The service itself is tested separately.
jest.mock('../src/services/recommendations', () => ({
  triggerRecommendationIfNeeded: jest.fn().mockReturnValue(Promise.resolve()),
  generateRecommendedAction: jest.fn().mockReturnValue(Promise.resolve()),
  storeAction: jest.fn().mockReturnValue(Promise.resolve()),
  getSeverityBand: jest.requireActual('../src/services/recommendations').getSeverityBand,
  isBandEscalation: jest.requireActual('../src/services/recommendations').isBandEscalation,
}));

// Mock the ranking service to prevent updateClusterPriorityScore DB calls
// from leaking into complaints tests. Tested in isolation in ranking.test.ts.
jest.mock('../src/services/ranking', () => ({
  updateClusterPriorityScore: jest.fn().mockReturnValue(Promise.resolve(0)),
}));

describe('CivicMind AI E2E Vector Clustering & Severity Tests', () => {
  const mockPool = pool as unknown as { query: jest.Mock };
  const mockCheckDbConnection = checkDbConnection as jest.Mock;
  const mockGetEmbedding = getEmbedding as jest.Mock;
  const mockTriggerRecommendation = triggerRecommendationIfNeeded as jest.Mock;
  const mockUpdatePriorityScore = updateClusterPriorityScore as jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
    // Re-assign mock implementations since resetMocks: true is configured in jest.config.js
    mockGetEmbedding.mockResolvedValue(new Array(1536).fill(0.025));
    // Re-assign recommendations mock to always return a resolved Promise
    // (resetMocks clears implementations, leaving plain jest.fn() that returns undefined)
    mockTriggerRecommendation.mockReturnValue(Promise.resolve());
    // Re-assign ranking mock to always return a resolved Promise
    mockUpdatePriorityScore.mockReturnValue(Promise.resolve(0));
  });

  describe('GET /health', () => {
    it('should return 200 UP when database is connected', async () => {
      mockCheckDbConnection.mockResolvedValue(true);

      const response = await request(app).get('/health');

      expect(response.status).toBe(200);
      expect(response.body.status).toBe('UP');
    });
  });

  describe('Clustering & Severity Core Services', () => {
    describe('recalculateClusterSeverity', () => {
      it('should calculate severity using category weight and baseline resolution delay when historical data is missing', async () => {
        // Mock cluster category query (infrastructure: weight = 1.5)
        mockPool.query.mockResolvedValueOnce({
          rows: [{ category: 'infrastructure', status: 'pending' }],
        });
        // Mock total complaints count in cluster (volume = 5)
        mockPool.query.mockResolvedValueOnce({
          rows: [{ count: '5' }],
        });
        // Mock growth rate count (recent last 7 days = 3)
        mockPool.query.mockResolvedValueOnce({
          rows: [{ count: '3' }],
        });
        // Mock resolution speed query - return null (missing historical data)
        mockPool.query.mockResolvedValueOnce({
          rows: [{ avg_days: null }],
        });
        // Mock cluster table update
        mockPool.query.mockResolvedValueOnce({ rows: [] });

        const score = await recalculateClusterSeverity(201);

        // Verification:
        // Category weight = 1.5
        // volumeScore = (5 / 20) * 100 = 25
        // growthScore = (3 / 5) * 100 = 60
        // populationScore = 5 * 15 = 75
        // resolutionScore = default (3) * 10 = 30
        // BaseScore = (25 * 0.25) + (60 * 0.25) + (75 * 0.25) + (30 * 0.25) = 47.5
        // Final score = 47.5 * 1.5 = 71.25 -> rounded to 71
        expect(score).toBe(71);
        expect(mockPool.query).toHaveBeenCalledWith(
          expect.stringContaining('UPDATE cluster SET severity_score = $1, complaint_count = $2 WHERE id = $3'),
          [71, 5, 201]
        );
      });
    });

    describe('clusterComplaint', () => {
      it('should create a new cluster if similarity is below threshold (below 0.70)', async () => {
        const mockComplaint = {
          text: 'Pothole on 10th block.',
          category: 'infrastructure',
          latitude: 12.9716,
          longitude: 77.5946,
        };

        // 1. Fetch complaint
        mockPool.query.mockResolvedValueOnce({ rows: [mockComplaint] });
        // 2. Save embedding to complaint
        mockPool.query.mockResolvedValueOnce({ rows: [] });
        // 3. Closest cluster query - returns low similarity (e.g. 0.45)
        mockPool.query.mockResolvedValueOnce({
          rows: [{ id: 99, category: 'infrastructure', region: 'Downtown', similarity: '0.45' }],
        });
        // 4. Create new cluster insert
        mockPool.query.mockResolvedValueOnce({ rows: [{ id: 300 }] });
        // 5. Update complaint to link new cluster ID
        mockPool.query.mockResolvedValueOnce({ rows: [] });

        // Mocks for severity recalculation inside clusterComplaint
        mockPool.query.mockResolvedValueOnce({ rows: [{ category: 'infrastructure' }] }); // cluster select
        mockPool.query.mockResolvedValueOnce({ rows: [{ count: '1' }] }); // count complaints
        mockPool.query.mockResolvedValueOnce({ rows: [{ count: '1' }] }); // growth rate
        mockPool.query.mockResolvedValueOnce({ rows: [{ avg_days: null }] }); // historical res speed
        mockPool.query.mockResolvedValueOnce({ rows: [] }); // update cluster severity

        const assignedId = await clusterComplaint(42);

        expect(assignedId).toBe(300);
        // Verify insert statement called
        expect(mockPool.query).toHaveBeenCalledWith(
          expect.stringContaining('INSERT INTO cluster'),
          expect.any(Array)
        );
      });

      it('should attach to existing cluster if similarity is above threshold (above 0.70)', async () => {
        const mockComplaint = {
          text: 'Garbage dump near central gate.',
          category: 'sanitation',
          latitude: 12.9838,
          longitude: 77.5885,
        };

        // 1. Fetch complaint
        mockPool.query.mockResolvedValueOnce({ rows: [mockComplaint] });
        // 2. Save embedding
        mockPool.query.mockResolvedValueOnce({ rows: [] });
        // 3. Match cluster (similarity = 0.88, high similarity)
        mockPool.query.mockResolvedValueOnce({
          rows: [{ id: 202, category: 'sanitation', region: 'North', similarity: '0.88' }],
        });
        // 4. Link complaint
        mockPool.query.mockResolvedValueOnce({ rows: [] });
        // 5. Query all linked embeddings for centroid recalculation
        mockPool.query.mockResolvedValueOnce({
          rows: [
            { embedding: '[0.025,0.025]' },
            { embedding: '[0.025,0.025]' },
          ],
        });
        // 6. Update centroid vector in cluster
        mockPool.query.mockResolvedValueOnce({ rows: [] });

        // Mocks for severity calculation inside clusterComplaint
        mockPool.query.mockResolvedValueOnce({ rows: [{ category: 'sanitation' }] }); // cluster select
        mockPool.query.mockResolvedValueOnce({ rows: [{ count: '2' }] }); // count
        mockPool.query.mockResolvedValueOnce({ rows: [{ count: '2' }] }); // growth
        mockPool.query.mockResolvedValueOnce({ rows: [{ avg_days: '2.0' }] }); // res speed days
        mockPool.query.mockResolvedValueOnce({ rows: [] }); // update

        const assignedId = await clusterComplaint(43);

        expect(assignedId).toBe(202);
        // Ensure no INSERT INTO cluster was executed
        const calls = mockPool.query.mock.calls.map(c => c[0]);
        const insertCalled = calls.some(c => typeof c === 'string' && c.includes('INSERT INTO cluster'));
        expect(insertCalled).toBe(false);
      });

      it('should log warning for borderline similarity score threshold matches', async () => {
        const consoleSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
        const mockComplaint = {
          text: 'Flickering street light on 4th cross.',
          category: 'utility',
          latitude: 12.9691,
          longitude: 77.6083,
        };

        // Threshold = 0.70. Borderline is within 0.05 margin (0.65 to 0.75)
        // 1. Fetch complaint
        mockPool.query.mockResolvedValueOnce({ rows: [mockComplaint] });
        // 2. Save embedding
        mockPool.query.mockResolvedValueOnce({ rows: [] });
        // 3. Match cluster - similarity 0.72 (borderline above threshold)
        mockPool.query.mockResolvedValueOnce({
          rows: [{ id: 203, category: 'utility', region: 'East', similarity: '0.72' }],
        });
        // 4. Link complaint
        mockPool.query.mockResolvedValueOnce({ rows: [] });
        // 5. Query embeddings
        mockPool.query.mockResolvedValueOnce({ rows: [{ embedding: '[0.025]' }] });
        // 6. Update centroid
        mockPool.query.mockResolvedValueOnce({ rows: [] });

        // Severity mock chains
        mockPool.query.mockResolvedValueOnce({ rows: [{ category: 'utility' }] });
        mockPool.query.mockResolvedValueOnce({ rows: [{ count: '1' }] });
        mockPool.query.mockResolvedValueOnce({ rows: [{ count: '1' }] });
        mockPool.query.mockResolvedValueOnce({ rows: [{ avg_days: null }] });
        mockPool.query.mockResolvedValueOnce({ rows: [] });

        await clusterComplaint(44);

        // Verify borderline warning console logged
        expect(consoleSpy).toHaveBeenCalledWith(
          expect.stringContaining('[CLUSTERING] Borderline similarity score detected')
        );
        consoleSpy.mockRestore();
      });
    });
  });

  describe('HTTP REST Routes Ingestion Integration', () => {
    const payload = {
      text: 'Water pipeline leakage.',
      category: 'utility',
      latitude: 12.9716,
      longitude: 77.5946,
      idempotencyKey: 'a8b75f80-7212-4217-a068-0e31e5f8f8ab',
    };

    it('POST /api/complaints should submit, cluster, and return fully structured updated complaint details', async () => {
      // 1. Idempotency check: not found
      mockPool.query.mockResolvedValueOnce({ rows: [] });
      // 2. Duplicate spam check: not found
      mockPool.query.mockResolvedValueOnce({ rows: [] });
      // 3. Source check: return portal ID
      mockPool.query.mockResolvedValueOnce({ rows: [{ id: 1 }] });
      // 4. Ingest insert
      mockPool.query.mockResolvedValueOnce({ rows: [{ id: 50 }] });

      // -- Mocks trigger inside clusterComplaint call --
      // 5. Select complaint details
      mockPool.query.mockResolvedValueOnce({
        rows: [{ text: 'Water pipeline leakage.', category: 'utility', latitude: 12.9716, longitude: 77.5946 }],
      });
      // 6. Update embedding
      mockPool.query.mockResolvedValueOnce({ rows: [] });
      // 7. Closest cluster match (creates new cluster index 301)
      mockPool.query.mockResolvedValueOnce({ rows: [] });
      mockPool.query.mockResolvedValueOnce({ rows: [{ id: 301 }] }); // insert cluster
      mockPool.query.mockResolvedValueOnce({ rows: [] }); // link complaint

      // Severity calculations inside clusterComplaint
      mockPool.query.mockResolvedValueOnce({ rows: [{ category: 'utility' }] }); // select
      mockPool.query.mockResolvedValueOnce({ rows: [{ count: '1' }] }); // count
      mockPool.query.mockResolvedValueOnce({ rows: [{ count: '1' }] }); // growth
      mockPool.query.mockResolvedValueOnce({ rows: [{ avg_days: null }] }); // speed
      mockPool.query.mockResolvedValueOnce({ rows: [] }); // update cluster

      // -- Post-Clustering return query --
      mockPool.query.mockResolvedValueOnce({
        rows: [
          {
            id: 50,
            category: 'utility',
            text: 'Water pipeline leakage.',
            latitude: 12.9716,
            longitude: 77.5946,
            status: 'pending',
            created_at: '2026-07-18T18:00:00Z',
            cluster_id: 301,
          },
        ],
      });

      const response = await request(app).post('/api/complaints').send(payload);

      expect(response.status).toBe(201);
      expect(response.body.message).toContain('clustered successfully');
      expect(response.body.data.id).toBe(50);
      expect(response.body.data.cluster_id).toBe(301);
    });

    it('GET /api/clusters should query database clusters and return aggregated JSON arrays', async () => {
      const mockClusterRecord = {
        id: 201,
        title: 'Road Damage Downtown',
        category: 'infrastructure',
        region: 'Downtown',
        severity: 78,
        complaintCount: 1,
        status: 'pending',
        recommendedAction: 'Asphalt patching.',
        latitude: '12.9716',
        longitude: '77.5946',
        lastUpdated: '2026-07-18T18:00:00Z',
        complaints: [
          { id: 'CM-1', text: 'Pothole A', status: 'pending', created_at: '2026-07-18T18:00:00Z' },
        ],
        latestActionText: null,
        latestActionGeneratedBy: null,
        latestActionStatus: null,
        latestActionGeneratedAt: null,
      };

      mockPool.query.mockResolvedValueOnce({
        rows: [mockClusterRecord],
      });

      const response = await request(app).get('/api/clusters');

      expect(response.status).toBe(200);
      expect(response.body.data.length).toBe(1);
      expect(response.body.data[0].id).toBe('CL-201');
      expect(response.body.data[0].complaints[0].id).toBe('CM-1');
      expect(response.body.data[0].latestAction).toBeNull();
    });
  });

  // ---------------------------------------------------------------------------
  // PART 1 NEW TESTS
  // ---------------------------------------------------------------------------

  describe('GET /api/complaints/:id', () => {
    it('should return 200 with complaint data when found', async () => {
      mockPool.query.mockResolvedValueOnce({
        rows: [{
          id: 10,
          text: 'Broken street light.',
          category: 'utility',
          latitude: '12.9716',
          longitude: '77.5946',
          status: 'pending',
          created_at: '2026-07-18T18:00:00Z',
          cluster_id: 5,
          source_name: 'citizen_portal',
        }],
      });

      const response = await request(app).get('/api/complaints/10');

      expect(response.status).toBe(200);
      expect(response.body.data.id).toBe(10);
      expect(response.body.data.clusterId).toBe('CL-5');
      expect(response.body.data.latitude).toBe(12.9716);
    });

    it('should return 200 when ID is prefixed with CM-', async () => {
      mockPool.query.mockResolvedValueOnce({
        rows: [{
          id: 42,
          text: 'Garbage overflow near park.',
          category: 'sanitation',
          latitude: '12.9800',
          longitude: '77.5900',
          status: 'pending',
          created_at: '2026-07-18T18:00:00Z',
          cluster_id: null,
          source_name: 'citizen_portal',
        }],
      });

      const response = await request(app).get('/api/complaints/CM-42');

      expect(response.status).toBe(200);
      expect(response.body.data.id).toBe(42);
      expect(response.body.data.clusterId).toBeNull();
    });

    it('should return 404 when complaint is not found', async () => {
      mockPool.query.mockResolvedValueOnce({ rows: [] });

      const response = await request(app).get('/api/complaints/9999');

      expect(response.status).toBe(404);
      expect(response.body.error).toContain('not found');
    });

    it('should return 400 for a malformed non-numeric ID', async () => {
      const response = await request(app).get('/api/complaints/abc-xyz');

      expect(response.status).toBe(400);
      expect(response.body.error).toContain('Invalid complaint ID format');
    });

    it('should return 400 for a completely non-numeric ID string', async () => {
      const response = await request(app).get('/api/complaints/not-a-number');

      expect(response.status).toBe(400);
      expect(response.body.error).toContain('Invalid complaint ID format');
    });
  });

  describe('POST /api/clusters/:id/status', () => {
    it('should return 200 on a valid status transition (pending → in_progress)', async () => {
      // BEGIN
      mockPool.query.mockResolvedValueOnce({ rows: [] });
      // UPDATE cluster RETURNING id
      mockPool.query.mockResolvedValueOnce({ rows: [{ id: 201 }] });
      // UPDATE complaint
      mockPool.query.mockResolvedValueOnce({ rows: [] });
      // COMMIT
      mockPool.query.mockResolvedValueOnce({ rows: [] });

      const response = await request(app)
        .post('/api/clusters/CL-201/status')
        .set('Authorization', `Bearer ${govtToken}`)
        .send({ status: 'in_progress' });

      expect(response.status).toBe(200);
      expect(response.body.message).toContain('in_progress');
      expect(response.body.clusterId).toBe('CL-201');
    });

    it('should return 200 on valid resolved transition', async () => {
      mockPool.query.mockResolvedValueOnce({ rows: [] }); // BEGIN
      mockPool.query.mockResolvedValueOnce({ rows: [{ id: 201 }] }); // UPDATE cluster
      mockPool.query.mockResolvedValueOnce({ rows: [] }); // UPDATE complaint
      mockPool.query.mockResolvedValueOnce({ rows: [] }); // COMMIT

      const response = await request(app)
        .post('/api/clusters/201/status')
        .set('Authorization', `Bearer ${govtToken}`)
        .send({ status: 'resolved' });

      expect(response.status).toBe(200);
      expect(response.body.message).toContain('resolved');
    });

    it('should return 400 for an invalid status value', async () => {
      const response = await request(app)
        .post('/api/clusters/CL-201/status')
        .set('Authorization', `Bearer ${govtToken}`)
        .send({ status: 'cancelled' });

      expect(response.status).toBe(400);
      expect(response.body.error).toContain('Invalid status value');
    });

    it('should return 400 for a malformed cluster ID', async () => {
      const response = await request(app)
        .post('/api/clusters/CL-abc/status')
        .set('Authorization', `Bearer ${govtToken}`)
        .send({ status: 'resolved' });

      expect(response.status).toBe(400);
      expect(response.body.error).toContain('Invalid cluster ID format');
    });

    it('should return 404 when cluster does not exist', async () => {
      mockPool.query.mockResolvedValueOnce({ rows: [] }); // BEGIN
      mockPool.query.mockResolvedValueOnce({ rows: [] }); // UPDATE cluster returns empty
      mockPool.query.mockResolvedValueOnce({ rows: [] }); // ROLLBACK

      const response = await request(app)
        .post('/api/clusters/CL-9999/status')
        .set('Authorization', `Bearer ${govtToken}`)
        .send({ status: 'resolved' });

      expect(response.status).toBe(404);
      expect(response.body.error).toContain('not found');
    });
  });

  describe('Rate limiting on POST /api/complaints', () => {
    it('should return 429 after exceeding RATE_LIMIT_MAX requests from the same IP', async () => {
      // RATE_LIMIT_MAX is set to 2 in jest.setup.ts environment.
      // We must set it before the app is loaded. Since the limiter is created at module load time,
      // we use the env var approach: set RATE_LIMIT_MAX=2 in the test environment via process.env
      // and rely on the jest --resetModules flag per suite. Instead here we directly verify
      // that when the limiter blocks, the response body matches our error message format.

      // The default max is 100 in production; we can't exhaust 100 calls in unit tests easily.
      // This test uses a lower env override. Since env is loaded at module init time, we test
      // the error payload format by manually triggering the rate limit via a large burst.
      // In CI, set RATE_LIMIT_MAX=2 before running this suite.

      // Approach: send RATE_LIMIT_MAX+1 identical calls and assert the last one is 429.
      // We use a freshly required app instance for isolation using jest.isolateModules.
      let limitedApp: any;
      jest.isolateModules(() => {
        // Override env so the new app module picks up max=2
        process.env.RATE_LIMIT_MAX = '2';
        limitedApp = require('../src/index').default;
      });

      const payload = {
        text: 'Rate limit test complaint.',
        category: 'noise',
        latitude: 12.9716,
        longitude: 77.5946,
        idempotencyKey: '11111111-2222-3333-4444-555555555555',
      };

      // First two calls: mock DB queries so they succeed (or at least not hit the limiter)
      // Idempotency check, duplicate check, source lookup, insert, clusterComplaint chain, return
      const setupMockForOneSubmission = () => {
        mockPool.query
          .mockResolvedValueOnce({ rows: [] }) // idempotency
          .mockResolvedValueOnce({ rows: [] }) // duplicate
          .mockResolvedValueOnce({ rows: [{ id: 1 }] }) // source
          .mockResolvedValueOnce({ rows: [{ id: 50 }] }) // insert
          // clusterComplaint internals
          .mockResolvedValueOnce({ rows: [{ text: 'Rate limit test complaint.', category: 'noise', latitude: 12.9716, longitude: 77.5946 }] })
          .mockResolvedValueOnce({ rows: [] }) // embedding update
          .mockResolvedValueOnce({ rows: [] }) // closest cluster (none)
          .mockResolvedValueOnce({ rows: [{ id: 400 }] }) // new cluster
          .mockResolvedValueOnce({ rows: [] }) // link complaint
          // severity
          .mockResolvedValueOnce({ rows: [{ category: 'noise' }] })
          .mockResolvedValueOnce({ rows: [{ count: '1' }] })
          .mockResolvedValueOnce({ rows: [{ count: '1' }] })
          .mockResolvedValueOnce({ rows: [{ avg_days: null }] })
          .mockResolvedValueOnce({ rows: [] })
          // return query
          .mockResolvedValueOnce({ rows: [{ id: 50, category: 'noise', text: 'Rate limit test complaint.', latitude: 12.9716, longitude: 77.5946, status: 'pending', created_at: '2026-07-18T18:00:00Z', cluster_id: 400 }] });
      };

      setupMockForOneSubmission();
      const r1 = await request(limitedApp).post('/api/complaints').send(payload);
      // r1 can be 201 or 200 (idempotency)

      // Second request — different idempotency key
      setupMockForOneSubmission();
      const r2 = await request(limitedApp)
        .post('/api/complaints')
        .send({ ...payload, idempotencyKey: '22222222-2222-3333-4444-555555555555' });

      // Third request should hit the rate limiter
      const r3 = await request(limitedApp)
        .post('/api/complaints')
        .send({ ...payload, idempotencyKey: '33333333-2222-3333-4444-555555555555' });

      expect(r3.status).toBe(429);
      expect(r3.body.error).toContain('Too many complaint submissions');

      // Restore
      delete process.env.RATE_LIMIT_MAX;
    });
  });

  describe('Idempotency key replay', () => {
    it('should return the original complaint (200) on duplicate key, not create a new record', async () => {
      const existingRow = {
        id: 77,
        category: 'noise',
        text: 'Loud music from party.',
        latitude: '12.9800',
        longitude: '77.5900',
        status: 'pending',
        created_at: '2026-07-18T18:00:00Z',
        cluster_id: 9,
      };

      // Idempotency check returns existing row
      mockPool.query.mockResolvedValueOnce({ rows: [existingRow] });

      const response = await request(app).post('/api/complaints').send({
        text: 'Loud music from party.',
        category: 'noise',
        latitude: 12.98,
        longitude: 77.59,
        idempotencyKey: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      });

      expect(response.status).toBe(200);
      expect(response.body.message).toContain('idempotency key matched');
      expect(response.body.data.id).toBe(77);

      // Only ONE query should have been called (the idempotency check)
      // No INSERT should have occurred
      const allCalls = mockPool.query.mock.calls.map((c) => c[0] as string);
      const insertCalled = allCalls.some((q) => typeof q === 'string' && q.includes('INSERT INTO complaint'));
      expect(insertCalled).toBe(false);
    });
  });

  describe('Validation errors on POST /api/complaints', () => {
    const basePayload = {
      text: 'Valid complaint text.',
      category: 'safety',
      latitude: 12.9716,
      longitude: 77.5946,
      idempotencyKey: 'ffffffff-aaaa-bbbb-cccc-dddddddddddd',
    };

    it('should return 400 with details when text field is missing', async () => {
      const { text: _t, ...withoutText } = basePayload;
      const response = await request(app).post('/api/complaints').send(withoutText);

      expect(response.status).toBe(400);
      expect(response.body.error).toBe('Validation failed');
      expect(Array.isArray(response.body.details)).toBe(true);
      const paths = response.body.details.map((d: any) => d.path);
      expect(paths).toContain('text');
    });

    it('should return 400 with details when category field is missing', async () => {
      const { category: _c, ...withoutCategory } = basePayload;
      const response = await request(app).post('/api/complaints').send(withoutCategory);

      expect(response.status).toBe(400);
      expect(response.body.error).toBe('Validation failed');
      const paths = response.body.details.map((d: any) => d.path);
      expect(paths).toContain('category');
    });

    it('should return 400 with details when idempotencyKey is missing', async () => {
      const { idempotencyKey: _k, ...withoutKey } = basePayload;
      const response = await request(app).post('/api/complaints').send(withoutKey);

      expect(response.status).toBe(400);
      expect(response.body.error).toBe('Validation failed');
      const paths = response.body.details.map((d: any) => d.path);
      expect(paths).toContain('idempotencyKey');
    });

    it('should return 400 when text exceeds 5000 characters', async () => {
      const response = await request(app).post('/api/complaints').send({
        ...basePayload,
        text: 'A'.repeat(5001),
        idempotencyKey: 'ffffffff-aaaa-bbbb-cccc-ddddddddddde',
      });

      expect(response.status).toBe(400);
      expect(response.body.error).toBe('Validation failed');
      const messages = response.body.details.map((d: any) => d.message);
      expect(messages.some((m: string) => m.includes('5000'))).toBe(true);
    });

    it('should return 400 when category is not a valid enum value', async () => {
      const response = await request(app).post('/api/complaints').send({
        ...basePayload,
        category: 'politics',
        idempotencyKey: 'ffffffff-aaaa-bbbb-cccc-dddddddddddf',
      });

      expect(response.status).toBe(400);
      expect(response.body.error).toBe('Validation failed');
      const paths = response.body.details.map((d: any) => d.path);
      expect(paths).toContain('category');
    });

    it('should return 400 with details array (not empty) on multiple missing fields', async () => {
      const response = await request(app).post('/api/complaints').send({});

      expect(response.status).toBe(400);
      expect(response.body.error).toBe('Validation failed');
      expect(response.body.details.length).toBeGreaterThan(0);
    });
  });

  describe('Error handling paths', () => {
    const validPayload = {
      text: 'Pothole outside the market.',
      category: 'infrastructure',
      latitude: 12.9716,
      longitude: 77.5946,
      idempotencyKey: 'cccccccc-1111-2222-3333-444444444444',
    };

    it('should return 500 gracefully (not crash) when DB query throws on POST /api/complaints', async () => {
      // Idempotency check throws a DB error
      mockPool.query.mockRejectedValueOnce(new Error('Connection refused'));

      const response = await request(app).post('/api/complaints').send(validPayload);

      expect(response.status).toBe(500);
      expect(response.body.error).toBeTruthy();
      // Must be a structured JSON response, not an unhandled crash
      expect(typeof response.body).toBe('object');
    });

    it('should return 500 gracefully when embeddings service throws during clusterComplaint', async () => {
      // Idempotency check: not found
      mockPool.query.mockResolvedValueOnce({ rows: [] });
      // Duplicate check: not found
      mockPool.query.mockResolvedValueOnce({ rows: [] });
      // Source lookup
      mockPool.query.mockResolvedValueOnce({ rows: [{ id: 1 }] });
      // Insert
      mockPool.query.mockResolvedValueOnce({ rows: [{ id: 55 }] });
      // clusterComplaint: fetch complaint text
      mockPool.query.mockResolvedValueOnce({ rows: [{ text: 'Pothole outside the market.', category: 'infrastructure', latitude: 12.9716, longitude: 77.5946 }] });

      // getEmbedding throws
      mockGetEmbedding.mockRejectedValueOnce(new Error('Embedding service unavailable'));

      const response = await request(app).post('/api/complaints').send(validPayload);

      // The error propagates up to the route's catch block → 500
      expect(response.status).toBe(500);
      expect(response.body.error).toBeTruthy();
      expect(typeof response.body).toBe('object');
    });

    it('should return 500 gracefully when DB throws on GET /api/complaints/:id', async () => {
      mockPool.query.mockRejectedValueOnce(new Error('Connection refused'));

      const response = await request(app).get('/api/complaints/1');

      expect(response.status).toBe(500);
      expect(response.body.error).toBeTruthy();
      expect(typeof response.body).toBe('object');
    });

    it('should return 500 gracefully when DB throws on GET /api/clusters', async () => {
      mockPool.query.mockRejectedValueOnce(new Error('Deadlock detected'));

      const response = await request(app).get('/api/clusters');

      expect(response.status).toBe(500);
      expect(response.body.error).toBeTruthy();
    });

    it('should return 500 gracefully when DB throws inside POST /api/clusters/:id/status', async () => {
      // BEGIN succeeds
      mockPool.query.mockResolvedValueOnce({ rows: [] });
      // UPDATE cluster throws
      mockPool.query.mockRejectedValueOnce(new Error('Transaction error'));
      // ROLLBACK
      mockPool.query.mockResolvedValueOnce({ rows: [] });

      const response = await request(app)
        .post('/api/clusters/CL-201/status')
        .set('Authorization', `Bearer ${govtToken}`)
        .send({ status: 'resolved' });

      expect(response.status).toBe(500);
      expect(response.body.error).toBeTruthy();
    });
  });
});

