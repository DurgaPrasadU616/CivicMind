import { Router } from 'express';
import { pool } from '../config/db';
import { env } from '../config/env';
import { createComplaintSchema } from '../validators/complaint';
import { clusterComplaint } from '../services/clustering';
import { updateClusterPriorityScore } from '../services/ranking';
import { authenticateToken, requireRole } from '../middleware/auth';
import rateLimit from 'express-rate-limit';

const router = Router();

// Rate limiter for complaints submission.
// max defaults to 100 per 15 min per IP; RATE_LIMIT_MAX env var overrides (useful in tests).
const submitLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: env.RATE_LIMIT_MAX,
  message: {
    error: 'Too many complaint submissions from this IP. Please try again later.',
  },
  standardHeaders: true,
  legacyHeaders: false,
});

// Helper: Determine Region based on GPS Coordinates
const getRegionFromCoords = (lat: number, lng: number): 'Downtown' | 'North' | 'South' | 'East' | 'West' => {
  if (lat > 12.975) return 'North';
  if (lat < 12.960) return 'South';
  if (lng > 77.610) return 'East';
  if (lng < 77.580) return 'West';
  return 'Downtown';
};

// POST /api/complaints: Submit a new complaint, generate embedding, cluster, and recalculate severity
router.post('/complaints', submitLimiter, async (req, res) => {
  try {
    // 1. Validate payload
    const result = createComplaintSchema.safeParse(req.body);
    if (!result.success) {
      return res.status(400).json({
        error: 'Validation failed',
        details: result.error.errors.map((err) => ({
          path: err.path.join('.'),
          message: err.message,
        })),
      });
    }

    const { text, category, latitude, longitude, idempotencyKey, metaData } = result.data;

    // 2. Safeguard database query calls if pool is unconfigured or errors out
    if (!pool) {
      return res.status(503).json({ error: 'Database service is unavailable.' });
    }

    // 3. Idempotency check: if key already exists, return the existing row (idempotent result)
    const existingComplaint = await pool.query(
      'SELECT id, category, text, latitude, longitude, status, created_at, cluster_id FROM complaint WHERE idempotency_key = $1',
      [idempotencyKey]
    );

    if (existingComplaint.rows && existingComplaint.rows.length > 0) {
      return res.status(200).json({
        message: 'Complaint retrieved (idempotency key matched)',
        data: existingComplaint.rows[0],
      });
    }

    // 4. Double-submit/rapid-spam check: check if the exact text & category were submitted in the last minute
    const duplicateCheck = await pool.query(
      `SELECT id FROM complaint 
       WHERE text = $1 AND category = $2 AND created_at > NOW() - INTERVAL '1 minute'`,
      [text, category]
    );

    if (duplicateCheck.rows && duplicateCheck.rows.length > 0) {
      return res.status(409).json({
        error: 'Duplicate submission detected. You recently submitted this exact complaint.',
      });
    }

    // 5. Look up default 'citizen_portal' source ID
    const sourceResult = await pool.query('SELECT id FROM source WHERE name = $1', ['citizen_portal']);
    if (!sourceResult.rows || sourceResult.rows.length === 0) {
      return res.status(500).json({
        error: 'System configuration error: source "citizen_portal" not found in the database.',
      });
    }
    const sourceId = sourceResult.rows[0].id;

    // 6. Insert complaint record
    const insertResult = await pool.query(
      `INSERT INTO complaint (source_id, text, category, latitude, longitude, idempotency_key, meta_data)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id`,
      [
        sourceId,
        text,
        category,
        latitude !== undefined ? latitude : null,
        longitude !== undefined ? longitude : null,
        idempotencyKey,
        JSON.stringify(metaData || {}),
      ]
    );

    const insertedId = insertResult.rows[0].id;

    // 7. Invoke vector clustering and severity scoring calculations
    const assignedClusterId = await clusterComplaint(insertedId);

    // 8. Fetch the fully mapped complaint to return
    const selectResult = await pool.query(
      `SELECT id, category, text, latitude, longitude, status, created_at, cluster_id FROM complaint WHERE id = $1`,
      [insertedId]
    );

    return res.status(201).json({
      message: 'Complaint submitted and clustered successfully',
      data: selectResult.rows[0],
      clusterId: `CL-${assignedClusterId}`,
    });
  } catch (error) {
    console.error('Error handling complaint submission:', error);
    return res.status(500).json({
      error: 'An internal server error occurred while processing the complaint.',
    });
  }
});

