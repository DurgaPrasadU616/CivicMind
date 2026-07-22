// backend/tests/ranking.test.ts
// Unit and integration tests for the priority_score ranking service.
// Tests are pure-function only (no DB needed for the core math);
// updateClusterPriorityScore uses a mocked pool.

import { pool } from '../src/config/db';
import { scoringConfig } from '../src/config/scoring';
import {
  computeUrgencyDecay,
  getResourceCostFactor,
  computePriorityScore,
  updateClusterPriorityScore,
} from '../src/services/ranking';

jest.mock('../src/config/db', () => {
  const mPool = { query: jest.fn() };
  return { pool: mPool, checkDbConnection: jest.fn() };
});

describe('Ranking Service — priority_score', () => {
  const mockPool = pool as unknown as { query: jest.Mock };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  // ---------------------------------------------------------------------------
  // computeUrgencyDecay — decay curve + floor
  // ---------------------------------------------------------------------------
  describe('computeUrgencyDecay', () => {
    it('should return 1.0 for a brand-new cluster (null days)', () => {
      expect(computeUrgencyDecay(null)).toBe(1.0);
    });

    it('should return 1.0 for undefined days (brand-new)', () => {
      expect(computeUrgencyDecay(undefined)).toBe(1.0);
    });

    it('should return 1.0 for 0 days (just created)', () => {
      expect(computeUrgencyDecay(0)).toBe(1.0);
    });

    it('should return a value < 1 for any positive day count', () => {
      expect(computeUrgencyDecay(7)).toBeLessThan(1.0);
    });

    it('should decay monotonically — older clusters have lower decay', () => {
      const d7 = computeUrgencyDecay(7);
      const d14 = computeUrgencyDecay(14);
      const d30 = computeUrgencyDecay(30);
      expect(d7).toBeGreaterThan(d14);
      expect(d14).toBeGreaterThan(d30);
    });

    it('should NEVER decay below the URGENCY_DECAY_FLOOR (even for very old clusters)', () => {
      const floor = scoringConfig.URGENCY_DECAY_FLOOR;
      // Test extreme staleness — 1000 days
      const veryOld = computeUrgencyDecay(1000);
      expect(veryOld).toBeGreaterThanOrEqual(floor);
      expect(veryOld).toBe(floor); // should hit the floor exactly
    });

    it('should return exactly the floor for any cluster older than the natural floor crossover', () => {
      // With rate=0.05, floor=0.20: crossover at -ln(0.20)/0.05 ≈ 32.2 days
      // Any cluster older than ~33 days should return exactly the floor
      const floor = scoringConfig.URGENCY_DECAY_FLOOR;
      expect(computeUrgencyDecay(60)).toBe(floor);
      expect(computeUrgencyDecay(100)).toBe(floor);
      expect(computeUrgencyDecay(365)).toBe(floor);
    });

    it('should return a value above the floor for clusters younger than the crossover', () => {
      const floor = scoringConfig.URGENCY_DECAY_FLOOR;
      // At 7 days with rate=0.05: exp(-0.35) ≈ 0.70 > 0.20
      const d7 = computeUrgencyDecay(7);
      expect(d7).toBeGreaterThan(floor);
    });

    it('should handle negative day values as if brand-new (returns 1.0)', () => {
      expect(computeUrgencyDecay(-5)).toBe(1.0);
    });
  });

  // ---------------------------------------------------------------------------
  // getResourceCostFactor — config lookup + warning on missing
  // ---------------------------------------------------------------------------
  describe('getResourceCostFactor', () => {
    it('should return the configured factor for known categories', () => {
      expect(getResourceCostFactor('utility')).toBe(scoringConfig.RESOURCE_COST_WEIGHTS.utility);
      expect(getResourceCostFactor('noise')).toBe(scoringConfig.RESOURCE_COST_WEIGHTS.noise);
      expect(getResourceCostFactor('infrastructure')).toBe(scoringConfig.RESOURCE_COST_WEIGHTS.infrastructure);
    });

    it('should return 1.0 (neutral) for an unknown/missing category', () => {
      const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
      const result = getResourceCostFactor('alien_tech');
      expect(result).toBe(1.0);
      warnSpy.mockRestore();
    });

    it('should log a warning when category is not in config', () => {
      const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
      getResourceCostFactor('unconfigured_type');
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('No resource_cost_factor')
      );
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('unconfigured_type')
      );
      warnSpy.mockRestore();
    });

    it('should NOT log a warning for known categories', () => {
      const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
      getResourceCostFactor('safety');
      expect(warnSpy).not.toHaveBeenCalled();
      warnSpy.mockRestore();
    });
  });

  // ---------------------------------------------------------------------------
  // computePriorityScore — full formula
  // ---------------------------------------------------------------------------
  describe('computePriorityScore', () => {
    it('brand-new cluster should get max urgency multiplier (decay=1.0)', () => {
      // severity=80, days=null (brand-new), utility (factor=0.70)
      // expected: round(80 * 1.0 * 0.70) = 56
      const result = computePriorityScore(80, null, 'utility');
      expect(result).toBe(Math.round(80 * 1.0 * scoringConfig.RESOURCE_COST_WEIGHTS.utility));
    });

    it('brand-new cluster with noise category (factor=1.0) should equal severity', () => {
      // severity=60, days=null, noise (factor=1.0) → priority = 60
      const result = computePriorityScore(60, null, 'noise');
      expect(result).toBe(60);
    });

    it('old high-severity cluster should NOT drop below floor * costFactor * severity', () => {
      // severity=100, days=1000 (very old), noise (factor=1.0)
      // decay = floor = 0.20
      // priority = round(100 * 0.20 * 1.0) = 20
      const result = computePriorityScore(100, 1000, 'noise');
      const expected = Math.round(100 * scoringConfig.URGENCY_DECAY_FLOOR * 1.0);
      expect(result).toBe(expected);
      // Old critical issues should NEVER go below floor * severity
      expect(result).toBeGreaterThan(0);
    });

    it('missing resource_cost_factor falls back to 1.0 (neutral)', () => {
      const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
      // severity=50, days=0, category not in config → factor=1.0
      const result = computePriorityScore(50, 0, 'unknown_category');
      expect(result).toBe(50); // 50 * 1.0 * 1.0 = 50
      warnSpy.mockRestore();
    });

    it('result is always clamped to [0, 100]', () => {
      // Impossible to get >100 with current config (max severity=100, max decay=1.0, max factor≤1.0)
      // But test the ceiling guard anyway with hand-crafted values
      const result = computePriorityScore(100, 0, 'noise');
      expect(result).toBeGreaterThanOrEqual(0);
      expect(result).toBeLessThanOrEqual(100);
    });

    it('utility category at 7 days should be significantly lower than noise at same age', () => {
      // utility factor (0.70) vs noise factor (1.0)
      const utility = computePriorityScore(80, 7, 'utility');
      const noise = computePriorityScore(80, 7, 'noise');
      expect(utility).toBeLessThan(noise);
    });

    // ----- Tie-breaking tests -----
    describe('tie-breaking via priority ordering', () => {
      it('two clusters with same priority_score should be distinguishable by complaint_count', () => {
        // A: severity=50, noise, new → priority=50
        // B: severity=50, noise, new → priority=50
        // Both equal — backend tiebreaker uses complaint_count (tested here conceptually)
        const prioA = computePriorityScore(50, null, 'noise');
        const prioB = computePriorityScore(50, null, 'noise');
        expect(prioA).toBe(prioB); // confirm tie
        // The tie-breaking column (complaint_count) is handled by ORDER BY in SQL — not in the function.
        // We just confirm the tie exists (the route test covers ORDER BY).
      });

      it('different staleness should break a severity tie deterministically', () => {
        // Both severity=50, noise. But A is new (days=0) and B is stale (days=90).
        const prioNew = computePriorityScore(50, 0, 'noise');
        const prioStale = computePriorityScore(50, 90, 'noise');
        expect(prioNew).toBeGreaterThan(prioStale);
      });
    });
  });

  // ---------------------------------------------------------------------------
  // updateClusterPriorityScore — DB-backed function
  // ---------------------------------------------------------------------------
  describe('updateClusterPriorityScore', () => {
    it('should query cluster age, compute priority, and write it to DB', async () => {
      // Mock: cluster join returning category=noise, days_since_first=0 (brand-new)
      mockPool.query.mockResolvedValueOnce({
        rows: [{ category: 'noise', days_since_first: '0' }],
      });
      mockPool.query.mockResolvedValueOnce({ rows: [] }); // UPDATE

      const result = await updateClusterPriorityScore(10, 60);

      // noise, 0 days → priority = round(60 * 1.0 * 1.0) = 60
      expect(result).toBe(60);
      const updateCall = mockPool.query.mock.calls[1];
      expect(updateCall[0]).toContain('UPDATE cluster SET priority_score');
      expect(updateCall[1][0]).toBe(60);
      expect(updateCall[1][1]).toBe(10);
    });

    it('should handle brand-new cluster (days_since_first is null) as max urgency', async () => {
      mockPool.query.mockResolvedValueOnce({
        rows: [{ category: 'noise', days_since_first: null }],
      });
      mockPool.query.mockResolvedValueOnce({ rows: [] }); // UPDATE

      const result = await updateClusterPriorityScore(11, 80);

      // null days → decay=1.0 → priority = round(80 * 1.0 * 1.0) = 80
      expect(result).toBe(80);
    });

    it('should apply decay floor for very old stale clusters', async () => {
      mockPool.query.mockResolvedValueOnce({
        rows: [{ category: 'noise', days_since_first: '1000' }],
      });
      mockPool.query.mockResolvedValueOnce({ rows: [] }); // UPDATE

      const result = await updateClusterPriorityScore(12, 100);

      // decay=0.20 (floor), noise factor=1.0 → priority = round(100 * 0.20 * 1.0) = 20
      expect(result).toBe(20);
    });

    it('should return 0 when cluster is not found in DB', async () => {
      mockPool.query.mockResolvedValueOnce({ rows: [] });

      const result = await updateClusterPriorityScore(9999, 80);
      expect(result).toBe(0);
    });

    it('should use resource_cost_factor for utility category (moderates priority down)', async () => {
      mockPool.query.mockResolvedValueOnce({
        rows: [{ category: 'utility', days_since_first: '0' }],
      });
      mockPool.query.mockResolvedValueOnce({ rows: [] });

      const result = await updateClusterPriorityScore(13, 100);

      // utility factor=0.70, days=0 → priority = round(100 * 1.0 * 0.70) = 70
      expect(result).toBe(Math.round(100 * 1.0 * scoringConfig.RESOURCE_COST_WEIGHTS.utility));
    });

    it('should warn and use 1.0 factor when category is unknown', async () => {
      const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
      mockPool.query.mockResolvedValueOnce({
        rows: [{ category: 'mystery', days_since_first: '0' }],
      });
      mockPool.query.mockResolvedValueOnce({ rows: [] });

      const result = await updateClusterPriorityScore(14, 50);

      // unknown category → factor=1.0, days=0 → priority=50
      expect(result).toBe(50);
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('mystery'));
      warnSpy.mockRestore();
    });
  });
});
