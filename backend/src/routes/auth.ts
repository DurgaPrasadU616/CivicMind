// backend/src/routes/auth.ts
//
// POST /api/auth/register — create a new user account
// POST /api/auth/login    — validate credentials, return JWT

import { Router } from 'express';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import { pool } from '../config/db';
import { env } from '../config/env';
import { registerSchema, loginSchema } from '../validators/auth';

const router = Router();

const BCRYPT_ROUNDS = 12;

// POST /api/auth/register
router.post('/auth/register', async (req, res) => {
  try {
    const result = registerSchema.safeParse(req.body);
    if (!result.success) {
      return res.status(400).json({
        error: 'Validation failed',
        details: result.error.errors.map((e) => ({
          path: e.path.join('.'),
          message: e.message,
        })),
      });
    }

    const { name, email, password, role } = result.data;

    if (!pool) {
      return res.status(503).json({ error: 'Database service is unavailable.' });
    }

    // Check for duplicate email
    const existing = await pool.query('SELECT id FROM "user" WHERE email = $1', [email]);
    if (existing.rows.length > 0) {
      return res.status(409).json({ error: 'An account with this email already exists.' });
    }

    const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);

    const insertResult = await pool.query(
      `INSERT INTO "user" (name, email, password_hash, role)
       VALUES ($1, $2, $3, $4)
       RETURNING id, name, email, role, created_at`,
      [name, email, passwordHash, role]
    );

    const user = insertResult.rows[0];

    return res.status(201).json({
      message: 'Account created successfully.',
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        role: user.role,
      },
    });
  } catch (error) {
    console.error('Error during registration:', error);
    return res.status(500).json({ error: 'An internal server error occurred during registration.' });
  }
});

// POST /api/auth/login
router.post('/auth/login', async (req, res) => {
  try {
    const result = loginSchema.safeParse(req.body);
    if (!result.success) {
      return res.status(400).json({
        error: 'Validation failed',
        details: result.error.errors.map((e) => ({
          path: e.path.join('.'),
          message: e.message,
        })),
      });
    }

    const { email, password } = result.data;

    if (!pool) {
      return res.status(503).json({ error: 'Database service is unavailable.' });
    }

    const userResult = await pool.query(
      'SELECT id, name, email, password_hash, role FROM "user" WHERE email = $1',
      [email]
    );

    // Deliberately vague error — don't leak whether email or password was wrong
    const INVALID_CREDS = 'Invalid credentials.';

    if (userResult.rows.length === 0) {
      // Run a dummy bcrypt compare to prevent timing attacks
      await bcrypt.compare(password, '$2b$12$invalidhashpadding000000000000000000000000000000000000');
      return res.status(401).json({ error: INVALID_CREDS });
    }

    const user = userResult.rows[0];
    const passwordMatch = await bcrypt.compare(password, user.password_hash);

    if (!passwordMatch) {
      return res.status(401).json({ error: INVALID_CREDS });
    }

    const payload = { id: user.id, role: user.role };
    const token = jwt.sign(payload, env.JWT_SECRET!, {
      expiresIn: env.JWT_EXPIRES_IN as any,
    });

    return res.status(200).json({
      message: 'Login successful.',
      token,
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        role: user.role,
      },
    });
  } catch (error) {
    console.error('Error during login:', error);
    return res.status(500).json({ error: 'An internal server error occurred during login.' });
  }
});

export default router;
