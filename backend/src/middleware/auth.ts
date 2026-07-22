// backend/src/middleware/auth.ts
//
// JWT authentication middleware and role-based access control.
//
// authenticateToken: verifies Bearer token, attaches decoded user to req.user
// requireRole:       factory that returns middleware restricting by role

import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { env } from '../config/env';

export interface JwtPayload {
  id: number;
  role: 'citizen' | 'ngo' | 'govt' | 'admin';
}

// Extend Express Request to include the decoded user
declare global {
  namespace Express {
    interface Request {
      user?: JwtPayload;
    }
  }
}

export const authenticateToken = (req: Request, res: Response, next: NextFunction): void => {
  const authHeader = req.headers['authorization'];

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    res.status(401).json({ error: 'No token provided. Please log in.' });
    return;
  }

  const token = authHeader.slice(7); // strip "Bearer "

  try {
    const decoded = jwt.verify(token, env.JWT_SECRET!) as JwtPayload;
    req.user = decoded;
    next();
  } catch (err: any) {
    if (err.name === 'TokenExpiredError') {
      res.status(401).json({ error: 'Token expired. Please log in again.' });
      return;
    }
    res.status(401).json({ error: 'Invalid token.' });
  }
};

export const requireRole = (...roles: string[]) => {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.user) {
      res.status(401).json({ error: 'No token provided. Please log in.' });
      return;
    }

    if (!roles.includes(req.user.role)) {
      res.status(403).json({
        error: `Insufficient permissions. Required role: ${roles.join(' or ')}.`,
      });
      return;
    }

    next();
  };
};
