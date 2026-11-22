// backend/src/middleware/rbac.ts

import { Request, Response, NextFunction } from 'express';
import { JwtPayload } from './auth';

export type Permission =
  | 'read:complaints'
  | 'write:complaints'
  | 'update:status'
  | 'read:audit_logs'
  | 'read:reports'
  | 'write:reports'
  | 'manage:users'
  | 'read:analytics'
  | 'assign:officer';

export type Role = JwtPayload['role'];

// Enterprise RBAC Matrix
const rolePermissions: Record<Role, Permission[]> = {
  citizen: ['read:complaints', 'write:complaints'],
  ngo: ['read:complaints', 'write:complaints', 'update:status'],
  govt: [
    'read:complaints',
    'write:complaints',
    'update:status',
    'read:audit_logs',
    'read:analytics',
    'read:reports',
    'assign:officer',
  ],
  admin: [
    'read:complaints',
    'write:complaints',
    'update:status',
    'read:audit_logs',
    'read:analytics',
    'read:reports',
    'write:reports',
    'manage:users',
    'assign:officer',
  ],
  service_account: ['read:complaints', 'write:complaints', 'update:status'],
};

export const requirePermission = (permission: Permission) => {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.user) {
      res.status(401).json({ error: 'No token provided. Please log in.' });
      return;
    }

    const permissions = rolePermissions[req.user.role] || [];

    if (!permissions.includes(permission)) {
      res.status(403).json({
        error: `Insufficient permissions. Missing required permission: ${permission}.`,
      });
      return;
    }

    next();
  };
};
