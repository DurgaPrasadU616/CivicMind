import { Request, Response, NextFunction } from 'express';
import { logger } from '../config/logger';

export const requestLogger = (req: Request, res: Response, next: NextFunction): void => {
  const start = Date.now();
  const { method, originalUrl, ip } = req;

  res.on('finish', () => {
    const duration = Date.now() - start;
    const { statusCode } = res;

    logger.info(`${method} ${originalUrl} ${statusCode} ${duration}ms`, {
      method,
      url: originalUrl,
      statusCode,
      duration,
      ip,
      userAgent: req.headers['user-agent'] || 'unknown',
    });
  });

  next();
};