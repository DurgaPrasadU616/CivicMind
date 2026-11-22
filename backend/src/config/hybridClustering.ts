// backend/src/config/hybridClustering.ts
//
// Phase 2 — Hybrid Semantic + Geographic + Temporal Clustering Configuration & Algorithms.
//
// Formula:
//   hybridScore = (semanticSimilarity * w_sem) + (geographicProximity * w_geo) + (temporalRelevance * w_temp)
//
// Default weights:
//   w_sem  = 0.60 (semantic similarity via embeddings)
//   w_geo  = 0.25 (geographic proximity via Haversine distance)
//   w_temp = 0.15 (temporal relevance via time decay)
//
// Safety & Robustness:
//   - All 3 sub-scores are normalized between 0.0 and 1.0.
//   - Weights are validated to be non-negative and sum to 1.0 (with fallback to defaults if invalid).
//   - Missing or invalid GPS coordinates are handled safely without crashing.
//   - Missing or invalid timestamps are handled safely without crashing.
//   - Guardrail: minimum semantic similarity required before merging, preventing completely
//     unrelated complaints from merging simply because they occurred at the same location.

import logger from '../utils/logger';

// ── Configuration Interface ──────────────────────────────────────────────────

export interface HybridClusteringConfig {
  semanticWeight: number;
  geoWeight: number;
  temporalWeight: number;
  clusterThreshold: number;
  geoRadiusKm: number;
  temporalDecayDays: number;
  minSemanticSimilarity: number;
}

// ── Default Weights & Thresholds ─────────────────────────────────────────────

export const DEFAULT_HYBRID_CONFIG: Readonly<HybridClusteringConfig> = Object.freeze({
  semanticWeight: 0.60,
  geoWeight: 0.25,
  temporalWeight: 0.15,
  clusterThreshold: 0.65,
  geoRadiusKm: 5.0,
  temporalDecayDays: 30.0,
  minSemanticSimilarity: 0.40, // Guardrail: reject merge if semantic meaning is unrelated
});

/**
 * Validates weights: must be non-negative and sum to 1.0 (within 0.001 tolerance).
 */
export const validateWeights = (
  semantic: number,
  geo: number,
  temporal: number
): { valid: boolean; reason?: string } => {
  if (isNaN(semantic) || isNaN(geo) || isNaN(temporal)) {
    return { valid: false, reason: 'Weights must be numeric' };
  }
  if (semantic < 0 || geo < 0 || temporal < 0) {
    return { valid: false, reason: 'Weights must be non-negative' };
  }
  const sum = semantic + geo + temporal;
  if (Math.abs(sum - 1.0) > 0.001) {
    return { valid: false, reason: `Weights must sum to 1.0 (received sum ${sum.toFixed(4)})` };
  }
  return { valid: true };
};

/**
 * Loads and validates hybrid clustering configuration from environment variables.
 * Falls back safely to documented defaults if variables are missing or invalid.
 */
