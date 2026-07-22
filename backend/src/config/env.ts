import dotenv from 'dotenv';
import { z } from 'zod';

// Load environment variables from the environment/dotenv file
dotenv.config();

const envSchema = z.object({
  PORT: z.coerce.number().default(5000),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  DATABASE_URL: z.string().optional(),
  FRONTEND_URL: z.string().url().default('http://localhost:3000'),
  // Optional Gemini API key — used for LLM recommendations and embeddings
  GEMINI_API_KEY: z.string().optional(),
  // Rate limit override — useful in tests to trigger 429 with fewer requests
  RATE_LIMIT_MAX: z.coerce.number().default(100),
  // JWT secret for signing tokens — must be at least 32 characters
  JWT_SECRET: z.string().min(32).optional(),
  // JWT token expiry — e.g. '24h', '7d'
  JWT_EXPIRES_IN: z.string().default('24h'),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error('❌ Environment validation failed:', JSON.stringify(parsed.error.format(), null, 2));
  process.exit(1);
}

export const env = parsed.data;

// Enforce strict requirement for database connection in production
if (env.NODE_ENV === 'production' && !env.DATABASE_URL) {
  console.error('❌ Critical Error: DATABASE_URL environment variable is required in production!');
  process.exit(1);
}

if (!env.DATABASE_URL && env.NODE_ENV !== 'test') {
  console.warn('⚠️ Warning: DATABASE_URL is not configured. Database operations will fail unless resolved.');
}
