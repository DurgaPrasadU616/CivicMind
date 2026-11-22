// backend/tests/hybridClustering.test.ts
//
// Comprehensive Unit & Integration Tests for Phase 2: Hybrid Intelligent Clustering.
//
// Covers:
//   1. Identical complaint meanings.
//   2. Semantically different complaints in the same location (semantic guardrail).
//   3. Similar complaints in nearby locations.
//   4. Similar complaints in distant locations.
//   5. Recent versus old complaints (temporal relevance decay).
//   6. Missing GPS coordinates (safe neutral fallback).
//   7. Missing timestamps.
//   8. Invalid coordinates (out-of-bounds, NaN).
//   9. Threshold boundary cases (exact match, just below, borderline).
//  10. Geo centroid running average / concurrent updates.
//  11. Configuration loading and weight validation (sum to 1.0).
//  12. clusterComplaint() — new cluster creation.
//  13. clusterComplaint() — existing cluster update with geo centroid.
//  14. clusterComplaint() — agent logging success & failure paths.

import {
  haversineDistanceKm,
  isValidCoordinate,
  calculateGeoProximity,
  calculateTemporalRelevance,
  computeHybridScore,
  evaluateClusterCandidate,
  calculateUpdatedGeoCentroid,
  validateWeights,
  getHybridConfig,
  DEFAULT_HYBRID_CONFIG,
} from '../src/config/hybridClustering';

import { clusterComplaint } from '../src/services/clustering';
import { pool } from '../src/config/db';
import { getEmbedding } from '../src/services/embeddings';
import { triggerRecommendationIfNeeded } from '../src/services/recommendations';
import { updateClusterPriorityScore } from '../src/services/ranking';
import { assignCluster } from '../src/services/assignment';

// ── Mocks ─────────────────────────────────────────────────────────────────────

jest.mock('../src/config/db', () => ({
  pool: { query: jest.fn() },
  checkDbConnection: jest.fn(),
}));

jest.mock('../src/services/embeddings', () => ({
  getEmbedding: jest.fn(),
}));

jest.mock('../src/services/recommendations', () => ({
  triggerRecommendationIfNeeded: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../src/services/ranking', () => ({
  updateClusterPriorityScore: jest.fn().mockResolvedValue(50),
}));

jest.mock('../src/services/assignment', () => ({
  assignCluster: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../src/services/backgroundQueue', () => ({
  backgroundQueue: {
    enqueue: jest.fn((name, fn) => {
      // Don't execute background jobs synchronously in tests
    }),
  },
}));