export const getHybridConfig = (): HybridClusteringConfig => {
  const envSem = process.env.HYBRID_SEMANTIC_WEIGHT ? parseFloat(process.env.HYBRID_SEMANTIC_WEIGHT) : DEFAULT_HYBRID_CONFIG.semanticWeight;
  const envGeo = process.env.HYBRID_GEO_WEIGHT ? parseFloat(process.env.HYBRID_GEO_WEIGHT) : DEFAULT_HYBRID_CONFIG.geoWeight;
  const envTemp = process.env.HYBRID_TEMPORAL_WEIGHT ? parseFloat(process.env.HYBRID_TEMPORAL_WEIGHT) : DEFAULT_HYBRID_CONFIG.temporalWeight;

  const validation = validateWeights(envSem, envGeo, envTemp);
  let semanticWeight = envSem;
  let geoWeight = envGeo;
  let temporalWeight = envTemp;

  if (!validation.valid) {
    logger.warn(`[HYBRID_CONFIG] Invalid hybrid weights (${validation.reason}). Falling back to safe defaults (0.60, 0.25, 0.15).`);
    semanticWeight = DEFAULT_HYBRID_CONFIG.semanticWeight;
    geoWeight = DEFAULT_HYBRID_CONFIG.geoWeight;
    temporalWeight = DEFAULT_HYBRID_CONFIG.temporalWeight;
  }

  const clusterThreshold = process.env.HYBRID_CLUSTER_THRESHOLD
    ? parseFloat(process.env.HYBRID_CLUSTER_THRESHOLD)
    : DEFAULT_HYBRID_CONFIG.clusterThreshold;

  const geoRadiusKm = process.env.HYBRID_GEO_RADIUS_KM
    ? parseFloat(process.env.HYBRID_GEO_RADIUS_KM)
    : DEFAULT_HYBRID_CONFIG.geoRadiusKm;

  const temporalDecayDays = process.env.HYBRID_TEMPORAL_DECAY_DAYS
    ? parseFloat(process.env.HYBRID_TEMPORAL_DECAY_DAYS)
    : DEFAULT_HYBRID_CONFIG.temporalDecayDays;

  const minSemanticSimilarity = process.env.HYBRID_MIN_SEMANTIC_SIMILARITY
    ? parseFloat(process.env.HYBRID_MIN_SEMANTIC_SIMILARITY)
    : DEFAULT_HYBRID_CONFIG.minSemanticSimilarity;

  return {
    semanticWeight,
    geoWeight,
    temporalWeight,
    clusterThreshold: isNaN(clusterThreshold) || clusterThreshold <= 0 || clusterThreshold > 1 ? DEFAULT_HYBRID_CONFIG.clusterThreshold : clusterThreshold,
    geoRadiusKm: isNaN(geoRadiusKm) || geoRadiusKm <= 0 ? DEFAULT_HYBRID_CONFIG.geoRadiusKm : geoRadiusKm,
    temporalDecayDays: isNaN(temporalDecayDays) || temporalDecayDays <= 0 ? DEFAULT_HYBRID_CONFIG.temporalDecayDays : temporalDecayDays,
    minSemanticSimilarity: isNaN(minSemanticSimilarity) || minSemanticSimilarity < 0 || minSemanticSimilarity > 1 ? DEFAULT_HYBRID_CONFIG.minSemanticSimilarity : minSemanticSimilarity,
  };
};

// ── Geographic Proximity (Haversine Formula) ─────────────────────────────────

const EARTH_RADIUS_KM = 6371.0;

const toRadians = (degrees: number): number => (degrees * Math.PI) / 180.0;

/**
 * Validates latitude and longitude coordinates.
 */
export const isValidCoordinate = (lat: unknown, lng: unknown): boolean => {
  if (lat == null || lng == null) return false;
  const numLat = typeof lat === 'string' ? parseFloat(lat) : Number(lat);
  const numLng = typeof lng === 'string' ? parseFloat(lng) : Number(lng);
  if (isNaN(numLat) || isNaN(numLng)) return false;
  return numLat >= -90 && numLat <= 90 && numLng >= -180 && numLng <= 180;
};

/**
 * Calculates great-circle distance between two GPS coordinates using the Haversine formula.
 * Returns distance in kilometers, or null if coordinates are missing/invalid.
 */
export const haversineDistanceKm = (
  lat1: number | null | undefined,
  lng1: number | null | undefined,
  lat2: number | null | undefined,
  lng2: number | null | undefined
): number | null => {
  if (!isValidCoordinate(lat1, lng1) || !isValidCoordinate(lat2, lng2)) {
    return null;
  }

  const nLat1 = Number(lat1);
  const nLng1 = Number(lng1);
  const nLat2 = Number(lat2);
  const nLng2 = Number(lng2);

  const dLat = toRadians(nLat2 - nLat1);
  const dLng = toRadians(nLng2 - nLng1);

  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRadians(nLat1)) * Math.cos(toRadians(nLat2)) *
    Math.sin(dLng / 2) * Math.sin(dLng / 2);

  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return EARTH_RADIUS_KM * c;
};

