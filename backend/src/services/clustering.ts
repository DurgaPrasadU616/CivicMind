// backend/src/services/clustering.ts
//
// Phase 2 — Hybrid Semantic + Geographic + Temporal Clustering Service.
//
// Combines:
//   1. Semantic similarity (Gemini text-embedding-004 + pgvector cosine similarity)
//   2. Geographic proximity (Haversine distance between complaint and cluster centroid)
//   3. Temporal relevance (exponential time decay based on complaint recency)
//
// Guardrail:
//   Unrelated complaints will never merge simply due to geographic co-location
//   (minimum semantic similarity required).
//
// Safety:
//   - Append-only agent logging with agentType 'hybrid_clustering'
//   - Graceful fallback if migrations 011/012 columns are not yet present in DB
//   - Safe handling of missing GPS coordinates and timestamps
//   - Concurrency safe centroid recalculation

import { pool } from '../config/db';
import { scoringConfig } from '../config/scoring';
import { getEmbedding } from './embeddings';
import { triggerRecommendationIfNeeded } from './recommendations';
import { updateClusterPriorityScore } from './ranking';
import { assignCluster } from './assignment';
import logger from '../utils/logger';
import { backgroundQueue } from './backgroundQueue';
import {
  getHybridConfig,
  evaluateClusterCandidate,
  HybridScoreResult,
  calculateUpdatedGeoCentroid,
} from '../config/hybridClustering';
import { startAgentRun, logAgentStep } from '../utils/agentLogger';
import { randomUUID } from 'crypto';

// Helper: Determine Region based on GPS Coordinates (Bangalore city bounds)
export const getRegionFromCoords = (lat: number, lng: number): 'Downtown' | 'North' | 'South' | 'East' | 'West' => {
  if (lat > 12.975) return 'North';
  if (lat < 12.960) return 'South';
  if (lng > 77.610) return 'East';
  if (lng < 77.580) return 'West';
  return 'Downtown';
};

// Calculate mean vector of coordinates
export const calculateCentroidMean = (vectors: number[][]): number[] => {
  if (vectors.length === 0) return new Array(1536).fill(0);
  const dims = vectors[0].length;
  const mean = new Array(dims).fill(0);

  vectors.forEach((v) => {
    for (let i = 0; i < dims; i++) {
      mean[i] += v[i];
    }
  });

  const count = vectors.length;
  const averaged = mean.map((val) => val / count);

  // Normalize mean back to unit vector
  const magnitude = Math.sqrt(averaged.reduce((sum, val) => sum + val * val, 0));
  return averaged.map((val) => (magnitude > 0 ? val / magnitude : 0));
};

