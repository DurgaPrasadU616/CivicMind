import { Pool } from 'pg';
import { env } from './env';

const isProduction = env.NODE_ENV === 'production';

// Configuration for database connection
const poolConfig = {
  connectionString: env.DATABASE_URL,
  ssl: isProduction
    ? {
        rejectUnauthorized: false, // Required for typical hosting platforms like Render, Heroku, Railway
      }
    : false,
};

// Instantiation of PG Pool.
// If DATABASE_URL is missing (e.g. in test env), we do not supply config to prevent instant throw.
export const pool = new Pool(env.DATABASE_URL ? poolConfig : {});

// Helper to check connection health
export const checkDbConnection = async (): Promise<boolean> => {
  if (!env.DATABASE_URL) {
    return false;
  }
  try {
    const client = await pool.connect();
    client.release();
    return true;
  } catch (error) {
    console.error('❌ Database connection error:', error);
    return false;
  }
};
