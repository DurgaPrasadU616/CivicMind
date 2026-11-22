import { Router } from 'express';
import { authenticateToken } from '../middleware/auth';
import { requirePermission } from '../middleware/rbac';
import { generateCityPredictions } from '../services/predictions';
import logger from '../utils/logger';

const router = Router();

// GET /api/analytics/predictions - Get AI-driven forecasts
router.get('/analytics/predictions', authenticateToken, requirePermission('read:analytics'), async (req, res) => {
  try {
    const predictions = await generateCityPredictions();
    res.status(200).json({ data: predictions });
  } catch (error: any) {
    logger.error('Error in GET /analytics/predictions:', error);
    res.status(500).json({ error: 'Failed to generate predictions.' });
  }
});

export default router;
