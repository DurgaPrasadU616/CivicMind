// backend/src/routes/ingest.ts
//
// Admin-only endpoints for triggering data ingestion pipelines.
// POST /api/ingest/news    — fetches real RSS feeds, filters, clusters
// POST /api/ingest/social  — ingests simulated social media mock data
//
// ── Scheduled execution (not built yet) ─────────────────────────────────────
// To run ingestion on a schedule (e.g. every 6 hours), add a GitHub Actions
// cron workflow that sends a POST to these endpoints with a Bearer token:
//
//   .github/workflows/ingest-news.yml
//   ──────────────────────────────────
//   name: Ingest News RSS
//   on:
//     schedule:
//       - cron: '0 */6 * * *'   # every 6 hours
//     workflow_dispatch:          # manual trigger
//   jobs:
//     ingest:
//       runs-on: ubuntu-latest
//       steps:
//         - name: Trigger news ingestion
//           run: |
//             curl -X POST "$BACKEND_URL/api/ingest/news" \
//              -H "Authorization: Bearer $INGEST_TOKEN" \
//              -H "Content-Type: application/json"

import { Router } from 'express';
import { authenticateToken, requireRole } from '../middleware/auth';
import { ingestNewsFeeds } from '../services/ingestion/newsIngestion';
import { ingestSocialMediaPosts } from '../services/ingestion/socialIngestion';

const router = Router();

// POST /api/ingest/news — Trigger news RSS ingestion (admin/ngo only)
router.post('/ingest/news', authenticateToken, requireRole('admin', 'govt', 'ngo'), async (_req, res) => {
  try {
    const result = await ingestNewsFeeds();
    return res.status(200).json({
      message: 'News RSS ingestion complete',
      data: result,
    });
  } catch (error: any) {
    console.error('[INGEST] News ingestion route error:', error);
    return res.status(500).json({
      error: 'News ingestion failed',
      details: error.message,
    });
  }
});

// POST /api/ingest/social — Trigger simulated social media ingestion (admin/ngo only)
router.post('/ingest/social', authenticateToken, requireRole('admin', 'govt', 'ngo'), async (_req, res) => {
  try {
    const result = await ingestSocialMediaPosts();
    return res.status(200).json({
      message: 'Social media ingestion complete',
      data: result,
    });
  } catch (error: any) {
    console.error('[INGEST] Social ingestion route error:', error);
    return res.status(500).json({
      error: 'Social media ingestion failed',
      details: error.message,
    });
  }
});

export default router;