// GET /api/complaints/:id: Fetch details of a specific complaint
router.get('/complaints/:id', async (req, res) => {
  try {
    const rawId = req.params.id;
    if (!pool) {
      return res.status(503).json({ error: 'Database service is unavailable.' });
    }

    // Parse "CM-[integer]" format or raw integer
    let numericId = parseInt(rawId.startsWith('CM-') ? rawId.slice(3) : rawId, 10);

    if (isNaN(numericId)) {
      return res.status(400).json({
        error: 'Invalid complaint ID format. ID must be an integer or prefixed (e.g. CM-1001).',
      });
    }

    const queryResult = await pool.query(
      `SELECT c.id, c.text, c.category, c.latitude, c.longitude, c.status, c.created_at, c.cluster_id, s.name as source_name 
       FROM complaint c 
       JOIN source s ON c.source_id = s.id 
       WHERE c.id = $1`,
      [numericId]
    );

    if (queryResult.rows.length === 0) {
      return res.status(404).json({ error: `Complaint with Reference ID "${rawId}" not found.` });
    }

    const complaint = queryResult.rows[0];

    return res.status(200).json({
      data: {
        ...complaint,
        latitude: complaint.latitude ? parseFloat(complaint.latitude) : null,
        longitude: complaint.longitude ? parseFloat(complaint.longitude) : null,
        clusterId: complaint.cluster_id ? `CL-${complaint.cluster_id}` : null,
      },
    });
  } catch (error) {
    console.error('Error fetching complaint details:', error);
    return res.status(500).json({
      error: 'An internal server error occurred while retrieving complaint status.',
    });
  }
});

