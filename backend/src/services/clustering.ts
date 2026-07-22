// backend/src/services/clustering.ts

import { pool } from '../config/db';
import { scoringConfig } from '../config/scoring';
import { getEmbedding } from './embeddings';
import { triggerRecommendationIfNeeded } from './recommendations';
import { updateClusterPriorityScore } from './ranking';

// Helper: Determine Region based on GPS Coordinates
const getRegionFromCoords = (lat: number, lng: number): 'Downtown' | 'North' | 'South' | 'East' | 'West' => {
  if (lat > 12.975) return 'North';
  if (lat < 12.960) return 'South';
  if (lng > 77.610) return 'East';
  if (lng < 77.580) return 'West';
  return 'Downtown';
};

// Calculate mean vector of coordinates
const calculateCentroidMean = (vectors: number[][]): number[] => {
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

  // 3. Growth Rate over last 7 days (normalized 0-100, smoothed to prevent single-complaint spike distortion)
  const growthRes = await pool.query(
    `SELECT COUNT(*) FROM complaint 
     WHERE cluster_id = $1 AND created_at > NOW() - INTERVAL '7 days'`,
    [clusterId]
  );
  const recentCount = parseInt(growthRes.rows[0].count, 10);
  // Spike smoothing: if there is only 1 complaint, growth is baseline 30%. Otherwise, ratio of recent to total.
  const growthScore = complaintCount > 1 
    ? (recentCount / complaintCount) * 100 
    : 30;

  // 4. Affected Population Score (normalized 0-100)
  const populationScore = Math.min(
    100,
    complaintCount * scoringConfig.AFFECTED_POPULATION_MULTIPLIER
  );

  // 5. Inverse Historical Resolution Speed Score (normalized 0-100)
  // Queries average time in days it takes to resolve complaints of this category
  const resSpeedRes = await pool.query(
    `SELECT AVG(EXTRACT(EPOCH FROM (updated_at - created_at))) / 86400 as avg_days 
     FROM complaint 
     WHERE category = $1 AND status = 'resolved' AND updated_at IS NOT NULL`,
    [category]
  );
  
  const avgDays = resSpeedRes.rows[0].avg_days ? parseFloat(resSpeedRes.rows[0].avg_days) : null;
  const resolutionDays = avgDays !== null ? avgDays : scoringConfig.DEFAULT_RESOLUTION_SPEED_DAYS;
  
  if (avgDays === null) {
    console.log(`[SCORING] No historical resolution speed for category "${category}". Using fallback default of ${scoringConfig.DEFAULT_RESOLUTION_SPEED_DAYS} days.`);
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

  console.log(`[SCORING] Recalculated severity for Cluster ${clusterId} (${category}): ${finalSeverity}/100 (Vol: ${complaintCount}, Growth: ${recentCount}, ResDays: ${resolutionDays.toFixed(2)})`);

  return finalSeverity;
};

// Clusters a complaint by comparing vector cosine similarity
export const clusterComplaint = async (complaintId: number): Promise<number> => {
  if (!pool) throw new Error('Database pool unconfigured');

  // 1. Fetch complaint content
  const complaintRes = await pool.query(
    'SELECT text, category, latitude, longitude FROM complaint WHERE id = $1',
    [complaintId]
  );
  if (complaintRes.rows.length === 0) {
    throw new Error(`Complaint with ID ${complaintId} not found`);
  }
  const { text, category, latitude, longitude } = complaintRes.rows[0];

  // 2. Generate embedding (Gemini / deterministic fallback)
  const embedding = await getEmbedding(text);
  const embeddingString = `[${embedding.join(',')}]`;

  // Save the embedding to complaint table
  await pool.query(
    'UPDATE complaint SET embedding = $1::vector WHERE id = $2',
    [embeddingString, complaintId]
  );

  // 3. Find closest matching open cluster of same category using pgvector cosine distance <=>
  // Cosine Similarity = 1 - Cosine Distance
  const closestClusterRes = await pool.query(
    `SELECT id, category, region, (1 - (centroid <=> $1::vector)) as similarity 
     FROM cluster 
     WHERE status != 'resolved' AND category = $2
     ORDER BY centroid <=> $1::vector 
     LIMIT 1`,
    [embeddingString, category]
  );

  let targetClusterId: number;
  const threshold = scoringConfig.CLUSTERING_THRESHOLD;

  if (closestClusterRes.rows.length > 0 && closestClusterRes.rows[0].similarity >= threshold) {
    // MATCH FOUND: Attach to existing cluster
    const match = closestClusterRes.rows[0];
    targetClusterId = match.id;
    const similarity = parseFloat(match.similarity);

    // Check boundary condition (borderline similarity score logging)
    if (Math.abs(similarity - threshold) <= 0.05) {
      console.warn(`[CLUSTERING] Borderline similarity score detected: ${similarity.toFixed(4)} (Threshold: ${threshold}). Complaint ID: ${complaintId}, Cluster ID: ${targetClusterId}. Logging for manual tuning.`);
    } else {
      console.log(`[CLUSTERING] Matched Complaint ${complaintId} to Cluster ${targetClusterId} with similarity ${similarity.toFixed(4)}`);
    }

    // Link complaint
    await pool.query(
      'UPDATE complaint SET cluster_id = $1 WHERE id = $2',
      [targetClusterId, complaintId]
    );

    // Recalculate cluster centroid vector
    const linkedComplaints = await pool.query(
      'SELECT embedding FROM complaint WHERE cluster_id = $1 AND embedding IS NOT NULL',
      [targetClusterId]
    );
    const vectors = linkedComplaints.rows.map((row) => {
      // Parse vector string [v1, v2, ...] to floats
      return row.embedding.replace('[', '').replace(']', '').split(',').map(Number);
    });

    const newCentroid = calculateCentroidMean(vectors);
    const newCentroidString = `[${newCentroid.join(',')}]`;

    await pool.query(
      'UPDATE cluster SET centroid = $1::vector WHERE id = $2',
      [newCentroidString, targetClusterId]
    );

  } else {
    // COLD START / NO MATCH: Create a new cluster
    const lat = latitude ? parseFloat(latitude) : 12.9716;
    const lng = longitude ? parseFloat(longitude) : 77.5946;
    const region = getRegionFromCoords(lat, lng);
    
    const capitalizedCat = category.charAt(0).toUpperCase() + category.slice(1);
    const title = `${capitalizedCat} Issue in ${region}`;

    const insertClusterRes = await pool.query(
      `INSERT INTO cluster (title, category, region, status, centroid, complaint_count)
       VALUES ($1, $2, $3, 'pending', $4::vector, 0)
       RETURNING id`,
      [title, category, region, embeddingString]
    );

    targetClusterId = insertClusterRes.rows[0].id;
    console.log(`[CLUSTERING] Created new Cluster ${targetClusterId} for Complaint ${complaintId} (Category: ${category}, Region: ${region})`);

    // Link complaint
    await pool.query(
      'UPDATE complaint SET cluster_id = $1 WHERE id = $2',
      [targetClusterId, complaintId]
    );
  }

  // 4. Update severity rating and asynchronously trigger recommendation if band escalated
  const newSeverity = await recalculateClusterSeverity(targetClusterId);

  // 5. Update priority_score based on new severity + cluster age + resource cost
  await updateClusterPriorityScore(targetClusterId, newSeverity);

  // Fire-and-forget: queue recommendation check without blocking the complaint route
  setImmediate(() => {
    triggerRecommendationIfNeeded(targetClusterId, newSeverity).catch((err) => {
      console.error(`[CLUSTERING] Recommendation trigger error for Cluster ${targetClusterId}:`, err);
    });
  });

  return targetClusterId;
};
