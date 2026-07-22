// backend/src/routes/ingest.ts
//
// Admin/Automation endpoints for triggering data ingestion pipelines
// and inspecting ingestion run logs.

import { Router } from 'express';
import { authenticateToken, requireRole } from '../middleware/auth';
import { ingestNewsFeeds } from '../services/ingestion/newsIngestion';
import { ingestSocialMediaPosts } from '../services/ingestion/socialIngestion';
import { getIngestionLogs } from '../services/ingestion/ingestionLogService';

const router = Router();

// POST /api/ingest/news — Trigger news RSS ingestion (admin, govt, ngo, service_account)
router.post('/ingest/news', authenticateToken, requireRole('admin', 'govt', 'ngo', 'service_account'), async (_req, res) => {
  try {
    const result = await ingestNewsFeeds();
    const statusCode = result.status === 'failed' ? 500 : 200;
    return res.status(statusCode).json({
      message: result.status === 'failed' ? 'News ingestion failed' : 'News RSS ingestion complete',
      status: result.status,
      data: result,
    });
  } catch (error: any) {
    console.error('[INGEST] News ingestion route error:', error);
    return res.status(500).json({
      status: 'failed',
      error: 'News ingestion failed',
      details: error.message,
    });
  }
});

// POST /api/ingest/social — Trigger simulated social media ingestion (admin, govt, ngo, service_account)
router.post('/ingest/social', authenticateToken, requireRole('admin', 'govt', 'ngo', 'service_account'), async (_req, res) => {
  try {
    const result = await ingestSocialMediaPosts();
    const statusCode = result.status === 'failed' ? 500 : 200;
    return res.status(statusCode).json({
      message: result.status === 'failed' ? 'Social ingestion failed' : 'Social media ingestion complete',
      status: result.status,
      data: result,
    });
  } catch (error: any) {
    console.error('[INGEST] Social ingestion route error:', error);
    return res.status(500).json({
      status: 'failed',
      error: 'Social media ingestion failed',
      details: error.message,
    });
  }
});

// GET /api/ingestion/log — Fetch paginated ingestion logs (admin & govt only)
const handleGetIngestionLog = async (req: any, res: any) => {
  try {
    const page = Math.max(1, parseInt(req.query.page as string, 10) || 1);
    const limit = Math.max(1, Math.min(100, parseInt(req.query.limit as string, 10) || 10));
    const offset = (page - 1) * limit;

    const { logs, total } = await getIngestionLogs(limit, offset);

    return res.status(200).json({
      logs,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    });
  } catch (error: any) {
    console.error('[INGEST] Get ingestion log error:', error);
    return res.status(500).json({
      error: 'Failed to retrieve ingestion logs',
      details: error.message,
    });
  }
};

router.get('/ingestion/log', authenticateToken, requireRole('admin', 'govt'), handleGetIngestionLog);
router.get('/ingest/log', authenticateToken, requireRole('admin', 'govt'), handleGetIngestionLog);

export default router;