/**
 * Calculates normalized geographic proximity between 0.0 and 1.0.
 *
 * - Distance = 0 km  -> Proximity = 1.0
 * - Distance >= radiusKm -> Proximity = 0.0
 * - Proximity decays linearly within radiusKm: 1 - (distance / radiusKm)
 * - Missing or invalid coordinates -> returns neutral default 0.5 (safe fallback)
 */
export const calculateGeoProximity = (
  lat1?: number | null,
  lng1?: number | null,
  lat2?: number | null,
  lng2?: number | null,
  maxRadiusKm = DEFAULT_HYBRID_CONFIG.geoRadiusKm
): { distanceKm: number | null; proximity: number } => {
  const dist = haversineDistanceKm(lat1, lng1, lat2, lng2);

  if (dist === null) {
    // Missing or invalid GPS: return neutral score (0.5) so clustering neither
    // assumes exact co-location nor complete isolation.
    return { distanceKm: null, proximity: 0.5 };
  }

  if (dist <= 0) {
    return { distanceKm: 0, proximity: 1.0 };
  }

  if (dist >= maxRadiusKm) {
    return { distanceKm: dist, proximity: 0.0 };
  }

  const proximity = Math.max(0.0, Math.min(1.0, 1.0 - (dist / maxRadiusKm)));
  return { distanceKm: dist, proximity };
};

// ── Temporal Relevance (Exponential Time Decay) ──────────────────────────────

/**
 * Calculates normalized temporal relevance between 0.0 and 1.0 based on elapsed time.
 *
 * Uses exponential time decay: relevance = exp(- (daysDiff / decayDays))
 *
 * - Days diff = 0 -> Relevance = 1.0 (brand new / concurrent)
 * - Days diff = decayDays (e.g. 30 days) -> Relevance = exp(-1) ≈ 0.368
 * - Days diff = 60 days -> Relevance = exp(-2) ≈ 0.135
 * - Missing/invalid timestamps -> returns 1.0 (neutral recent default)
 */
export const calculateTemporalRelevance = (
  complaintTime?: Date | string | number | null,
  clusterTime?: Date | string | number | null,
  decayDays = DEFAULT_HYBRID_CONFIG.temporalDecayDays
): { daysDiff: number; relevance: number } => {
  if (!complaintTime || !clusterTime) {
    return { daysDiff: 0, relevance: 1.0 };
  }

  const tComplaint = new Date(complaintTime).getTime();
  const tCluster = new Date(clusterTime).getTime();

  if (isNaN(tComplaint) || isNaN(tCluster)) {
    return { daysDiff: 0, relevance: 1.0 };
  }

  const diffMs = Math.abs(tComplaint - tCluster);
  const daysDiff = diffMs / (1000 * 60 * 60 * 24);

  if (daysDiff <= 0) {
    return { daysDiff: 0, relevance: 1.0 };
  }

  // Exponential decay clamped to [0, 1]
  const relevance = Math.max(0.0, Math.min(1.0, Math.exp(-daysDiff / decayDays)));
  return { daysDiff, relevance };
};

// ── Hybrid Score Combination ─────────────────────────────────────────────────

export interface HybridScoreResult {
  hybridScore: number;
  semanticSimilarity: number;
  geographicProximity: number;
  temporalRelevance: number;
  distanceKm: number | null;
  daysDiff: number;
  meetsSemanticGuardrail: boolean;
}

/**
 * Computes the unified hybrid score combining semantic, geographic, and temporal signals.
 *
 * hybridScore = (semanticSimilarity * w_sem) + (geographicProximity * w_geo) + (temporalRelevance * w_temp)
 *
 * All components are strictly normalized between 0.0 and 1.0.
 * Output is guaranteed to be within [0.0, 1.0].
 */