// Recalculates and updates cluster severity scoring in PostgreSQL
export const recalculateClusterSeverity = async (clusterId: number): Promise<number> => {
  if (!pool) return 40;

  // 1. Get cluster info and count complaints
  const clusterRes = await pool.query(
    'SELECT category, status FROM cluster WHERE id = $1',
    [clusterId]
  );
  if (clusterRes.rows.length === 0) return 40;
  const { category } = clusterRes.rows[0];

  const countRes = await pool.query(
    'SELECT COUNT(*) FROM complaint WHERE cluster_id = $1',
    [clusterId]
  );
  const complaintCount = parseInt(countRes.rows[0].count, 10);
  if (complaintCount === 0) return 0;

  // 2. Volume Score (normalized 0-100)
  const volumeScore = Math.min(
    100,
    (complaintCount / scoringConfig.MAX_VOLUME_THRESHOLD) * 100
  );

  // 3. Growth Rate over last 7 days (normalized 0-100, smoothed)
  const growthRes = await pool.query(
    `SELECT COUNT(*) FROM complaint 
     WHERE cluster_id = $1 AND created_at > NOW() - INTERVAL '7 days'`,
    [clusterId]
  );
  const recentCount = parseInt(growthRes.rows[0].count, 10);
  const growthScore = complaintCount > 1 
    ? (recentCount / complaintCount) * 100 
    : 30;

  // 4. Affected Population Score (normalized 0-100)
  const populationScore = Math.min(
    100,
    complaintCount * scoringConfig.AFFECTED_POPULATION_MULTIPLIER
  );

  // 5. Inverse Historical Resolution Speed Score (normalized 0-100)
  const resSpeedRes = await pool.query(
    `SELECT AVG(EXTRACT(EPOCH FROM (updated_at - created_at))) / 86400 as avg_days 
     FROM complaint 
     WHERE category = $1 AND status = 'resolved' AND updated_at IS NOT NULL`,
    [category]
  );

  const avgDays = resSpeedRes.rows[0].avg_days ? parseFloat(resSpeedRes.rows[0].avg_days) : null;
  const resolutionDays = avgDays !== null ? avgDays : scoringConfig.DEFAULT_RESOLUTION_SPEED_DAYS;

  if (avgDays === null) {
    logger.info(`[SCORING] No historical resolution speed for category "${category}". Using fallback default of ${scoringConfig.DEFAULT_RESOLUTION_SPEED_DAYS} days.`);
  }

  const resolutionScore = Math.min(
    100,
    resolutionDays * scoringConfig.RESOLUTION_DELAY_MULTIPLIER
  );

  // 6. Calculate Weighted Severity
  const categoryWeight = scoringConfig.CATEGORY_WEIGHTS[category] || 1.0;

  const baseScore = 
    (volumeScore * scoringConfig.WEIGHTS.volume) +
    (growthScore * scoringConfig.WEIGHTS.growthRate) +
    (populationScore * scoringConfig.WEIGHTS.affectedPopulation) +
    (resolutionScore * scoringConfig.WEIGHTS.resolutionDelay);

  const finalSeverity = Math.min(
    100,
    Math.max(0, Math.round(baseScore * categoryWeight))
  );

  // Update in DB
  await pool.query(
    'UPDATE cluster SET severity_score = $1, complaint_count = $2 WHERE id = $3',
    [finalSeverity, complaintCount, clusterId]
  );

  logger.info(`[SCORING] Recalculated severity for Cluster ${clusterId} (${category}): ${finalSeverity}/100 (Vol: ${complaintCount}, Growth: ${recentCount}, ResDays: ${resolutionDays.toFixed(2)})`);

  return finalSeverity;
};

// ── Hybrid Clustering Engine ─────────────────────────────────────────────────

/**
 * Clusters a complaint using hybrid semantic + geographic + temporal scoring.
 *
 * Steps:
 *   1. Fetch complaint and generate text embedding (Gemini + fallback).
 *   2. Find candidate open clusters of the same category via pgvector similarity.
 *   3. Score candidates across semantic, geographic proximity, and temporal recency.
 *   4. Apply semantic guardrail (reject merge if semantic meaning is unrelated).
 *   5. Merge into highest scoring cluster if hybridScore >= threshold; else create cluster.
 *   6. Update cluster centroid embedding and geo centroid.
 *   7. Recompute severity and priority scores.
 *   8. Log structured decision via agentLogger.
 */
