// backend/tests/auth.test.ts
// Tests for /api/auth/register, /api/auth/login, authenticateToken middleware,
// requireRole middleware, and role-gated POST /api/clusters/:id/status.

import request from 'supertest';
import jwt from 'jsonwebtoken';
import app from '../src/index';

// ─── Mock DB pool ────────────────────────────────────────────────────────────
jest.mock('../src/config/db', () => {
  const mPool = { query: jest.fn() };
  return { pool: mPool, checkDbConnection: jest.fn().mockResolvedValue(true) };
});

// ─── Mock bcrypt (speed up tests — no real hashing rounds needed) ─────────────
jest.mock('bcrypt', () => ({
  hash: jest.fn().mockResolvedValue('$2b$12$hashedpassword'),
  compare: jest.fn(),
}));

import { pool } from '../src/config/db';
import bcrypt from 'bcrypt';

const mockPool = pool as unknown as { query: jest.Mock };
const mockBcrypt = bcrypt as unknown as { hash: jest.Mock; compare: jest.Mock };

// Seed JWT_SECRET for tests
process.env.JWT_SECRET = 'civicmind-super-secret-jwt-key-2026-secure';
process.env.JWT_EXPIRES_IN = '24h';

const TEST_USER = {
  id: 1,
  name: 'Test User',
  email: 'test@civicmind.com',
  password_hash: '$2b$12$hashedpassword',
  role: 'govt',
};

const makeToken = (payload: object, expiresIn: any = '24h') =>
  jwt.sign(payload, process.env.JWT_SECRET!, { expiresIn });