// GET /api/clusters: Retrieve persistent clusters from database
router.get('/clusters', async (req, res) => {
  try {
    if (!pool) {
      return res.status(503).json({ error: 'Database service is unavailable.' });
    }

    // Parse query filters
    const { category, region, status, search } = req.query;

    const conditions: string[] = [];
    const params: any[] = [];

    if (category && category !== 'all') {
      params.push(category);
      conditions.push(`cl.category = $${params.length}`);
    }

    if (region && region !== 'all') {
      params.push(region);
      conditions.push(`cl.region = $${params.length}`);
    }

    if (status && status !== 'all') {
      params.push(status);
      conditions.push(`cl.status = $${params.length}`);
    }

    if (search) {
      params.push(`%${search}%`);
      conditions.push(`(cl.title ILIKE $${params.length} OR cl.recommended_action ILIKE $${params.length})`);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    // Advanced SQL Join with dynamic averages, JSON aggregation, latest recommended action,
    // and priority_score. Sorted by priority_score DESC as default (staleness-aware ranking).
    // Tiebreaker 1: affected population (complaint_count DESC)
    // Tiebreaker 2: most recent activity (lastUpdated DESC)
    const query = `
      SELECT 
        cl.id,
        cl.title,
        cl.category,
        cl.region,
        cl.severity_score as severity,
        COALESCE(cl.priority_score, cl.severity_score) as "priorityScore",
        cl.complaint_count as "complaintCount",
        cl.status,
        cl.recommended_action as "recommendedAction",
        COALESCE(AVG(co.latitude), 12.9716) as latitude,
        COALESCE(AVG(co.longitude), 77.5946) as longitude,
        COALESCE(MAX(co.created_at), cl.updated_at) as "lastUpdated",
        COALESCE(
          json_agg(
            json_build_object(
              'id', 'CM-' || co.id,
              'text', co.text,
              'status', co.status,
              'created_at', co.created_at,
              'source_name', COALESCE(s.name, 'unknown')
            )
          ) FILTER (WHERE co.id IS NOT NULL),
          '[]'::json
        ) as complaints,
        la.action_text as "latestActionText",
        la.generated_by as "latestActionGeneratedBy",
        la.status as "latestActionStatus",
        la.generated_at as "latestActionGeneratedAt"
      FROM cluster cl
      LEFT JOIN complaint co ON cl.id = co.cluster_id
      LEFT JOIN source s ON co.source_id = s.id
      LEFT JOIN LATERAL (
        SELECT action_text, generated_by, status, generated_at
        FROM recommended_action
        WHERE cluster_id = cl.id
        ORDER BY generated_at DESC
        LIMIT 1
      ) la ON true
      ${whereClause}
      GROUP BY cl.id, la.action_text, la.generated_by, la.status, la.generated_at
      ORDER BY
        COALESCE(cl.priority_score, cl.severity_score) DESC,
        cl.complaint_count DESC,
        COALESCE(MAX(co.created_at), cl.updated_at) DESC
    `;

    const clustersRes = await pool.query(query, params);

    // Stopgap: asynchronously refresh priority_score for each cluster so staleness/decay
    // is applied even without a dedicated cron job.
    // TODO: Replace with a scheduled cron job that recalculates priority on a fixed interval.
    if (clustersRes.rows.length > 0) {
      setImmediate(() => {
        const refreshPromises = clustersRes.rows.map((row) =>
          updateClusterPriorityScore(
            row.id,
            row.severity != null ? parseInt(row.severity, 10) : 0
          ).catch((err) =>
            console.warn(`[RANKING] Background priority refresh failed for Cluster ${row.id}:`, err)
          )
        );
        Promise.all(refreshPromises).catch(() => {});
      });
    }

    // Map DB numeric outputs to floats/integers
    const mapped = clustersRes.rows.map((row) => ({
      id: `CL-${row.id}`,
      title: row.title,
      category: row.category,
      region: row.region,
      severity: parseInt(row.severity, 10),
      priorityScore: parseInt(row.priorityScore, 10),
      complaintCount: parseInt(row.complaintCount, 10),
      status: row.status,
      recommendedAction: row.recommendedAction,
      latitude: parseFloat(row.latitude),
      longitude: parseFloat(row.longitude),
      lastUpdated: row.lastUpdated,
      complaints: row.complaints,
      latestAction: row.latestActionText
        ? {
            text: row.latestActionText,
            generatedBy: row.latestActionGeneratedBy,
            status: row.latestActionStatus,
            generatedAt: row.latestActionGeneratedAt,
          }
        : null,
    }));

    return res.status(200).json({ data: mapped });
  } catch (error) {
    console.error('Error fetching clusters list:', error);
    return res.status(500).json({
      error: 'An internal server error occurred while retrieving aggregated clusters.',
    });
  }
});

// POST /api/clusters/:id/status: Update status of a cluster and cascade status to complaints
// Requires login + ngo/govt/admin role — citizens are read-only
router.post('/clusters/:id/status', authenticateToken, requireRole('ngo', 'govt', 'admin'), async (req, res) => {
  try {
    const rawClusterId = req.params.id;
    const { status } = req.body;

    if (!pool) {
      return res.status(503).json({ error: 'Database service is unavailable.' });
    }

    if (!['pending', 'in_progress', 'resolved'].includes(status)) {
      return res.status(400).json({ error: 'Invalid status value. Must be pending, in_progress, or resolved.' });
    }

    // Extract numerical ID from "CL-[integer]" prefix
    const numericClusterId = parseInt(rawClusterId.startsWith('CL-') ? rawClusterId.slice(3) : rawClusterId, 10);

    if (isNaN(numericClusterId)) {
      return res.status(400).json({ error: 'Invalid cluster ID format.' });
    }

    // Begin transaction for safety
    await pool.query('BEGIN');

    // 1. Update cluster row
    const clusterUpdate = await pool.query(
      'UPDATE cluster SET status = $1, updated_at = NOW() WHERE id = $2 RETURNING id',
      [status, numericClusterId]
    );

    if (clusterUpdate.rows.length === 0) {
      await pool.query('ROLLBACK');
      return res.status(404).json({ error: `Cluster with ID "${rawClusterId}" not found.` });
    }

    // 2. Update linked complaints status
    await pool.query(
      'UPDATE complaint SET status = $1, updated_at = NOW() WHERE cluster_id = $2',
      [status, numericClusterId]
    );

    await pool.query('COMMIT');

    return res.status(200).json({
      message: `Successfully updated cluster and linked complaints status to ${status}.`,
      clusterId: rawClusterId,
    });
  } catch (error) {
    if (pool) await pool.query('ROLLBACK');
    console.error('Error updating cluster status:', error);
    return res.status(500).json({
      error: 'An internal server error occurred while updating cluster status.',
    });
  }
});

// GET /api/clusters/:id/actions: Retrieve the recommended action history for a cluster
router.get('/clusters/:id/actions', async (req, res) => {
  try {
    const rawId = req.params.id;
    if (!pool) {
      return res.status(503).json({ error: 'Database service is unavailable.' });
    }

    const numericId = parseInt(rawId.startsWith('CL-') ? rawId.slice(3) : rawId, 10);
    if (isNaN(numericId)) {
      return res.status(400).json({ error: 'Invalid cluster ID format.' });
    }

    // Verify cluster exists
    const clusterCheck = await pool.query('SELECT id FROM cluster WHERE id = $1', [numericId]);
    if (clusterCheck.rows.length === 0) {
      return res.status(404).json({ error: `Cluster with ID "${rawId}" not found.` });
    }

    const actionsRes = await pool.query(
      `SELECT id, action_text, generated_by, status, generated_at
       FROM recommended_action
       WHERE cluster_id = $1
       ORDER BY generated_at DESC`,
      [numericId]
    );

    return res.status(200).json({
      clusterId: rawId,
      data: actionsRes.rows,
    });
  } catch (error) {
    console.error('Error fetching cluster actions:', error);
    return res.status(500).json({
      error: 'An internal server error occurred while retrieving cluster actions.',
    });
  }
});

export default router;
