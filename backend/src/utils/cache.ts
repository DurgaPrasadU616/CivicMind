import Redis from 'ioredis';
import RedisMock from 'ioredis-mock';
import logger from './logger';
import { Request, Response, NextFunction } from 'express';

const redisUrl = process.env.REDIS_URL;
let redisClient: Redis;

if (redisUrl) {
  redisClient = new Redis(redisUrl, {
    maxRetriesPerRequest: 3,
  });
  redisClient.on('error', (err) => {
    logger.error('Redis connection error:', err);
  });
  redisClient.on('connect', () => {
    logger.info('Connected to Redis');
  });
} else {
  logger.warn('REDIS_URL not provided, falling back to ioredis-mock (in-memory caching)');
  redisClient = new RedisMock() as any;
}

export const cacheSet = async (key: string, value: any, ttlSeconds: number = 300) => {
  try {
    const stringValue = JSON.stringify(value);
    await redisClient.set(key, stringValue, 'EX', ttlSeconds);
  } catch (err) {
    logger.error(`Error setting cache for key ${key}:`, err);
  }
};

export const cacheGet = async <T>(key: string): Promise<T | null> => {
  try {
    const stringValue = await redisClient.get(key);
    if (stringValue) {
      return JSON.parse(stringValue) as T;
    }
  } catch (err) {
    logger.error(`Error getting cache for key ${key}:`, err);
  }
  return null;
};

export const cacheDel = async (key: string) => {
  try {
    await redisClient.del(key);
  } catch (err) {
    logger.error(`Error deleting cache for key ${key}:`, err);
  }
};

/**
 * Simple window rate limiter middleware.
 */
export const rateLimit = (options: { windowMs: number; max: number; keyPrefix?: string; message?: string }) => {
  const { windowMs, max, keyPrefix = 'rl:', message = 'Too many requests, please try again later.' } = options;
  const windowSeconds = Math.ceil(windowMs / 1000);

  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      const identifier = req.ip || req.socket.remoteAddress || 'unknown';
      const key = `${keyPrefix}${identifier}`;

      const current = await redisClient.incr(key);
      if (current === 1) {
        await redisClient.expire(key, windowSeconds);
      }

      if (current > max) {
        res.status(429).json({ error: message });
        return;
      }

      next();
    } catch (err) {
      // Fail open if Redis fails
      logger.error('Rate limiting error:', err);
      next();
    }
  };
};

export default redisClient;
