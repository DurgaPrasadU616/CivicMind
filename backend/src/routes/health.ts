import { Router } from 'express';
import { checkDbConnection } from '../config/db';
import redisClient from '../utils/cache';

const router = Router();

router.get('/health', async (req, res) => {
  const isDbConnected = await checkDbConnection();
  
  let isRedisConnected = false;
  try {
    const pingRes = await redisClient.ping();
    isRedisConnected = pingRes === 'PONG';
  } catch (err) {
    isRedisConnected = false;
  }

  const healthStatus = {
    status: isDbConnected && isRedisConnected ? 'UP' : 'DEGRADED',
    timestamp: new Date().toISOString(),
    services: {
      server: 'UP',
      database: isDbConnected ? 'connected' : 'disconnected',
      redis: isRedisConnected ? 'connected' : 'disconnected',
    },
  };

  // If the database or redis is not connected, return 503 Service Unavailable (degraded mode)
  if (!isDbConnected || !isRedisConnected) {
    return res.status(503).json(healthStatus);
  }

  return res.status(200).json(healthStatus);
});

export default router;
