// backend/src/services/ranking.ts
//
// Computes priority_score for clusters.
//
// Formula:
//   priority_score = severity_score * urgency_decay(days_since_first_report) * resource_cost_factor
//
// urgency_decay: exponential with a hard floor so old critical issues never silently vanish.
// resource_cost_factor: per-category tunable weight from scoringConfig — higher cost moderates priority.

import { pool } from '../config/db';
import { scoringConfig } from '../config/scoring';

// ---------------------------------------------------------------------------
// Pure functions — exported for unit testing
// ---------------------------------------------------------------------------

/**
 * Computes the urgency decay multiplier.
 *
 * @param daysSinceFirstReport  Days since the cluster's first complaint.
 *                              Pass null/undefined for brand-new clusters → returns 1.0 (max urgency).
 * @returns A value in [URGENCY_DECAY_FLOOR, 1.0]
 */
export const computeUrgencyDecay = (daysSinceFirstReport: number | null | undefined): number => {
  // Brand-new cluster with no age data → max urgency, no decay
  if (daysSinceFirstReport === null || daysSinceFirstReport === undefined || daysSinceFirstReport < 0) {
    return 1.0;
  }

  const { URGENCY_DECAY_RATE, URGENCY_DECAY_FLOOR } = scoringConfig;
  const rawDecay = Math.exp(-URGENCY_DECAY_RATE * daysSinceFirstReport);
  return Math.max(URGENCY_DECAY_FLOOR, rawDecay);
};

/**
 * Resolves the resource_cost_factor for a category.
 * Falls back to 1.0 (neutral) if the category is not in config and logs a warning.
 */
export const getResourceCostFactor = (category: string): number => {
  const factor = scoringConfig.RESOURCE_COST_WEIGHTS[category];
  if (factor === undefined) {
    console.warn(
      `[RANKING] No resource_cost_factor for category "${category}". Using neutral 1.0 fallback.`
    );
    return 1.0;
  }
  return factor;
};

/**
 * Computes the final priority_score.
 * Result is clamped to [0, 100] and rounded to an integer.
 *
 * @param severityScore         The pre-computed severity_score (0-100)
 * @param daysSinceFirstReport  Days since first complaint in cluster (null = brand-new)
 * @param category              Complaint category string
 */
export const computePriorityScore = (
  severityScore: number,
  daysSinceFirstReport: number | null | undefined,
  category: string
): number => {
  const decay = computeUrgencyDecay(daysSinceFirstReport);
  const costFactor = getResourceCostFactor(category);
  const raw = severityScore * decay * costFactor;
  return Math.min(100, Math.max(0, Math.round(raw)));
};

// ---------------------------------------------------------------------------
// DB-backed update function
// ---------------------------------------------------------------------------

/**
 * Reads the cluster's first-report age from the DB, computes priority_score,
 * and writes it back to the cluster row.
 *
 * Called after every severity recalculation.
 */
export const updateClusterPriorityScore = async (
  clusterId: number,
  severityScore: number
): Promise<number> => {
  if (!pool) return 0;

  // Fetch category and the age of the oldest complaint in the cluster
  const clusterRes = await pool.query(
    `SELECT cl.category,
            EXTRACT(EPOCH FROM (NOW() - MIN(co.created_at))) / 86400 AS days_since_first
     FROM cluster cl
     LEFT JOIN complaint co ON co.cluster_id = cl.id
     WHERE cl.id = $1
     GROUP BY cl.id, cl.category`,
    [clusterId]
  );

  if (clusterRes.rows.length === 0) return 0;

  const { category, days_since_first } = clusterRes.rows[0];

  // days_since_first is NULL when no complaints are linked yet (brand-new empty cluster)
  const daysSince: number | null =
    days_since_first !== null && days_since_first !== undefined
      ? parseFloat(days_since_first)
      : null;

  const priorityScore = computePriorityScore(severityScore, daysSince, category);

  await pool.query(
    'UPDATE cluster SET priority_score = $1 WHERE id = $2',
    [priorityScore, clusterId]
  );

  console.log(
    `[RANKING] Cluster ${clusterId} (${category}): ` +
    `severity=${severityScore}, decay=${computeUrgencyDecay(daysSince).toFixed(3)}, ` +
    `costFactor=${getResourceCostFactor(category).toFixed(2)}, priority=${priorityScore}`
  );

  return priorityScore;
};
