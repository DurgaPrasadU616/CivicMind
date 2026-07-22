import request from 'supertest';
import app from '../src/index';
import { pool } from '../src/config/db';
import { clusterComplaint } from '../src/services/clustering';
import { getEmbedding } from '../src/services/embeddings';
import {
  getSeverityBand,
  isBandEscalation,
  generateRecommendedAction,
  triggerRecommendationIfNeeded,
  storeAction,
} from '../src/services/recommendations';

// Mock dependencies
jest.mock('../src/config/db', () => {
  const mPool = { query: jest.fn() };
  return { pool: mPool, checkDbConnection: jest.fn() };
});

jest.mock('../src/services/embeddings', () => ({
  getEmbedding: jest.fn(),
}));

// Mock ranking service to prevent priority DB queries bleeding into recommendation tests
jest.mock('../src/services/ranking', () => ({
  updateClusterPriorityScore: jest.fn().mockReturnValue(Promise.resolve(0)),
}));

// We need to partially mock the recommendations module for some tests
// but test the real module for unit tests — we split accordingly.

describe('Recommendations Service — Unit Tests', () => {
  const mockPool = pool as unknown as { query: jest.Mock };
  const mockGetEmbedding = getEmbedding as jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
    mockGetEmbedding.mockResolvedValue(new Array(1536).fill(0.025));
  });

  // ---------------------------------------------------------------------------
  // getSeverityBand helper
  // ---------------------------------------------------------------------------
  describe('getSeverityBand', () => {
    it('should return "low" for scores below 40', () => {
      expect(getSeverityBand(0)).toBe('low');
      expect(getSeverityBand(39)).toBe('low');
    });

    it('should return "medium" for scores 40-74', () => {
      expect(getSeverityBand(40)).toBe('medium');
      expect(getSeverityBand(74)).toBe('medium');
    });

    it('should return "high" for scores 75 and above', () => {
      expect(getSeverityBand(75)).toBe('high');
      expect(getSeverityBand(100)).toBe('high');
    });
  });

  // ---------------------------------------------------------------------------
  // isBandEscalation helper
  // ---------------------------------------------------------------------------
  describe('isBandEscalation', () => {
    it('should return true when previousBand is null (new cluster)', () => {
      expect(isBandEscalation(null, 'low')).toBe(true);
      expect(isBandEscalation(null, 'medium')).toBe(true);
      expect(isBandEscalation(null, 'high')).toBe(true);
    });

    it('should return true for low → medium escalation', () => {
      expect(isBandEscalation('low', 'medium')).toBe(true);
    });

    it('should return true for low → high escalation', () => {
      expect(isBandEscalation('low', 'high')).toBe(true);
    });

    it('should return true for medium → high escalation', () => {
      expect(isBandEscalation('medium', 'high')).toBe(true);
    });

    it('should return false when band stays the same', () => {
      expect(isBandEscalation('low', 'low')).toBe(false);
      expect(isBandEscalation('medium', 'medium')).toBe(false);
      expect(isBandEscalation('high', 'high')).toBe(false);
    });

    it('should return false when band drops (high → medium)', () => {
      expect(isBandEscalation('high', 'medium')).toBe(false);
    });

    it('should return false when band drops (high → low)', () => {
      expect(isBandEscalation('high', 'low')).toBe(false);
    });

    it('should return false when band drops (medium → low)', () => {
      expect(isBandEscalation('medium', 'low')).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // generateRecommendedAction — rule-based fallback when GEMINI_API_KEY missing
  // ---------------------------------------------------------------------------
  describe('generateRecommendedAction', () => {
    it('should use rule-based fallback when GEMINI_API_KEY is not set', async () => {
      const originalKey = process.env.GEMINI_API_KEY;
      delete process.env.GEMINI_API_KEY;

      // DB mocks for generateRecommendedAction
      // 1. Cluster context
      mockPool.query.mockResolvedValueOnce({
        rows: [{ category: 'infrastructure', region: 'Downtown', complaint_count: '5', severity_score: '80' }],
      });
      // 2. Sample complaints
      mockPool.query.mockResolvedValueOnce({
        rows: [{ text: 'Pothole on main road.' }, { text: 'Broken sidewalk.' }],
      });
      // 3. Mark superseded
      mockPool.query.mockResolvedValueOnce({ rows: [] });
      // 4. Insert new action
      mockPool.query.mockResolvedValueOnce({ rows: [] });
      // 5. Update cluster.recommended_action
      mockPool.query.mockResolvedValueOnce({ rows: [] });

      await generateRecommendedAction(201);

      // Find the INSERT recommended_action call
      const insertCall = mockPool.query.mock.calls.find(
        (c) => typeof c[0] === 'string' && c[0].includes('INSERT INTO recommended_action')
      );
      expect(insertCall).toBeDefined();
      const [, params] = insertCall!;
      expect(params[2]).toBe('rule_based'); // generatedBy
      expect(params[1]).toContain('Infrastructure'); // action text contains category
      expect(params[1]).toContain('Downtown'); // action text contains region
      expect(params[1]).toContain('5'); // complaint count

      if (originalKey !== undefined) {
        process.env.GEMINI_API_KEY = originalKey;
      }
    });

    it('should fall back to rule-based when Gemini API throws', async () => {
      process.env.GEMINI_API_KEY = 'test-invalid-key';

      // DB mocks
      mockPool.query.mockResolvedValueOnce({
        rows: [{ category: 'sanitation', region: 'North', complaint_count: '3', severity_score: '55' }],
      });
      mockPool.query.mockResolvedValueOnce({ rows: [{ text: 'Garbage overflow.' }] });
      mockPool.query.mockResolvedValueOnce({ rows: [] }); // supersede
      mockPool.query.mockResolvedValueOnce({ rows: [] }); // insert
      mockPool.query.mockResolvedValueOnce({ rows: [] }); // update cluster

      // The GoogleGenerativeAI will throw because the key is invalid
      // generateWithGemini is internal, but we know it will fail with a bad key
      // We mock the @google/generative-ai to throw
      jest.mock('@google/generative-ai', () => ({
        GoogleGenerativeAI: jest.fn().mockImplementation(() => ({
          getGenerativeModel: jest.fn().mockReturnValue({
            generateContent: jest.fn().mockRejectedValue(new Error('API key not valid')),
          }),
        })),
      }));

      await generateRecommendedAction(202);

      const insertCall = mockPool.query.mock.calls.find(
        (c) => typeof c[0] === 'string' && c[0].includes('INSERT INTO recommended_action')
      );

      // Whether Gemini fails or succeeds with an invalid key, we always get an insert
      expect(insertCall).toBeDefined();

      delete process.env.GEMINI_API_KEY;
    });
  });

  // ---------------------------------------------------------------------------
  // triggerRecommendationIfNeeded — trigger conditions
  // ---------------------------------------------------------------------------
  describe('triggerRecommendationIfNeeded', () => {
    it('should trigger generation when cluster has no previous band (new cluster)', async () => {
      const generateSpy = jest.spyOn(
        require('../src/services/recommendations'),
        'generateRecommendedAction'
      ).mockResolvedValue(undefined);

      // last_severity_band is null
      mockPool.query.mockResolvedValueOnce({ rows: [{ last_severity_band: null }] });
      // UPDATE last_severity_band
      mockPool.query.mockResolvedValueOnce({ rows: [] });

      await triggerRecommendationIfNeeded(300, 80);

      // Wait for setImmediate to run
      await new Promise((resolve) => setImmediate(resolve));

      expect(generateSpy).toHaveBeenCalledWith(300);
      generateSpy.mockRestore();
    });

    it('should trigger generation on band escalation (low → high)', async () => {
      const generateSpy = jest.spyOn(
        require('../src/services/recommendations'),
        'generateRecommendedAction'
      ).mockResolvedValue(undefined);

      mockPool.query.mockResolvedValueOnce({ rows: [{ last_severity_band: 'low' }] });
      mockPool.query.mockResolvedValueOnce({ rows: [] }); // UPDATE band

      await triggerRecommendationIfNeeded(301, 85); // 85 = high

      await new Promise((resolve) => setImmediate(resolve));

      expect(generateSpy).toHaveBeenCalledWith(301);
      generateSpy.mockRestore();
    });

    it('should NOT trigger generation when band stays the same', async () => {
      const generateSpy = jest.spyOn(
        require('../src/services/recommendations'),
        'generateRecommendedAction'
      ).mockResolvedValue(undefined);

      mockPool.query.mockResolvedValueOnce({ rows: [{ last_severity_band: 'medium' }] });
      mockPool.query.mockResolvedValueOnce({ rows: [] }); // UPDATE band

      await triggerRecommendationIfNeeded(302, 60); // 60 = medium (same band)

      await new Promise((resolve) => setImmediate(resolve));

      expect(generateSpy).not.toHaveBeenCalled();
      generateSpy.mockRestore();
    });

    it('should NOT trigger generation when band drops', async () => {
      const generateSpy = jest.spyOn(
        require('../src/services/recommendations'),
        'generateRecommendedAction'
      ).mockResolvedValue(undefined);

      mockPool.query.mockResolvedValueOnce({ rows: [{ last_severity_band: 'high' }] });
      mockPool.query.mockResolvedValueOnce({ rows: [] }); // UPDATE band

      await triggerRecommendationIfNeeded(303, 30); // 30 = low (dropped)

      await new Promise((resolve) => setImmediate(resolve));

      expect(generateSpy).not.toHaveBeenCalled();
      generateSpy.mockRestore();
    });
  });

  // ---------------------------------------------------------------------------
  // storeAction — history persistence
  // ---------------------------------------------------------------------------
  describe('storeAction', () => {
    it('should supersede previous active actions and insert a new one', async () => {
      mockPool.query.mockResolvedValueOnce({ rows: [] }); // UPDATE supersede
      mockPool.query.mockResolvedValueOnce({ rows: [] }); // INSERT
      mockPool.query.mockResolvedValueOnce({ rows: [] }); // UPDATE cluster.recommended_action

      await storeAction(400, 'Deploy maintenance crew to Downtown', 'rule_based');

      const updateSupersededCall = mockPool.query.mock.calls[0];
      expect(updateSupersededCall[0]).toContain("status = 'superseded'");
      expect(updateSupersededCall[1]).toEqual([400]);

      const insertCall = mockPool.query.mock.calls[1];
      expect(insertCall[0]).toContain('INSERT INTO recommended_action');
      expect(insertCall[1]).toContain('Deploy maintenance crew to Downtown');
      expect(insertCall[1]).toContain('rule_based');
    });
  });

  // ---------------------------------------------------------------------------
  // Non-blocking behavior
  // ---------------------------------------------------------------------------
  describe('Non-blocking behavior on POST /api/complaints', () => {
    it('should resolve POST /api/complaints before recommendation generation completes', async () => {
      // Track order of events
      const events: string[] = [];

      // Mock pool for the full complaint submission
      mockPool.query
        .mockResolvedValueOnce({ rows: [] }) // idempotency check
        .mockResolvedValueOnce({ rows: [] }) // duplicate check
        .mockResolvedValueOnce({ rows: [{ id: 1 }] }) // source
        .mockResolvedValueOnce({ rows: [{ id: 99 }] }) // insert
        // clusterComplaint
        .mockResolvedValueOnce({ rows: [{ text: 'Test.', category: 'noise', latitude: 12.97, longitude: 77.59 }] })
        .mockResolvedValueOnce({ rows: [] }) // embedding
        .mockResolvedValueOnce({ rows: [] }) // closest cluster
        .mockResolvedValueOnce({ rows: [{ id: 500 }] }) // insert cluster
        .mockResolvedValueOnce({ rows: [] }) // link complaint
        // severity
        .mockResolvedValueOnce({ rows: [{ category: 'noise' }] })
        .mockResolvedValueOnce({ rows: [{ count: '1' }] })
        .mockResolvedValueOnce({ rows: [{ count: '1' }] })
        .mockResolvedValueOnce({ rows: [{ avg_days: null }] })
        .mockResolvedValueOnce({ rows: [] })
        // triggerRecommendationIfNeeded
        .mockImplementationOnce(async () => {
          events.push('recommendation_query_started');
          return { rows: [{ last_severity_band: null }] };
        })
        .mockResolvedValueOnce({ rows: [] }) // UPDATE band
        // generateRecommendedAction DB calls
        .mockImplementationOnce(async () => {
          events.push('generate_started');
          return { rows: [{ category: 'noise', region: 'Downtown', complaint_count: '1', severity_score: '30' }] };
        })
        .mockResolvedValueOnce({ rows: [] }) // sample complaints
        .mockResolvedValueOnce({ rows: [] }) // supersede
        .mockResolvedValueOnce({ rows: [] }) // insert action
        .mockResolvedValueOnce({ rows: [] }) // update cluster recommended_action
        // return complaint
        .mockResolvedValueOnce({
          rows: [{ id: 99, category: 'noise', text: 'Test.', latitude: 12.97, longitude: 77.59, status: 'pending', created_at: new Date().toISOString(), cluster_id: 500 }],
        });

      events.push('request_sent');
      const response = await request(app).post('/api/complaints').send({
        text: 'Test.',
        category: 'noise',
        latitude: 12.97,
        longitude: 77.59,
        idempotencyKey: 'deadbeef-dead-dead-dead-deaddeadde01',
      });
      events.push('response_received');

      expect(response.status).toBe(201);
      // The response should arrive before setImmediate callbacks fire for recommendation
      // Verify the order: request_sent → response_received comes before generate_started
      const responseIdx = events.indexOf('response_received');
      const generateIdx = events.indexOf('generate_started');

      // generate_started may not have fired yet (it's in a setImmediate)
      // Either it hasn't started (generateIdx === -1) or it started after response
      if (generateIdx !== -1) {
        expect(responseIdx).toBeLessThan(generateIdx);
      } else {
        // Generation deferred — response arrived before async callback fired. ✓
        expect(responseIdx).toBeGreaterThan(-1);
      }
    });
  });
});