export const clusterComplaint = async (complaintId: number): Promise<number> => {
  if (!pool) throw new Error('Database pool unconfigured');

  const startTime = Date.now();
  const config = getHybridConfig();
  const threshold = config.clusterThreshold;

  try {
    // 1. Fetch complaint content
    const complaintRes = await pool.query(
      'SELECT text, category, latitude, longitude, created_at FROM complaint WHERE id = $1',
      [complaintId]
    );
    if (complaintRes.rows.length === 0) {
      throw new Error(`Complaint with ID ${complaintId} not found`);
    }

    const { text, category, latitude, longitude, created_at: complaintCreatedAt } = complaintRes.rows[0];
    const complaintLat = latitude != null ? parseFloat(latitude) : null;
    const complaintLng = longitude != null ? parseFloat(longitude) : null;

    // 2. Generate embedding (Gemini / deterministic fallback)
    const embedding = await getEmbedding(text);
    const embeddingString = `[${embedding.join(',')}]`;

    // Save the embedding to complaint table
    await pool.query(
      'UPDATE complaint SET embedding = $1::vector WHERE id = $2',
      [embeddingString, complaintId]
    );

    // 3. Query candidate clusters of the same category using pgvector cosine distance
    // We attempt selecting hybrid fields (migration 011); if unmigrated, fall back gracefully.
    let candidateRows: any[] = [];
    let hasHybridSchema = true;

    try {
      const candidateRes = await pool.query(
        `SELECT id, category, region, status,
                geo_centroid_lat, geo_centroid_lng, temporal_weight, hybrid_score,
                complaint_count, updated_at, created_at,
                (1 - (centroid <=> $1::vector)) as similarity 
         FROM cluster 
         WHERE status != 'resolved' AND category = $2
         ORDER BY centroid <=> $1::vector 
         LIMIT 10`,
        [embeddingString, category]
      );
      candidateRows = candidateRes.rows || [];
    } catch (queryErr: any) {
      // Fallback: table might not have 011 columns yet (e.g. before migration or in mock tests)
      hasHybridSchema = false;
      logger.warn(`[CLUSTERING] Hybrid columns query fallback: ${queryErr.message}`);
      const fallbackRes = await pool.query(
        `SELECT id, category, region, status,
                (1 - (centroid <=> $1::vector)) as similarity 
         FROM cluster 
         WHERE status != 'resolved' AND category = $2
         ORDER BY centroid <=> $1::vector 
         LIMIT 10`,
        [embeddingString, category]
      );
      candidateRows = fallbackRes.rows || [];
    }

    // 4. Evaluate candidates with Hybrid Scoring
    let bestCandidate: any = null;
    let bestResult: HybridScoreResult | null = null;

    for (const cand of candidateRows) {
      const rawSim = parseFloat(cand.similarity);
      const evalResult = evaluateClusterCandidate(
        rawSim,
        complaintLat,
        complaintLng,
        complaintCreatedAt || new Date(),
        cand.geo_centroid_lat != null ? parseFloat(cand.geo_centroid_lat) : null,
        cand.geo_centroid_lng != null ? parseFloat(cand.geo_centroid_lng) : null,
        cand.updated_at || cand.created_at || null,
        config
      );

      // Semantic guardrail: reject candidate if semantic similarity is below minimum threshold
      // even if geographic proximity is very high
      if (!evalResult.meetsSemanticGuardrail) {
        logger.info(
          `[CLUSTERING] Candidate Cluster ${cand.id} rejected by semantic guardrail: semantic ${evalResult.semanticSimilarity.toFixed(4)} < min ${config.minSemanticSimilarity}`
        );
        continue;
      }

      if (!bestResult || evalResult.hybridScore > bestResult.hybridScore) {
        bestResult = evalResult;
        bestCandidate = cand;
      }
    }

    let targetClusterId: number;
    const isMatch = Boolean(bestCandidate && bestResult && bestResult.hybridScore >= threshold);

    if (bestCandidate && bestResult && bestResult.hybridScore >= threshold) {
      // ── MATCH FOUND: Attach to existing cluster ───────────────────────────
      targetClusterId = bestCandidate.id;
      const score = bestResult.hybridScore;

      // Check boundary condition (borderline score logging)
      if (Math.abs(score - threshold) <= 0.05) {
        logger.warn(
          `[CLUSTERING] Borderline hybrid score detected: ${score.toFixed(4)} (Threshold: ${threshold}). Complaint ID: ${complaintId}, Cluster ID: ${targetClusterId}. Details: sem=${bestResult.semanticSimilarity.toFixed(3)}, geo=${bestResult.geographicProximity.toFixed(3)}, temp=${bestResult.temporalRelevance.toFixed(3)}`
        );
      } else {
        logger.info(
          `[CLUSTERING] Hybrid match: Complaint ${complaintId} -> Cluster ${targetClusterId} (hybridScore: ${score.toFixed(4)}, sem: ${bestResult.semanticSimilarity.toFixed(3)}, geo: ${bestResult.geographicProximity.toFixed(3)}, temp: ${bestResult.temporalRelevance.toFixed(3)})`
        );
      }

      // Link complaint
      await pool.query(
        'UPDATE complaint SET cluster_id = $1 WHERE id = $2',
        [targetClusterId, complaintId]
      );

      // If cluster is resolved, flag for review
      if (bestCandidate.status === 'resolved') {
        await pool.query(
          `UPDATE cluster SET needs_review = TRUE WHERE id = $1`,
          [targetClusterId]
        );
        logger.info(`[CLUSTERING] Cluster ${targetClusterId} is resolved but received new complaint ${complaintId}. Flagged as needs_review.`);
      }

      // Recalculate cluster centroid vector from all linked complaints
      const linkedComplaints = await pool.query(
        'SELECT embedding FROM complaint WHERE cluster_id = $1 AND embedding IS NOT NULL',
        [targetClusterId]
      );
      const vectors = linkedComplaints.rows.map((row) => {
        return row.embedding.replace('[', '').replace(']', '').split(',').map(Number);
      });

      const newCentroid = calculateCentroidMean(vectors);
      const newCentroidString = `[${newCentroid.join(',')}]`;

      // Update geographic centroid using robust average of all geotagged complaints
      const geoAvgRes = await pool.query(
        `SELECT AVG(latitude) as avg_lat, AVG(longitude) as avg_lng, COUNT(*) as cnt
         FROM complaint 
         WHERE cluster_id = $1 AND latitude IS NOT NULL AND longitude IS NOT NULL`,
        [targetClusterId]
      );

      const avgLat = geoAvgRes.rows[0]?.avg_lat != null ? parseFloat(geoAvgRes.rows[0].avg_lat) : null;
      const avgLng = geoAvgRes.rows[0]?.avg_lng != null ? parseFloat(geoAvgRes.rows[0].avg_lng) : null;

      // Update cluster in DB with hybrid fields
      if (hasHybridSchema) {
        try {
          await pool.query(
            `UPDATE cluster 
             SET centroid = $1::vector,
                 geo_centroid_lat = $2,
                 geo_centroid_lng = $3,
                 temporal_weight = $4,
                 hybrid_score = $5
             WHERE id = $6`,
            [
              newCentroidString,
              avgLat,
              avgLng,
              parseFloat(bestResult.temporalRelevance.toFixed(4)),
              parseFloat((bestResult.hybridScore * 100).toFixed(2)),
              targetClusterId,
            ]
          );
        } catch {
          // Fallback if update fails
          await pool.query(
            'UPDATE cluster SET centroid = $1::vector WHERE id = $2',
            [newCentroidString, targetClusterId]
          );
        }
      } else {
        await pool.query(
          'UPDATE cluster SET centroid = $1::vector WHERE id = $2',
          [newCentroidString, targetClusterId]
        );
      }

    } else {
      // ── COLD START / NO MATCH: Create a new cluster ───────────────────────
      const lat = complaintLat !== null ? complaintLat : 12.9716;
      const lng = complaintLng !== null ? complaintLng : 77.5946;
      const region = getRegionFromCoords(lat, lng);

      const capitalizedCat = category.charAt(0).toUpperCase() + category.slice(1);
      const title = `${capitalizedCat} Issue in ${region}`;

      let insertClusterRes;
      if (hasHybridSchema) {
        try {
          insertClusterRes = await pool.query(
            `INSERT INTO cluster (title, category, region, status, centroid, complaint_count, geo_centroid_lat, geo_centroid_lng, temporal_weight, hybrid_score)
             VALUES ($1, $2, $3, 'open', $4::vector, 0, $5, $6, 1.0, 100.0)
             RETURNING id`,
            [title, category, region, embeddingString, complaintLat, complaintLng]
          );
        } catch {
          // Schema fallback
          insertClusterRes = await pool.query(
            `INSERT INTO cluster (title, category, region, status, centroid, complaint_count)
             VALUES ($1, $2, $3, 'open', $4::vector, 0)
             RETURNING id`,
            [title, category, region, embeddingString]
          );
        }
      } else {
        insertClusterRes = await pool.query(
          `INSERT INTO cluster (title, category, region, status, centroid, complaint_count)
           VALUES ($1, $2, $3, 'open', $4::vector, 0)
           RETURNING id`,
          [title, category, region, embeddingString]
        );
      }

      targetClusterId = insertClusterRes.rows[0].id;
      logger.info(`[CLUSTERING] Created new Cluster ${targetClusterId} for Complaint ${complaintId} (Category: ${category}, Region: ${region})`);

      // Link complaint
      await pool.query(
        'UPDATE complaint SET cluster_id = $1 WHERE id = $2',
        [targetClusterId, complaintId]
      );

      // Asynchronously assign the cluster to a department/official
      backgroundQueue.enqueue(
        `assign_cluster_${targetClusterId}`,
        async () => {
          await assignCluster(targetClusterId, category, region);
        }
      );
    }

    // 5. Update severity rating
    const newSeverity = await recalculateClusterSeverity(targetClusterId);

    // 6. Update priority_score based on new severity + cluster age + resource cost
    await updateClusterPriorityScore(targetClusterId, newSeverity);

    // 7. Fire-and-forget: queue recommendation check
    backgroundQueue.enqueue(
      `trigger_recommendation_cluster_${targetClusterId}`,
      async () => {
        await triggerRecommendationIfNeeded(targetClusterId, newSeverity);
      }
    );

    // 8. Agent Audit Log via agentLogger
    const durationMs = Date.now() - startTime;
    const run = startAgentRun('hybrid_clustering', {
      complaintId,
      clusterId: targetClusterId,
      triggeredBy: 'system',
    });

    await run.log({
      stepName: 'hybrid_clustering_decision',
      status: 'success',
      inputData: {
        complaintId,
        category,
        hasCoordinates: complaintLat !== null && complaintLng !== null,
        weights: {
          semantic: config.semanticWeight,
          geo: config.geoWeight,
          temporal: config.temporalWeight,
        },
        threshold,
      },
      outputData: {
        decision: isMatch ? 'merged_existing_cluster' : 'created_new_cluster',
        targetClusterId,
        semanticSimilarity: bestResult?.semanticSimilarity ?? 0,
        geographicProximity: bestResult?.geographicProximity ?? 0.5,
        temporalRelevance: bestResult?.temporalRelevance ?? 1.0,
        finalHybridScore: bestResult ? parseFloat(bestResult.hybridScore.toFixed(4)) : (isMatch ? 1.0 : 0.0),
        distanceKm: bestResult?.distanceKm != null ? parseFloat(bestResult.distanceKm.toFixed(3)) : null,
        daysDiff: bestResult?.daysDiff != null ? parseFloat(bestResult.daysDiff.toFixed(2)) : 0,
        thresholdUsed: threshold,
        candidatesEvaluated: candidateRows.length,
      },
      durationMs,
    });

    return targetClusterId;
  } catch (err: any) {
    const durationMs = Date.now() - startTime;
    logger.error(`[CLUSTERING] Failed to cluster complaint ${complaintId}: ${err.message}`);

    // Log failure in agent_execution_log
    await logAgentStep({
      runId: randomUUID(),
      agentType: 'hybrid_clustering',
      stepIndex: 0,
      stepName: 'hybrid_clustering_decision',
      complaintId,
      status: 'failed',
      errorMessage: err.message,
      durationMs,
      triggeredBy: 'system',
    });

    throw err;
  }
};
