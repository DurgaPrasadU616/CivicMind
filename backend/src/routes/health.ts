import { Router } from 'express';
import { checkDbConnection } from '../config/db';

const router = Router();

router.get('/health', async (req, res) => {
  const isDbConnected = await checkDbConnection();

  const healthStatus = {
    status: isDbConnected ? 'UP' : 'DEGRADED',
    timestamp: new Date().toISOString(),
    services: {
      server: 'UP',
      database: isDbConnected ? 'connected' : 'disconnected',
    },
  };

  // If the database is not connected, return 503 Service Unavailable (degraded mode)
  if (!isDbConnected) {
    return res.status(503).json(healthStatus);
  }

  return res.status(200).json(healthStatus);
});

export default router;
