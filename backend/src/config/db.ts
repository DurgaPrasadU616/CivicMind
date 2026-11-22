import { Pool, PoolConfig } from 'pg';
import { env } from './env';
import logger from '../utils/logger';

const isProduction = env.NODE_ENV === 'production';
const isTest = env.NODE_ENV === 'test';

// ── Serverless Connection Pool Configuration ──────────────────────────────────
//
// Vercel Serverless Functions run as individual AWS Lambda containers that are
// created on demand and frozen immediately after the HTTP response is sent.
// Each container holds its own pg.Pool instance for the duration it stays warm.
//
// Key considerations for serverless environments:
//
//   max: 2
//     Caps the number of PostgreSQL connections per warm serverless instance.
//     Vercel can run many concurrent instances, each holding up to 2 connections.
//     Combined with Neon's connection pooler (PgBouncer), this safely scales
//     to hundreds of concurrent requests without exhausting database limits.
//     For local development (max: 10) a larger pool avoids unnecessary waits
//     when running test suites in parallel.
//
//   idleTimeoutMillis: 10_000
//     Closes connections that have been idle for 10 seconds. In serverless
//     environments, containers can be frozen with open connections for minutes;
//     a short idle timeout ensures stale connections are released promptly
//     rather than sitting open against Neon's connection limit.
//     Matching Neon's own idle-connection timeout avoids server-side closed
//     connections being returned from the pool on the next request.
//
//   connectionTimeoutMillis: 5_000
//     If a free connection is not available within 5 seconds (all slots in use),
//     the query throws an error immediately rather than queuing indefinitely.
//     This prevents cascading hangs under burst traffic and surfaces back-
//     pressure errors that can be caught and retried by the caller.
//
//   allowExitOnIdle: true (production / serverless only)
//     Allows the Node.js process to exit when the pool has no active connections.
//     Without this, an idle pool's keep-alive timer prevents the Lambda handler
//     from completing cleanly, causing artificial function duration charges.
//
//   TLS / SSL configuration:
//     In production: TLS is enforced with full server-certificate validation
//     (rejectUnauthorized: true). Neon's certificates are signed by DigiCert
//     Global Root CA G2, trusted by Node.js's bundled CA store (v18+).
//     In development/test: TLS is disabled for local Postgres connections.
//
// IMPORTANT — Neon Connection Pooler:
//   For Vercel production deployments, DATABASE_URL should point to Neon's
//   PgBouncer pooler endpoint (hostname suffix "-pooler"):
//     e.g. ep-long-wind-aweyvv9d-pooler.c-2.neon.tech
//   The pooler multiplexes serverless connections in transaction-pooling mode,
//   allowing hundreds of concurrent Lambda invocations to share a small set of
//   actual PostgreSQL backend connections efficiently.
//
// ─────────────────────────────────────────────────────────────────────────────

const poolConfig: PoolConfig = {
  connectionString: env.DATABASE_URL,

  // Serverless-optimized pool size: small per-instance cap, large for local dev
  max: isTest ? 1 : isProduction ? 2 : 10,

  // Release idle connections quickly so serverless containers don't hold
  // open PostgreSQL connections after their last request finishes.
  idleTimeoutMillis: isProduction ? 10_000 : 30_000,

  // Fail fast if the pool is exhausted under burst traffic rather than queuing.
  connectionTimeoutMillis: 5_000,

  // Allow the event loop to exit when the pool is idle (critical for serverless
  // runtimes where a dangling timer prevents the Lambda from completing).
  allowExitOnIdle: isProduction,

  ssl: isProduction
    ? {
        // Neon presents certificates signed by DigiCert Global Root CA G2, which
        // is included in Node.js's bundled CA store (all versions ≥ 18). Full
        // server-certificate validation is therefore safe and correct — there is
        // no need to disable chain validation.
        //
        // NOTE — sslmode=require vs. pg ssl config object:
        //   The DATABASE_URL connection string may include ?sslmode=require.
        //   In pg ≥ 8.x, an explicit `ssl` object in the PoolConfig takes
        //   precedence over the connection-string sslmode parameter, so
        //   rejectUnauthorized: true here correctly enforces full validation
        //   regardless of the sslmode value in the URL.
        //
        // If a future environment genuinely cannot validate Neon's cert chain
        // (e.g. a custom internal CA), set NODE_EXTRA_CA_CERTS to the PEM path
        // rather than disabling rejectUnauthorized.
        rejectUnauthorized: true,
      }
    : false,
};

// ── Pool Singleton ────────────────────────────────────────────────────────────
//
// A single Pool instance is created at module load time and shared across all
// requests within a warm serverless container. This avoids the overhead of
// opening new TCP connections on every request.
//
// When DATABASE_URL is absent (test environment with mocked pool), we create a
// Pool without config to avoid an immediate connection error on import.
//
export const pool = new Pool(env.DATABASE_URL ? poolConfig : {});

// ── Global Pool Error Handler ─────────────────────────────────────────────────
//
// Errors emitted on idle clients (e.g. the server closed the connection while
// the client was waiting) are caught here to prevent unhandled 'error' events
// from crashing the process. The client is automatically removed from the pool
// by pg after emitting this event.
//
pool.on('error', (err) => {
  logger.error('[DB_POOL] Unexpected error on idle client:', err.message);
});

// Log pool creation details in non-test environments for operational visibility.
if (!isTest && env.DATABASE_URL) {
  logger.info(
    `[DB_POOL] PostgreSQL connection pool initialised — ` +
      `max=${poolConfig.max}, idleTimeout=${poolConfig.idleTimeoutMillis}ms, ` +
      `connectTimeout=${poolConfig.connectionTimeoutMillis}ms, ` +
      `allowExitOnIdle=${poolConfig.allowExitOnIdle}, ssl=${isProduction}`
  );
}

// ── Connection Health Check ───────────────────────────────────────────────────
//
// Acquires a client from the pool, runs a no-op round-trip, then releases it.
// Used by GET /health to surface database connectivity to ops dashboards.
//
export const checkDbConnection = async (): Promise<boolean> => {
  if (!env.DATABASE_URL) {
    return false;
  }
  try {
    const client = await pool.connect();
    client.release();
    return true;
  } catch (error) {
    logger.error('❌ Database connection error:', error);
    return false;
  }
};