export const computeHybridScore = (
  semanticSimilarity: number,
  geoProximity: number,
  temporalRelevance: number,
  config: HybridClusteringConfig = getHybridConfig()
): number => {
  const normSemantic = Math.max(0.0, Math.min(1.0, isNaN(semanticSimilarity) ? 0 : semanticSimilarity));
  const normGeo = Math.max(0.0, Math.min(1.0, isNaN(geoProximity) ? 0.5 : geoProximity));
  const normTemporal = Math.max(0.0, Math.min(1.0, isNaN(temporalRelevance) ? 1.0 : temporalRelevance));

  const score =
    (normSemantic * config.semanticWeight) +
    (normGeo * config.geoWeight) +
    (normTemporal * config.temporalWeight);

  return Math.max(0.0, Math.min(1.0, score));
};

/**
 * Full hybrid evaluation between a complaint and a candidate cluster.
 */
export const evaluateClusterCandidate = (
  semanticSimilarity: number,
  complaintLat: number | null | undefined,
  complaintLng: number | null | undefined,
  complaintCreatedAt: Date | string | null | undefined,
  clusterLat: number | null | undefined,
  clusterLng: number | null | undefined,
  clusterUpdatedAt: Date | string | null | undefined,
  config: HybridClusteringConfig = getHybridConfig()
): HybridScoreResult => {
  const normSemantic = Math.max(0.0, Math.min(1.0, isNaN(semanticSimilarity) ? 0 : semanticSimilarity));
  const { distanceKm, proximity: geoProximity } = calculateGeoProximity(
    complaintLat,
    complaintLng,
    clusterLat,
    clusterLng,
    config.geoRadiusKm
  );

  const { daysDiff, relevance: temporalRelevance } = calculateTemporalRelevance(
    complaintCreatedAt,
    clusterUpdatedAt,
    config.temporalDecayDays
  );

  const meetsSemanticGuardrail = normSemantic >= config.minSemanticSimilarity;

  const hybridScore = computeHybridScore(normSemantic, geoProximity, temporalRelevance, config);

  return {
    hybridScore,
    semanticSimilarity: normSemantic,
    geographicProximity: geoProximity,
    temporalRelevance,
    distanceKm,
    daysDiff,
    meetsSemanticGuardrail,
  };
};

// ── Weighted Running Centroid Calculation ─────────────────────────────────────

/**
 * Computes updated centroid coordinates using a weighted running average.
 *
 * newCentroid = ((oldCentroid * oldCount) + newCoord) / (oldCount + 1)
 *
 * If either latitude or longitude is missing on the new complaint, returns old centroid.
 * If cluster previously had no coordinates, initializes with new complaint coordinates.
 */
export const calculateUpdatedGeoCentroid = (
  oldLat: number | null | undefined,
  oldLng: number | null | undefined,
  oldCount: number,
  newLat: number | null | undefined,
  newLng: number | null | undefined
): { lat: number | null; lng: number | null } => {
  const newValid = isValidCoordinate(newLat, newLng);
  const oldValid = isValidCoordinate(oldLat, oldLng);

  if (!newValid && !oldValid) {
    return { lat: null, lng: null };
  }

  if (!newValid && oldValid) {
    return { lat: Number(oldLat), lng: Number(oldLng) };
  }

  if (newValid && !oldValid) {
    return { lat: Number(newLat), lng: Number(newLng) };
  }

  // Both valid: compute running average
  const count = Math.max(1, oldCount);
  const updatedLat = (Number(oldLat) * count + Number(newLat)) / (count + 1);
  const updatedLng = (Number(oldLng) * count + Number(newLng)) / (count + 1);

  return {
    lat: parseFloat(updatedLat.toFixed(8)),
    lng: parseFloat(updatedLng.toFixed(8)),
  };
};