// =============================================================================
describe('Auth Routes', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  // ─── POST /api/auth/register ───────────────────────────────────────────────
  describe('POST /api/auth/register', () => {
    it('should register a new user and return 201 with user object (no password)', async () => {
      mockPool.query
        .mockResolvedValueOnce({ rows: [] }) // duplicate email check → none found
        .mockResolvedValueOnce({             // INSERT RETURNING
          rows: [{ id: 1, name: 'Jane Doe', email: 'jane@civicmind.com', role: 'citizen', created_at: new Date() }],
        });

      const res = await request(app)
        .post('/api/auth/register')
        .send({ name: 'Jane Doe', email: 'jane@civicmind.com', password: 'secure123', role: 'citizen' });

      expect(res.status).toBe(201);
      expect(res.body.user).toMatchObject({ name: 'Jane Doe', email: 'jane@civicmind.com', role: 'citizen' });
      expect(res.body.user.password_hash).toBeUndefined();
      expect(res.body.user.password).toBeUndefined();
    });

    it('should return 409 when email already exists', async () => {
      mockPool.query.mockResolvedValueOnce({ rows: [{ id: 1 }] }); // email exists

      const res = await request(app)
        .post('/api/auth/register')
        .send({ name: 'Jane Doe', email: 'duplicate@civicmind.com', password: 'secure123', role: 'citizen' });

      expect(res.status).toBe(409);
      expect(res.body.error).toMatch(/already exists/i);
    });

    it('should return 400 when password is too short (< 8 chars)', async () => {
      const res = await request(app)
        .post('/api/auth/register')
        .send({ name: 'Jane', email: 'jane@civicmind.com', password: 'abc1', role: 'citizen' });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('Validation failed');
      expect(res.body.details.some((d: any) => d.message.includes('8'))).toBe(true);
    });

    it('should return 400 when password has no digit', async () => {
      const res = await request(app)
        .post('/api/auth/register')
        .send({ name: 'Jane', email: 'jane@civicmind.com', password: 'onlyletters', role: 'citizen' });

      expect(res.status).toBe(400);
      expect(res.body.details.some((d: any) => d.message.includes('number'))).toBe(true);
    });

    it('should return 400 when email format is invalid', async () => {
      const res = await request(app)
        .post('/api/auth/register')
        .send({ name: 'Jane', email: 'not-an-email', password: 'secure123', role: 'citizen' });

      expect(res.status).toBe(400);
    });

    it('should return 400 when required fields are missing', async () => {
      const res = await request(app)
        .post('/api/auth/register')
        .send({ email: 'jane@civicmind.com' }); // missing name + password

      expect(res.status).toBe(400);
      expect(res.body.details.length).toBeGreaterThan(0);
    });
  });

  // ─── POST /api/auth/login ──────────────────────────────────────────────────
  describe('POST /api/auth/login', () => {
    it('should return 200 with a JWT token on valid credentials', async () => {
      mockPool.query.mockResolvedValueOnce({ rows: [TEST_USER] });
      mockBcrypt.compare.mockResolvedValueOnce(true);

      const res = await request(app)
        .post('/api/auth/login')
        .send({ email: TEST_USER.email, password: 'correct-password' });

      expect(res.status).toBe(200);
      expect(res.body.token).toBeDefined();
      expect(typeof res.body.token).toBe('string');
      expect(res.body.user).toMatchObject({ id: 1, role: 'govt' });
      expect(res.body.user.password_hash).toBeUndefined();

      // Verify the JWT is valid and contains the expected payload
      const decoded = jwt.verify(res.body.token, process.env.JWT_SECRET!) as any;
      expect(decoded.id).toBe(1);
      expect(decoded.role).toBe('govt');
    });

    it('should return 401 on wrong password (not leaking which field was wrong)', async () => {
      mockPool.query.mockResolvedValueOnce({ rows: [TEST_USER] });
      mockBcrypt.compare.mockResolvedValueOnce(false); // wrong password

      const res = await request(app)
        .post('/api/auth/login')
        .send({ email: TEST_USER.email, password: 'wrong-password' });

      expect(res.status).toBe(401);
      expect(res.body.error).toBe('Invalid credentials.');
    });

    it('should return 401 on nonexistent email (same message as wrong password)', async () => {
      mockPool.query.mockResolvedValueOnce({ rows: [] }); // no user found
      mockBcrypt.compare.mockResolvedValueOnce(false);   // dummy compare (timing protection)

      const res = await request(app)
        .post('/api/auth/login')
        .send({ email: 'nobody@example.com', password: 'doesnt-matter' });

      expect(res.status).toBe(401);
      expect(res.body.error).toBe('Invalid credentials.');
    });

    it('should return 400 when email is missing', async () => {
      const res = await request(app)
        .post('/api/auth/login')
        .send({ password: 'secure123' });

      expect(res.status).toBe(400);
    });
  });

  // ─── authenticateToken middleware ──────────────────────────────────────────
  describe('authenticateToken middleware (via POST /api/clusters/:id/status)', () => {
    const PROTECTED_URL = '/api/clusters/1/status';

    it('should return 401 when Authorization header is missing', async () => {
      const res = await request(app)
        .post(PROTECTED_URL)
        .send({ status: 'in_progress' });

      expect(res.status).toBe(401);
      expect(res.body.error).toMatch(/no token/i);
    });

    it('should return 401 when token is malformed', async () => {
      const res = await request(app)
        .post(PROTECTED_URL)
        .set('Authorization', 'Bearer this.is.not.a.jwt')
        .send({ status: 'in_progress' });

      expect(res.status).toBe(401);
      expect(res.body.error).toMatch(/invalid token/i);
    });

    it('should return 401 with "Token expired" for an expired token', async () => {
      const expiredToken = makeToken({ id: 1, role: 'govt' }, '-1s'); // already expired

      const res = await request(app)
        .post(PROTECTED_URL)
        .set('Authorization', `Bearer ${expiredToken}`)
        .send({ status: 'in_progress' });

      expect(res.status).toBe(401);
      expect(res.body.error).toMatch(/token expired/i);
    });

    it('should pass through with a valid token (reach the route handler)', async () => {
      const validToken = makeToken({ id: 1, role: 'govt' });

      // Mock DB for the route handler itself (not found is fine — just proves middleware passed)
      mockPool.query
        .mockResolvedValueOnce({ rows: [] }); // BEGIN
      mockPool.query.mockResolvedValueOnce({ rows: [] }); // cluster UPDATE returns not found → ROLLBACK

      // We expect 404 (cluster not found) not 401 — proving middleware passed
      const res = await request(app)
        .post(PROTECTED_URL)
        .set('Authorization', `Bearer ${validToken}`)
        .send({ status: 'in_progress' });

      expect([200, 400, 404, 500]).toContain(res.status); // not 401 or 403
    });
  });

  // ─── requireRole middleware ────────────────────────────────────────────────
  describe('requireRole middleware (via POST /api/clusters/:id/status)', () => {
    const PROTECTED_URL = '/api/clusters/1/status';

    it('should return 403 when a citizen tries to update cluster status', async () => {
      const citizenToken = makeToken({ id: 2, role: 'citizen' });

      const res = await request(app)
        .post(PROTECTED_URL)
        .set('Authorization', `Bearer ${citizenToken}`)
        .send({ status: 'in_progress' });

      expect(res.status).toBe(403);
      expect(res.body.error).toMatch(/insufficient permissions/i);
    });

    it('should allow ngo role to reach the route handler (past middleware)', async () => {
      const ngoToken = makeToken({ id: 3, role: 'ngo' });

      mockPool.query
        .mockResolvedValueOnce({ rows: [] }) // BEGIN
        .mockResolvedValueOnce({ rows: [] }); // UPDATE (not found)

      const res = await request(app)
        .post(PROTECTED_URL)
        .set('Authorization', `Bearer ${ngoToken}`)
        .send({ status: 'in_progress' });

      expect([200, 400, 404, 500]).toContain(res.status); // not 401 or 403
    });

    it('should allow admin role to reach the route handler', async () => {
      const adminToken = makeToken({ id: 4, role: 'admin' });

      mockPool.query
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] });

      const res = await request(app)
        .post(PROTECTED_URL)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ status: 'in_progress' });

      expect([200, 400, 404, 500]).toContain(res.status);
    });
  });
});
