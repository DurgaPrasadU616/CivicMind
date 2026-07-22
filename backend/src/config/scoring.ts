// backend/src/config/scoring.ts

export const scoringConfig = {
  // Cosine similarity threshold above which a complaint merges into a cluster
  // Higher = more strictly grouped; Lower = looser groupings
  CLUSTERING_THRESHOLD: parseFloat(process.env.CLUSTERING_THRESHOLD || '0.70'),

  // Criticality weights for categories: water/power/health > roads > aesthetics
  CATEGORY_WEIGHTS: {
    utility: 2.5,       // Water pipeline burst, power grid failure
    safety: 2.2,        // Open manhole, dark street alleyway
    sanitation: 1.8,    // Overflowing garbage bin
    infrastructure: 1.5,// Potholes, sidewalk damage
    noise: 1.2,         // Loud speakers late hours
    other: 1.0,
  } as Record<string, number>,

  // Formula coefficients for severity components (must sum to 1.0)
  WEIGHTS: {
    volume: 0.25,          // Number of complaints in cluster
    growthRate: 0.25,      // Frequency growth velocity
    affectedPopulation: 0.25, // Extrapolated citizen footprint
    resolutionDelay: 0.25,  // Operational response delay backlog
  },

  // Normalization thresholds and multiplier constants
  MAX_VOLUME_THRESHOLD: 20, // complaint count that yields maximum volume score (100)
  AFFECTED_POPULATION_MULTIPLIER: 15, // estimated count of people affected per complaint
  RESOLUTION_DELAY_MULTIPLIER: 10, // weight per day of average resolution time
  DEFAULT_RESOLUTION_SPEED_DAYS: 3, // baseline fallback when no historical speed exists (cold start)

  // ---------------------------------------------------------------------------
  // PRIORITY SCORE configuration
  // priority_score = severity_score * urgency_decay * resource_cost_factor
  // ---------------------------------------------------------------------------

  // Resource cost factor per category.
  // Represents how relatively expensive/slow this category is to resolve.
  // Higher cost = slightly lower priority multiplier (expensive fixes compete differently
  // for city budget than cheap quick-wins).
  // Range: 0.0 – 1.0+. Values below 1.0 moderate (reduce) priority.
  // All values are tunable — no hardcoded logic.
  RESOURCE_COST_WEIGHTS: {
    utility: 0.70,       // Water/power infra — high cost, long fix time → moderate priority
    safety: 0.85,        // Safety fixes range from cheap (signage) to expensive (lighting)
    infrastructure: 0.80,// Road/sidewalk repairs — moderate cost
    sanitation: 0.90,    // Garbage pickup — relatively low cost
    noise: 1.00,         // Noise complaints — cheapest to address (warnings, enforcement)
    other: 1.00,         // Default
  } as Record<string, number>,

  // Urgency decay: exponential decay curve applied to the time since first report.
  // Formula: decay = max(URGENCY_DECAY_FLOOR, exp(-URGENCY_DECAY_RATE * days))
  // Lower rate = slower decay (issues stay urgent longer).
  URGENCY_DECAY_RATE: parseFloat(process.env.URGENCY_DECAY_RATE || '0.05'),

  // Minimum decay factor — ensures old high-severity clusters never silently vanish.
  // 0.20 means priority never drops below 20% of base severity*cost no matter how old.
  URGENCY_DECAY_FLOOR: parseFloat(process.env.URGENCY_DECAY_FLOOR || '0.20'),
};

