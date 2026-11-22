import dotenv from 'dotenv';
import { z } from 'zod';
import logger from '../utils/logger';

// Load environment variables from the environment/dotenv file
dotenv.config();

const envSchema = z.object({
  PORT: z.coerce.number().default(5000),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  DATABASE_URL: z.string().optional(),
  FRONTEND_URL: z.string().url().default('http://localhost:3000'),
  // Optional Gemini API key — used for LLM recommendations and embeddings
  GEMINI_API_KEY: z.string().optional(),
  GEMINI_MODEL: z.string().default('gemini-2.5-flash'),
  MEDIA_ANALYSIS_MODEL: z.string().default('gemini-2.5-flash'),
  INVESTIGATION_MODEL: z.string().default('gemini-2.5-flash'),
  // Rate limit override — useful in tests to trigger 429 with fewer requests
  RATE_LIMIT_MAX: z.coerce.number().default(100),
  // JWT secret for signing tokens — must be at least 32 characters
  JWT_SECRET: z.string().min(32).optional(),
  // JWT token expiry — e.g. '24h', '7d'
  JWT_EXPIRES_IN: z.string().default('15m'), // Short-lived access token
  JWT_REFRESH_SECRET: z.string().min(32).optional(),
  JWT_REFRESH_EXPIRES_IN: z.string().default('7d'),
  // Media Storage Configuration
  MEDIA_STORAGE_PROVIDER: z.enum(['local', 'r2', 's3', 'imagekit']).default('local'),
  MEDIA_STORAGE_DIR: z.string().default('./uploads'),
  // Cloudflare R2 / S3 Storage Credentials (required when MEDIA_STORAGE_PROVIDER is 'r2' or 's3')
  R2_ACCOUNT_ID: z.string().optional(),
  R2_ACCESS_KEY_ID: z.string().optional(),
  R2_SECRET_ACCESS_KEY: z.string().optional(),
  R2_BUCKET_NAME: z.string().optional(),
  R2_PUBLIC_BASE_URL: z.string().url().optional(),
  // ImageKit Credentials (required when MEDIA_STORAGE_PROVIDER is 'imagekit')
  IMAGEKIT_PUBLIC_KEY: z.string().optional(),
  IMAGEKIT_PRIVATE_KEY: z.string().optional(),
  IMAGEKIT_URL_ENDPOINT: z.string().url().optional(),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  logger.error('❌ Environment validation failed:', JSON.stringify(parsed.error.format(), null, 2));
  process.exit(1);
}

export const env = parsed.data;

// Enforce strict requirement for database connection in production
if (env.NODE_ENV === 'production' && !env.DATABASE_URL) {
  logger.error('❌ Critical Error: DATABASE_URL environment variable is required in production!');
  process.exit(1);
}

if (!env.DATABASE_URL && env.NODE_ENV !== 'test') {
  logger.warn('⚠️ Warning: DATABASE_URL is not configured. Database operations will fail unless resolved.');
}