jest.mock('../src/utils/logger', () => ({
  __esModule: true,
  default: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

const mockPool = pool as unknown as { query: jest.Mock };
const mockGetEmbedding = getEmbedding as jest.Mock;

beforeEach(() => {
  jest.clearAllMocks();
  mockGetEmbedding.mockResolvedValue(new Array(1536).fill(0.025));
});

// =============================================================================
// 1. Haversine Distance & Coordinate Validation
// =============================================================================
describe('Haversine Distance & Coordinate Validation', () => {
  it('validates coordinates correctly', () => {
    expect(isValidCoordinate(12.9716, 77.5946)).toBe(true);
    expect(isValidCoordinate(-90, 180)).toBe(true);
    expect(isValidCoordinate(90, -180)).toBe(true);
    expect(isValidCoordinate('12.9716', '77.5946')).toBe(true);

    // Invalid coordinates
    expect(isValidCoordinate(91, 77)).toBe(false);       // lat > 90
    expect(isValidCoordinate(-91, 77)).toBe(false);      // lat < -90
    expect(isValidCoordinate(12, 181)).toBe(false);       // lng > 180
    expect(isValidCoordinate(12, -181)).toBe(false);      // lng < -180
    expect(isValidCoordinate(null, 77)).toBe(false);
    expect(isValidCoordinate(12, undefined)).toBe(false);
    expect(isValidCoordinate('invalid', 77)).toBe(false);
    expect(isValidCoordinate(NaN, 77)).toBe(false);
  });

  it('returns 0 km distance for identical coordinates', () => {
    const dist = haversineDistanceKm(12.9716, 77.5946, 12.9716, 77.5946);
    expect(dist).toBeCloseTo(0, 4);
  });

  it('calculates accurate distance between known landmarks (Bangalore to Mysore ~130 km)', () => {
    // Bangalore: 12.9716, 77.5946; Mysore: 12.2958, 76.6394
    const dist = haversineDistanceKm(12.9716, 77.5946, 12.2958, 76.6394);
    expect(dist).toBeGreaterThan(125);
    expect(dist).toBeLessThan(145);
  });

  it('returns null if either coordinate pair is missing or invalid', () => {
    expect(haversineDistanceKm(null, 77.5, 12.9, 77.5)).toBeNull();
    expect(haversineDistanceKm(12.9, undefined, 12.9, 77.5)).toBeNull();
    expect(haversineDistanceKm(12.9, 77.5, 999, 77.5)).toBeNull();
  });
});

// =============================================================================
// 2. Geographic Proximity Normalization (0.0 to 1.0)
// =============================================================================
describe('Geographic Proximity Normalization', () => {
  const maxRadiusKm = 5.0;

  it('yields proximity = 1.0 for same location (0 km distance)', () => {
    const { distanceKm, proximity } = calculateGeoProximity(12.9716, 77.5946, 12.9716, 77.5946, maxRadiusKm);
    expect(distanceKm).toBeCloseTo(0, 4);
    expect(proximity).toBe(1.0);
  });

  it('yields proximity = 0.5 for halfway through radius (2.5 km of 5.0 km)', () => {
    // ~2.5 km offset north: 1 deg lat ≈ 111 km, 2.5 km ≈ 0.0225 deg
    const lat1 = 12.9716;
    const lat2 = 12.9716 + 2.5 / 111.0;
    const { distanceKm, proximity } = calculateGeoProximity(lat1, 77.5946, lat2, 77.5946, maxRadiusKm);
    expect(distanceKm).toBeCloseTo(2.5, 1);
    expect(proximity).toBeCloseTo(0.5, 1);
  });

  it('yields proximity = 0.0 for locations beyond max radius (e.g. 10 km away)', () => {
    const { distanceKm, proximity } = calculateGeoProximity(12.9716, 77.5946, 13.15, 77.5946, maxRadiusKm);
    expect(distanceKm).toBeGreaterThan(maxRadiusKm);
    expect(proximity).toBe(0.0);
  });

  it('yields safe neutral proximity (0.5) when GPS coordinates are missing', () => {
    const res1 = calculateGeoProximity(null, null, 12.9716, 77.5946, maxRadiusKm);
    expect(res1.distanceKm).toBeNull();
    expect(res1.proximity).toBe(0.5);

    const res2 = calculateGeoProximity(12.9716, 77.5946, undefined, undefined, maxRadiusKm);
    expect(res2.distanceKm).toBeNull();
    expect(res2.proximity).toBe(0.5);
  });
});

// =============================================================================
// 3. Temporal Relevance Normalization (0.0 to 1.0)
// =============================================================================
describe('Temporal Relevance Normalization', () => {
  const decayDays = 30.0;
  const now = new Date('2026-11-16T12:00:00Z');

  it('yields relevance = 1.0 for same timestamp (0 days difference)', () => {
    const { daysDiff, relevance } = calculateTemporalRelevance(now, now, decayDays);
    expect(daysDiff).toBe(0);
    expect(relevance).toBe(1.0);
  });

  it('decays exponentially over time (relevance ≈ 0.368 at 30 days)', () => {
    const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    const { daysDiff, relevance } = calculateTemporalRelevance(now, thirtyDaysAgo, decayDays);
    expect(daysDiff).toBeCloseTo(30, 1);
    expect(relevance).toBeCloseTo(Math.exp(-1), 2); // ≈ 0.368
  });

  it('decays further for 60-day old clusters (relevance ≈ 0.135)', () => {
    const sixtyDaysAgo = new Date(now.getTime() - 60 * 24 * 60 * 60 * 1000);
    const { daysDiff, relevance } = calculateTemporalRelevance(now, sixtyDaysAgo, decayDays);
    expect(daysDiff).toBeCloseTo(60, 1);
    expect(relevance).toBeCloseTo(Math.exp(-2), 2); // ≈ 0.135
  });

  it('yields safe neutral relevance (1.0) when timestamps are missing or invalid', () => {
    expect(calculateTemporalRelevance(null, now, decayDays).relevance).toBe(1.0);
    expect(calculateTemporalRelevance(now, undefined, decayDays).relevance).toBe(1.0);
    expect(calculateTemporalRelevance('not-a-date', now, decayDays).relevance).toBe(1.0);
  });
});

// =============================================================================
// 4. Weight Validation & Hybrid Score Formula
// =============================================================================
describe('Weight Validation & Hybrid Score Formula', () => {
  it('validates weights summing to 1.0', () => {
    expect(validateWeights(0.60, 0.25, 0.15).valid).toBe(true);
    expect(validateWeights(0.50, 0.30, 0.20).valid).toBe(true);
  });

  it('rejects weights that do not sum to 1.0', () => {
    const res = validateWeights(0.60, 0.20, 0.10); // sums to 0.90
    expect(res.valid).toBe(false);
    expect(res.reason).toContain('must sum to 1.0');
  });

  it('rejects negative weights', () => {
    expect(validateWeights(-0.1, 0.6, 0.5).valid).toBe(false);
  });

  it('computes exact hybrid score: (0.60 * S) + (0.25 * G) + (0.15 * T)', () => {
    // S = 0.80, G = 1.0, T = 1.0
    // score = 0.80*0.60 + 1.0*0.25 + 1.0*0.15 = 0.48 + 0.25 + 0.15 = 0.88
    const score = computeHybridScore(0.80, 1.0, 1.0);
    expect(score).toBeCloseTo(0.88, 4);
  });

  it('clamps output strictly within [0.0, 1.0]', () => {
    expect(computeHybridScore(1.5, 2.0, 1.2)).toBe(1.0);
    expect(computeHybridScore(-0.5, -0.2, 0)).toBe(0); // negative inputs clamp to 0
  });
});

// =============================================================================
// 5. Semantic Guardrail & Core Decision Scenarios
// =============================================================================
describe('Core Decision Scenarios & Semantic Guardrail', () => {
  const config = DEFAULT_HYBRID_CONFIG;

  it('Scenario 1: Identical complaint meanings at same location -> High hybrid score', () => {
    const result = evaluateClusterCandidate(
      0.95, // semantic
      12.9716, 77.5946, new Date(), // complaint coords & time
      12.9716, 77.5946, new Date(), // cluster coords & time
      config
    );
    expect(result.meetsSemanticGuardrail).toBe(true);
    expect(result.hybridScore).toBeGreaterThanOrEqual(config.clusterThreshold);
    expect(result.hybridScore).toBeCloseTo(0.95 * 0.60 + 1.0 * 0.25 + 1.0 * 0.15, 3);
  });

  it('Scenario 2: Semantically different complaints in the same location -> Blocked by guardrail', () => {
    // E.g. Pothole vs Noise complaint: low semantic similarity (0.20), but exact same GPS coords
    const result = evaluateClusterCandidate(
      0.20, // low semantic similarity
      12.9716, 77.5946, new Date(),
      12.9716, 77.5946, new Date(),
      config
    );
    // Even though geo proximity = 1.0 and temporal = 1.0:
    expect(result.geographicProximity).toBe(1.0);
    expect(result.meetsSemanticGuardrail).toBe(false); // REJECTED by guardrail!
  });

  it('Scenario 3: Similar complaints in nearby locations (< 1 km) -> Merges into cluster', () => {
    const result = evaluateClusterCandidate(
      0.80, // high semantic
      12.9716, 77.5946, new Date(),
      12.9750, 77.5960, new Date(), // ~400 meters away
      config
    );
    expect(result.meetsSemanticGuardrail).toBe(true);
    expect(result.distanceKm).toBeLessThan(1.0);
    expect(result.geographicProximity).toBeGreaterThan(0.85);
    expect(result.hybridScore).toBeGreaterThanOrEqual(config.clusterThreshold);
  });

  it('Scenario 4: Similar complaints in distant locations (50 km away) -> Rejects merge', () => {
    const result = evaluateClusterCandidate(
      0.75, // moderately high semantic similarity
      12.9716, 77.5946, new Date(), // Bangalore
      12.2958, 76.6394, new Date(), // Mysore (130 km away)
      config
    );
    expect(result.meetsSemanticGuardrail).toBe(true);
    expect(result.geographicProximity).toBe(0.0); // beyond 5 km radius
    // hybridScore = 0.75*0.60 + 0*0.25 + 1.0*0.15 = 0.45 + 0.15 = 0.60 < 0.65 threshold
    expect(result.hybridScore).toBeLessThan(config.clusterThreshold);
  });

  it('Scenario 5: Recent vs old complaints: recency difference separates scores', () => {
    const now = new Date('2026-11-16T12:00:00Z');
    const recentCluster = new Date('2026-11-16T11:00:00Z');
    const oldCluster = new Date('2026-09-01T12:00:00Z'); // 76 days old

    const resRecent = evaluateClusterCandidate(0.70, 12.97, 77.59, now, 12.97, 77.59, recentCluster, config);
    const resOld = evaluateClusterCandidate(0.70, 12.97, 77.59, now, 12.97, 77.59, oldCluster, config);

    expect(resRecent.temporalRelevance).toBeGreaterThan(resOld.temporalRelevance);
    expect(resRecent.hybridScore).toBeGreaterThan(resOld.hybridScore);
  });

  it('Scenario 6: Missing GPS coordinates -> computes safely with neutral proximity (0.5)', () => {
    const result = evaluateClusterCandidate(
      0.85,
      null, null, new Date(),
      12.97, 77.59, new Date(),
      config
    );
    expect(result.geographicProximity).toBe(0.5);
    expect(result.distanceKm).toBeNull();
    // 0.85*0.60 + 0.5*0.25 + 1.0*0.15 = 0.51 + 0.125 + 0.15 = 0.785 >= 0.65
    expect(result.hybridScore).toBeGreaterThanOrEqual(config.clusterThreshold);
  });

  it('Scenario 7: Threshold boundary cases (0.65 threshold)', () => {
    // Case A: Just above threshold (0.6525) -> matches
    const scoreAbove = computeHybridScore(0.70, 0.60, 0.55, config);
    expect(scoreAbove).toBeGreaterThanOrEqual(config.clusterThreshold);

    // Case B: Just below threshold (0.640) -> does not match
    const scoreBelow = computeHybridScore(0.55, 0.60, 0.60, config);
    expect(scoreBelow).toBeLessThan(config.clusterThreshold);
  });
});

// =============================================================================
// 6. Running Geo Centroid Updates
// =============================================================================
describe('Running Geo Centroid Updates', () => {
  it('updates weighted average centroid when both cluster and complaint have coords', () => {
    // Cluster has 1 complaint at (10.0, 20.0), new complaint at (12.0, 22.0)
    // Average should be ((10*1)+12)/2 = 11.0, ((20*1)+22)/2 = 21.0
    const updated = calculateUpdatedGeoCentroid(10.0, 20.0, 1, 12.0, 22.0);
    expect(updated.lat).toBe(11.0);
    expect(updated.lng).toBe(21.0);
  });

  it('weights existing cluster count properly for multi-complaint clusters', () => {
    // Cluster has 3 complaints at (10.0, 10.0), 1 new at (14.0, 14.0)
    // Avg = (10*3 + 14)/4 = 44/4 = 11.0
    const updated = calculateUpdatedGeoCentroid(10.0, 10.0, 3, 14.0, 14.0);
    expect(updated.lat).toBe(11.0);
    expect(updated.lng).toBe(11.0);
  });

  it('preserves cluster coordinates if new complaint has missing coords', () => {
    const updated = calculateUpdatedGeoCentroid(12.9716, 77.5946, 2, null, null);
    expect(updated.lat).toBe(12.9716);
    expect(updated.lng).toBe(77.5946);
  });

  it('initializes cluster coordinates if cluster previously had null coords', () => {
    const updated = calculateUpdatedGeoCentroid(null, null, 0, 12.9716, 77.5946);
    expect(updated.lat).toBe(12.9716);
    expect(updated.lng).toBe(77.5946);
  });

  it('returns null coords if both cluster and complaint have null coords', () => {
    const updated = calculateUpdatedGeoCentroid(null, null, 0, null, null);
    expect(updated.lat).toBeNull();
    expect(updated.lng).toBeNull();
  });
});

// =============================================================================
// 7. clusterComplaint() Service E2E Flow
// =============================================================================
describe('clusterComplaint() Service — Hybrid Flow', () => {
  it('creates a new cluster when similarity is low and no suitable cluster exists', async () => {
    const mockComplaint = {
      text: 'Water pipe leaking heavily on MG Road',
      category: 'utility',
      latitude: '12.9716',
      longitude: '77.5946',
      created_at: new Date(),
    };

    // 1. Fetch complaint
    mockPool.query.mockResolvedValueOnce({ rows: [mockComplaint] });
    // 2. Save embedding
    mockPool.query.mockResolvedValueOnce({ rows: [] });
    // 3. Query candidate clusters -> returns distant low-similarity candidate
    mockPool.query.mockResolvedValueOnce({
      rows: [
        {
          id: 50,
          category: 'utility',
          region: 'Downtown',
          status: 'open',
          geo_centroid_lat: '13.1500',
          geo_centroid_lng: '77.7000',
          temporal_weight: '0.8',
          hybrid_score: '45.0',
          similarity: '0.35', // Below semantic guardrail (0.40)
        },
      ],
    });
    // 4. Create new cluster insert (with hybrid columns)
    mockPool.query.mockResolvedValueOnce({ rows: [{ id: 101 }] });
    // 5. Link complaint to new cluster
    mockPool.query.mockResolvedValueOnce({ rows: [] });

    // Recalculate severity mocks:
    mockPool.query.mockResolvedValueOnce({ rows: [{ category: 'utility' }] }); // cluster select
    mockPool.query.mockResolvedValueOnce({ rows: [{ count: '1' }] });          // count
    mockPool.query.mockResolvedValueOnce({ rows: [{ count: '1' }] });          // growth
    mockPool.query.mockResolvedValueOnce({ rows: [{ avg_days: null }] });       // speed
    mockPool.query.mockResolvedValueOnce({ rows: [] });                         // update severity

    // Agent execution log insert mock:
    mockPool.query.mockResolvedValueOnce({ rows: [{ id: 999 }] });

    const clusterId = await clusterComplaint(1);

    expect(clusterId).toBe(101);

    // Verify insert statement created a new cluster
    const calls = mockPool.query.mock.calls.map((c) => c[0]);
    expect(calls.some((sql) => typeof sql === 'string' && sql.includes('INSERT INTO cluster'))).toBe(true);

    // Verify agent logging was invoked
    expect(calls.some((sql) => typeof sql === 'string' && sql.includes('INSERT INTO agent_execution_log'))).toBe(true);
  });

  it('merges into existing cluster when hybrid score exceeds threshold', async () => {
    const mockComplaint = {
      text: 'Major water pipeline rupture on 5th main',
      category: 'utility',
      latitude: '12.9720',
      longitude: '77.5950',
      created_at: new Date(),
    };

    // 1. Fetch complaint
    mockPool.query.mockResolvedValueOnce({ rows: [mockComplaint] });
    // 2. Save embedding
    mockPool.query.mockResolvedValueOnce({ rows: [] });
    // 3. Query candidate clusters -> returns high-similarity nearby candidate
    mockPool.query.mockResolvedValueOnce({
      rows: [
        {
          id: 55,
          category: 'utility',
          region: 'Downtown',
          status: 'open',
          geo_centroid_lat: '12.9716',
          geo_centroid_lng: '77.5946', // ~50m away!
          temporal_weight: '1.0',
          hybrid_score: '85.0',
          similarity: '0.88',         // High semantic match
          complaint_count: 3,
        },
      ],
    });
    // 4. Link complaint to existing cluster
    mockPool.query.mockResolvedValueOnce({ rows: [] });
    // 5. Query linked embeddings for centroid recalculation
    mockPool.query.mockResolvedValueOnce({
      rows: [{ embedding: '[0.025, 0.025]' }, { embedding: '[0.025, 0.025]' }],
    });
    // 6. Query avg geo coordinates
    mockPool.query.mockResolvedValueOnce({
      rows: [{ avg_lat: '12.9718', avg_lng: '77.5948', cnt: '4' }],
    });
    // 7. Update cluster row with centroid + hybrid fields
    mockPool.query.mockResolvedValueOnce({ rows: [] });

    // Recalculate severity mocks:
    mockPool.query.mockResolvedValueOnce({ rows: [{ category: 'utility' }] });
    mockPool.query.mockResolvedValueOnce({ rows: [{ count: '4' }] });
    mockPool.query.mockResolvedValueOnce({ rows: [{ count: '2' }] });
    mockPool.query.mockResolvedValueOnce({ rows: [{ avg_days: '3.0' }] });
    mockPool.query.mockResolvedValueOnce({ rows: [] });

    // Agent execution log insert mock:
    mockPool.query.mockResolvedValueOnce({ rows: [{ id: 1000 }] });

    const clusterId = await clusterComplaint(2);

    expect(clusterId).toBe(55);

    // Verify cluster was updated with hybrid fields
    const calls = mockPool.query.mock.calls;
    const updateCall = calls.find(
      (c) => typeof c[0] === 'string' && c[0].includes('geo_centroid_lat = $2')
    );
    expect(updateCall).toBeDefined();
  });

  it('rejects candidate cluster and creates new cluster when semantic guardrail fails', async () => {
    // Different issue (e.g. noise issue in utility category query) at EXACT same location
    const mockComplaint = {
      text: 'Completely unrelated complaint text',
      category: 'utility',
      latitude: '12.9716',
      longitude: '77.5946',
      created_at: new Date(),
    };

    // 1. Fetch complaint
    mockPool.query.mockResolvedValueOnce({ rows: [mockComplaint] });
    // 2. Save embedding
    mockPool.query.mockResolvedValueOnce({ rows: [] });
    // 3. Query candidate clusters -> exact same coordinates, but low semantic similarity (0.30 < 0.40 guardrail)
    mockPool.query.mockResolvedValueOnce({
      rows: [
        {
          id: 70,
          category: 'utility',
          region: 'Downtown',
          status: 'open',
          geo_centroid_lat: '12.9716',
          geo_centroid_lng: '77.5946',
          similarity: '0.30', // Fails guardrail!
        },
      ],
    });
    // 4. Create new cluster (guardrail rejected candidate 70)
    mockPool.query.mockResolvedValueOnce({ rows: [{ id: 102 }] });
    // 5. Link complaint
    mockPool.query.mockResolvedValueOnce({ rows: [] });

    // Severity mocks:
    mockPool.query.mockResolvedValueOnce({ rows: [{ category: 'utility' }] });
    mockPool.query.mockResolvedValueOnce({ rows: [{ count: '1' }] });
    mockPool.query.mockResolvedValueOnce({ rows: [{ count: '1' }] });
    mockPool.query.mockResolvedValueOnce({ rows: [{ avg_days: null }] });
    mockPool.query.mockResolvedValueOnce({ rows: [] });

    // Agent execution log:
    mockPool.query.mockResolvedValueOnce({ rows: [{ id: 1001 }] });

    const clusterId = await clusterComplaint(3);

    // Must create new cluster 102, NOT join cluster 70
    expect(clusterId).toBe(102);
  });

  it('logs failure in agent_execution_log if an unexpected error occurs', async () => {
    // DB failure during complaint fetch
    mockPool.query.mockRejectedValueOnce(new Error('DB connection drop'));
    // DB failure log attempt
    mockPool.query.mockResolvedValueOnce({ rows: [{ id: 1002 }] });

    await expect(clusterComplaint(999)).rejects.toThrow('DB connection drop');

    // Verify agent_execution_log was invoked with status 'failed'
    const calls = mockPool.query.mock.calls;
    const failLogCall = calls.find(
      (c) => typeof c[0] === 'string' && c[0].includes('INSERT INTO agent_execution_log')
    );
    expect(failLogCall).toBeDefined();
    expect(failLogCall[1]).toContain('failed');
    expect(failLogCall[1]).toContain('hybrid_clustering');
  });
});
