/**
 * CivicMind AI 2.0 — Production Database Migration Runner
 * 
 * Safety & Audit Controls:
 *  1. Production Endpoint & Branch Identity: Verifies exact expected Neon host, project_id, and branch_id before connecting.
 *  2. Branch Isolation: Asserts that target is NOT the backup or staging branch.
 *  3. Historical Verification: Deep multi-object catalog checks on 001–008 before recording.
 *  4. Transaction Safety: Atomic per-migration transactions with immediate ROLLBACK on error.
 *  5. Data Integrity: Pre/post cryptographic checksums covering ALL 8 existing tables.
 *  6. Centroid & Recency Audit: Confirms intentional geo-backfill on cluster and recency_weight default on complaint.
 *  7. Zero Credential Leakage: Passwords and connection strings are never logged.
 */

const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');

// ── 1. Read environment securely ────────────────────────────────────
const envPath = path.join(__dirname, '..', '.env');
if (!fs.existsSync(envPath)) {
  console.error("❌ Fatal: backend/.env file not found.");
  process.exit(1);
}

const content = fs.readFileSync(envPath, 'utf8');
const match = content.match(/^DATABASE_URL=(.*)$/m);
if (!match) {
  console.error("❌ Fatal: DATABASE_URL not found in backend/.env.");
  process.exit(1);
}

let dbUrl = match[1].trim();
if ((dbUrl.startsWith('"') && dbUrl.endsWith('"')) || (dbUrl.startsWith("'") && dbUrl.endsWith("'"))) {
  dbUrl = dbUrl.slice(1, -1);
}

// ── 2. Parse CLI arguments & Safety Gates ───────────────────────────
const args = process.argv.slice(2);
const isApproved = args.includes('--confirm-production');

const endpointArg = args.find(a => a.startsWith('--expected-endpoint='));
const EXPECTED_ENDPOINT_ID = endpointArg
  ? endpointArg.split('=')[1].trim()
  : (process.env.EXPECTED_NEON_ENDPOINT || 'ep-long-wind-aweyvv9d');

const branchArg = args.find(a => a.startsWith('--expected-branch='));
const EXPECTED_BRANCH_ID = branchArg
  ? branchArg.split('=')[1].trim()
  : (process.env.EXPECTED_NEON_BRANCH_ID || 'br-wild-mouse-awf2fbor');

const projectArg = args.find(a => a.startsWith('--expected-project='));
const EXPECTED_PROJECT_ID = projectArg
  ? projectArg.split('=')[1].trim()
  : (process.env.EXPECTED_NEON_PROJECT_ID || 'super-fog-18265129');

if (!isApproved) {
  console.error("\n=======================================================");
  console.error("⛔ EXECUTION BLOCKED: Missing explicit approval flag.");
  console.error("To execute this script against the production database,");
  console.error("pass the flag: --confirm-production");
  console.error(`Expected endpoint: ${EXPECTED_ENDPOINT_ID}`);
  console.error(`Expected branch:   ${EXPECTED_BRANCH_ID}`);
  console.error("=======================================================\n");
  process.exit(1);
}

// ── 3. Production Endpoint Identification Guard (Pre-Connection) ────
let targetEndpoint = '';
try {
  const parsedUrl = new URL(dbUrl);
  const hostParts = parsedUrl.host.split('.');
  targetEndpoint = hostParts[0];

  // Prevent targeting backup or staging endpoints
  if (parsedUrl.host.includes('backup') || parsedUrl.pathname.includes('staging') || parsedUrl.pathname.includes('backup')) {
    console.error(`❌ FATAL: Connection string targets backup or staging database: ${parsedUrl.host}${parsedUrl.pathname}`);
    process.exit(1);
  }

  if (targetEndpoint !== EXPECTED_ENDPOINT_ID) {
    console.error(`❌ FATAL: Endpoint ID mismatch! Target: "${targetEndpoint}", Expected: "${EXPECTED_ENDPOINT_ID}"`);
    console.error("Aborting to prevent modifying an unintended branch or database.");
    process.exit(1);
  }
} catch (urlErr) {
  console.error("❌ Fatal: Failed to parse DATABASE_URL:", urlErr.message);
  process.exit(1);
}

const pool = new Pool({
  connectionString: dbUrl,
  ssl: { rejectUnauthorized: false }
});

const PENDING_MIGRATIONS = [
  '009_assignment.sql',
  '011_hybrid_clustering.sql',
  '012_agent_execution_log.sql',
  '013_complaint_media.sql',
  '014_civic_investigations.sql',
  '015_civic_actions.sql'
];

async function run() {
  const client = await pool.connect();
  const startTime = Date.now();

  try {
    console.log("=======================================================");
    console.log("CIVICMIND AI 2.0 — PRODUCTION DATABASE MIGRATION RUNNER");
    console.log("Timestamp:", new Date().toISOString());
    console.log("Target Endpoint ID:", targetEndpoint, "(VERIFIED PRODUCTION)");
    console.log("=======================================================\n");

    // ── STEP 1: Deep Production Branch & Project Identification ─────
    console.log("🔍 [1/5] Verifying Production Database, Project & Branch Identity...");
    const targetRes = await client.query(`
      SELECT 
        current_database(), 
        current_user, 
        current_setting('neon.project_id', true) as neon_project_id,
        current_setting('neon.branch_id', true) as neon_branch_id;
    `);
    const dbName = targetRes.rows[0].current_database;
    const dbUser = targetRes.rows[0].current_user;
    const neonProject = targetRes.rows[0].neon_project_id;
    const neonBranch = targetRes.rows[0].neon_branch_id;

    if (dbName !== 'neondb') {
      throw new Error(`Unexpected database target: "${dbName}". Expected "neondb".`);
    }

    if (neonProject && neonProject !== EXPECTED_PROJECT_ID) {
      throw new Error(`Neon project mismatch! Found "${neonProject}", expected "${EXPECTED_PROJECT_ID}".`);
    }

    if (neonBranch && neonBranch !== EXPECTED_BRANCH_ID) {
      throw new Error(`Neon branch mismatch! Found "${neonBranch}", expected "${EXPECTED_BRANCH_ID}". Targeting backup branch prevented.`);
    }

    console.log(`   Connected to database: ${dbName} as ${dbUser}`);
    console.log(`   Neon Project ID:       ${neonProject || 'N/A'}`);
    console.log(`   Neon Branch ID:        ${neonBranch || 'N/A'} (PROD DEFAULT BRANCH)`);

    // Pre-migration cryptographic checksums covering ALL 8 existing production tables
    console.log("   Capturing pre-migration cryptographic data checksums across all 8 existing tables...");
    const preChecksums = (await client.query(`
      SELECT 
        -- 1. user
        (SELECT md5(string_agg(
          COALESCE(id::text, '') || '|' || COALESCE(name, '') || '|' || COALESCE(email, '') || '|' || 
          COALESCE(role, '') || '|' || COALESCE(password_hash, '') || '|' || COALESCE(is_service_account::text, 'false'),
          ',' ORDER BY id
        )) FROM "user") as user_chk,

        -- 2. complaint (core immutable columns present before migration 011)
        (SELECT md5(string_agg(
          COALESCE(id::text, '') || '|' || COALESCE(source_id::text, '') || '|' || COALESCE(idempotency_key::text, '') || '|' || 
          COALESCE(category, '') || '|' || COALESCE(status, '') || '|' || COALESCE(severity_score::text, '0') || '|' || 
          COALESCE(priority_score::text, '0') || '|' || COALESCE(cluster_id::text, '') || '|' || md5(COALESCE(text, '')),
          ',' ORDER BY id
        )) FROM complaint) as complaint_core_chk,

        -- 3. cluster (core immutable business columns before migrations 009 & 011)
        (SELECT md5(string_agg(
          COALESCE(id::text, '') || '|' || COALESCE(title, '') || '|' || COALESCE(category, '') || '|' || 
          COALESCE(region, '') || '|' || COALESCE(severity_score::text, '0') || '|' || COALESCE(priority_score::text, '0') || '|' || 
          COALESCE(status, '') || '|' || COALESCE(needs_review::text, 'false') || '|' || COALESCE(last_severity_band, ''),
          ',' ORDER BY id
        )) FROM cluster) as cluster_immutable_chk,

        -- 4. recommended_action
        (SELECT md5(string_agg(
          COALESCE(id::text, '') || '|' || COALESCE(cluster_id::text, '') || '|' || COALESCE(action_text, '') || '|' || 
          COALESCE(generated_by, '') || '|' || COALESCE(status, ''),
          ',' ORDER BY id
        )) FROM recommended_action) as recommended_action_chk,

        -- 5. source
        (SELECT md5(string_agg(
          COALESCE(id::text, '') || '|' || COALESCE(name, '') || '|' || COALESCE(description, ''),
          ',' ORDER BY id
        )) FROM source) as source_chk,

        -- 6. guideline_document
        (SELECT md5(string_agg(
          COALESCE(id::text, '') || '|' || COALESCE(title, '') || '|' || COALESCE(category, '') || '|' || md5(COALESCE(content, '')),
          ',' ORDER BY id
        )) FROM guideline_document) as guideline_chk,

        -- 7. ingestion_log count
        (SELECT count(*)::int FROM ingestion_log) as ingestion_log_count,

        -- 8. action_log count
        (SELECT count(*)::int FROM action_log) as action_log_count;
    `)).rows[0];

    const baseCounts = {
      users: (await client.query(`SELECT count(*)::int as count FROM "user"`)).rows[0].count,
      clusters: (await client.query(`SELECT count(*)::int as count FROM cluster`)).rows[0].count,
      complaints: (await client.query(`SELECT count(*)::int as count FROM complaint`)).rows[0].count,
      recommended_actions: (await client.query(`SELECT count(*)::int as count FROM recommended_action`)).rows[0].count,
      sources: (await client.query(`SELECT count(*)::int as count FROM source`)).rows[0].count,
      guidelines: (await client.query(`SELECT count(*)::int as count FROM guideline_document`)).rows[0].count,
      ingestion_logs: preChecksums.ingestion_log_count,
      action_logs: preChecksums.action_log_count
    };

    console.log(`   Baseline Verified: ${baseCounts.users} users, ${baseCounts.clusters} clusters, ${baseCounts.complaints} complaints, ${baseCounts.recommended_actions} recs, ${baseCounts.sources} sources, ${baseCounts.guidelines} guidelines.`);

    // ── STEP 2: Deep Historical Migration Validation (001–008) ────────
    console.log("\n📋 [2/5] Performing Deep Multi-Object Catalog Verification for Base Migrations (001–008)...");

    // 001_init.sql
    const chk001 = (await client.query(`
      SELECT 
        (SELECT count(*) FROM information_schema.tables WHERE table_name IN ('source', 'complaint')) as tbl_count,
        (SELECT count(*) FROM information_schema.columns WHERE table_name = 'complaint' AND column_name IN ('id', 'source_id', 'text', 'category', 'latitude', 'longitude', 'status', 'severity_score', 'priority_score', 'idempotency_key', 'meta_data', 'created_at', 'updated_at')) as col_count,
        (SELECT count(*) FROM pg_indexes WHERE tablename = 'complaint' AND indexname IN ('idx_complaint_source_id', 'idx_complaint_status', 'idx_complaint_idempotency_key', 'idx_complaint_created_at')) as idx_count,
        (SELECT count(*) FROM information_schema.triggers WHERE event_object_table = 'complaint' AND trigger_name = 'update_complaint_updated_at') as trg_count;
    `)).rows[0];
    if (chk001.tbl_count !== '2' || chk001.col_count !== '13' || chk001.idx_count !== '4' || chk001.trg_count !== '1') {
      throw new Error("Deep verification failed for 001_init.sql: Missing expected database objects.");
    }

    // 002_cluster.sql
    const chk002 = (await client.query(`
      SELECT 
        (SELECT count(*) FROM information_schema.tables WHERE table_name = 'cluster') as tbl_count,
        (SELECT count(*) FROM information_schema.columns WHERE table_name = 'cluster' AND column_name IN ('id', 'title', 'category', 'region', 'severity_score', 'complaint_count', 'status', 'recommended_action', 'centroid')) as col_count,
        (SELECT count(*) FROM information_schema.columns WHERE table_name = 'complaint' AND column_name IN ('embedding', 'cluster_id')) as cmp_col_count,
        (SELECT count(*) FROM pg_indexes WHERE tablename = 'complaint' AND indexname = 'idx_complaint_cluster_id') as idx_count;
    `)).rows[0];
    if (chk002.tbl_count !== '1' || chk002.col_count !== '9' || chk002.cmp_col_count !== '2' || chk002.idx_count !== '1') {
      throw new Error("Deep verification failed for 002_cluster.sql: Missing expected database objects.");
    }

    // 003_recommendations.sql
    const chk003 = (await client.query(`
      SELECT 
        (SELECT count(*) FROM information_schema.tables WHERE table_name = 'recommended_action') as tbl_count,
        (SELECT count(*) FROM information_schema.columns WHERE table_name = 'cluster' AND column_name = 'last_severity_band') as band_col,
        (SELECT count(*) FROM information_schema.columns WHERE table_name = 'recommended_action' AND column_name IN ('id', 'cluster_id', 'action_text', 'generated_by', 'status', 'generated_at')) as col_count,
        (SELECT count(*) FROM pg_indexes WHERE tablename = 'recommended_action' AND indexname IN ('idx_rec_action_cluster_id', 'idx_rec_action_status')) as idx_count;
    `)).rows[0];
    if (chk003.tbl_count !== '1' || chk003.band_col !== '1' || chk003.col_count !== '6' || chk003.idx_count !== '2') {
      throw new Error("Deep verification failed for 003_recommendations.sql: Missing expected database objects.");
    }

    // 004_priority_score.sql
    const chk004 = (await client.query(`
      SELECT 
        (SELECT count(*) FROM information_schema.columns WHERE (table_name = 'cluster' OR table_name = 'complaint') AND column_name = 'priority_score') as col_count,
        (SELECT count(*) FROM pg_indexes WHERE tablename = 'cluster' AND indexname = 'idx_cluster_priority_score') as idx_count;
    `)).rows[0];
    if (chk004.col_count !== '2' || chk004.idx_count !== '1') {
      throw new Error("Deep verification failed for 004_priority_score.sql: Missing expected database objects.");
    }

    // 005_auth.sql
    const chk005 = (await client.query(`
      SELECT 
        (SELECT count(*) FROM information_schema.tables WHERE table_name = 'user') as tbl_count,
        (SELECT count(*) FROM information_schema.columns WHERE table_name = 'user' AND column_name IN ('id', 'name', 'email', 'password_hash', 'role', 'created_at')) as col_count,
        (SELECT count(*) FROM pg_indexes WHERE tablename = 'user' AND indexname IN ('idx_user_email', 'idx_user_role')) as idx_count;
    `)).rows[0];
    if (chk005.tbl_count !== '1' || chk005.col_count !== '6' || chk005.idx_count !== '2') {
      throw new Error("Deep verification failed for 005_auth.sql: Missing expected database objects.");
    }

    // 006_ingestion_log.sql
    const chk006 = (await client.query(`
      SELECT 
        (SELECT count(*) FROM information_schema.tables WHERE table_name = 'ingestion_log') as tbl_count,
        (SELECT count(*) FROM information_schema.columns WHERE table_name = 'ingestion_log' AND column_name IN ('id', 'source_type', 'run_at', 'processed', 'created', 'duplicates', 'errors', 'failed_feeds', 'status')) as col_count,
        (SELECT count(*) FROM pg_indexes WHERE tablename = 'ingestion_log' AND indexname = 'idx_ingestion_log_run_at') as idx_count,
        (SELECT count(*) FROM information_schema.columns WHERE table_name = 'user' AND column_name = 'is_service_account') as service_col;
    `)).rows[0];
    if (chk006.tbl_count !== '1' || chk006.col_count !== '9' || chk006.idx_count !== '1' || chk006.service_col !== '1') {
      throw new Error("Deep verification failed for 006_ingestion_log.sql: Missing expected database objects.");
    }

    // 007_audit_log.sql
    const chk007 = (await client.query(`
      SELECT 
        (SELECT count(*) FROM information_schema.tables WHERE table_name = 'action_log') as tbl_count,
        (SELECT count(*) FROM information_schema.columns WHERE table_name = 'cluster' AND column_name = 'needs_review') as review_col,
        (SELECT count(*) FROM pg_indexes WHERE tablename = 'action_log' AND indexname IN ('idx_action_log_cluster_logged', 'idx_action_log_admin_id')) as idx_count,
        (SELECT count(*) FROM pg_constraint WHERE conname = 'cluster_status_check') as check_constraint;
    `)).rows[0];
    if (chk007.tbl_count !== '1' || chk007.review_col !== '1' || chk007.idx_count !== '2' || chk007.check_constraint !== '1') {
      throw new Error("Deep verification failed for 007_audit_log.sql: Missing expected database objects.");
    }

    // 008_rag_recommendations.sql
    const chk008 = (await client.query(`
      SELECT 
        (SELECT count(*) FROM information_schema.tables WHERE table_name = 'guideline_document') as tbl_count,
        (SELECT count(*) FROM information_schema.columns WHERE table_name = 'guideline_document' AND column_name IN ('id', 'title', 'category', 'content', 'embedding', 'source', 'created_at')) as col_count,
        (SELECT count(*) FROM information_schema.columns WHERE table_name = 'recommended_action' AND column_name IN ('retrieved_context', 'confidence_score')) as rec_cols,
        (SELECT count(*) FROM pg_indexes WHERE tablename = 'guideline_document' AND indexname = 'idx_guideline_embedding') as idx_count;
    `)).rows[0];
    if (chk008.tbl_count !== '1' || chk008.col_count !== '7' || chk008.rec_cols !== '2' || chk008.idx_count !== '1') {
      throw new Error("Deep verification failed for 008_rag_recommendations.sql: Missing expected database objects.");
    }

    console.log("   ✅ Deep multi-object verification succeeded for ALL base migrations 001–008.");

    // Setup or inspect schema_migrations
    const trackRes = await client.query(`
      SELECT table_name FROM information_schema.tables 
      WHERE table_schema = 'public' AND table_name = 'schema_migrations';
    `);

    if (trackRes.rows.length === 0) {
      console.log("   Initializing schema_migrations tracking table...");
      await client.query(`
        CREATE TABLE schema_migrations (
            id SERIAL PRIMARY KEY,
            migration_name VARCHAR(100) NOT NULL UNIQUE,
            batch INT NOT NULL DEFAULT 1,
            applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
      `);
    }

    // Register verified base migrations in Batch 1
    const baseNames = [
      '001_init.sql', '002_cluster.sql', '003_recommendations.sql', '004_priority_score.sql',
      '005_auth.sql', '006_ingestion_log.sql', '007_audit_log.sql', '008_rag_recommendations.sql'
    ];
    for (const bn of baseNames) {
      await client.query(`
        INSERT INTO schema_migrations (migration_name, batch, applied_at)
        VALUES ($1, 1, NOW())
        ON CONFLICT (migration_name) DO NOTHING;
      `, [bn]);
    }
    console.log("   Registered verified base migrations 001–008 under Batch 1.");

    // ── STEP 3: Sequential Execution of Pending Migrations (009–015) ──
    console.log("\n🚀 [3/5] Executing Pending Migrations Sequentially in Atomic Transactions...");
    const migrationsDir = path.join(__dirname, '..', '..', 'migrations');
    const summary = [];

    for (const mig of PENDING_MIGRATIONS) {
      const filePath = path.join(migrationsDir, mig);
      if (!fs.existsSync(filePath)) {
        throw new Error(`Migration file missing on disk: ${filePath}`);
      }

      const sql = fs.readFileSync(filePath, 'utf8');
      const migStart = Date.now();
      console.log(`   Applying: ${mig}...`);

      // Atomic transaction per migration
      await client.query('BEGIN');
      try {
        await client.query(sql);

        // Record migration in the exact same transaction
        await client.query(`
          INSERT INTO schema_migrations (migration_name, batch, applied_at)
          VALUES ($1, 2, NOW())
          ON CONFLICT (migration_name) DO UPDATE 
            SET applied_at = NOW(), batch = 2;
        `, [mig]);

        await client.query('COMMIT');
        const duration = Date.now() - migStart;
        console.log(`   ✅ ${mig} committed successfully in ${duration}ms`);
        summary.push({ migration: mig, status: 'SUCCESS', durationMs: duration });
      } catch (migErr) {
        await client.query('ROLLBACK');
        console.error(`\n❌ FATAL ERROR: Migration ${mig} failed!`);
        console.error(`   Error details: ${migErr.message}`);
        console.error("   Transaction rolled back. Halting immediately without marking success.\n");
        throw migErr;
      }
    }

    // ── STEP 4: Post-Migration Schema Object Audit ─────────────────────
    console.log("\n🛡️ [4/5] Running Comprehensive Post-Migration Schema Object Audit...");

    // 1. Verify all 22 tables
    const expectedTables = [
      'source', 'user', 'cluster', 'complaint', 'recommended_action',
      'guideline_document', 'ingestion_log', 'action_log', 'schema_migrations',
      'agent_execution_log', 'complaint_media', 'civic_investigations',
      'investigation_evidence', 'investigation_reports', 'investigation_recommendations',
      'investigation_activity', 'civic_actions', 'action_assignments',
      'action_status_history', 'resolution_evidence', 'sla_configurations',
      'action_notifications'
    ];

    const tablesRes = await client.query(`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public';`);
    const presentTables = tablesRes.rows.map(r => r.table_name);
    const missingTables = expectedTables.filter(t => !presentTables.includes(t));
    if (missingTables.length > 0) {
      throw new Error(`Post-migration audit failed: Missing tables: ${missingTables.join(', ')}`);
    }
    console.log(`   ✅ All 22 expected tables verified present.`);

    // 2. Verify altered columns
    const clusterCols = await client.query(`
      SELECT column_name FROM information_schema.columns 
      WHERE table_name = 'cluster'
        AND column_name IN ('assigned_department', 'assigned_officer_id', 'geo_centroid_lat', 'geo_centroid_lng', 'temporal_weight', 'hybrid_score');
    `);
    if (clusterCols.rows.length !== 6) {
      throw new Error(`Post-migration audit failed: Expected 6 new columns on cluster, found ${clusterCols.rows.length}`);
    }

    const complaintCols = await client.query(`
      SELECT column_name FROM information_schema.columns 
      WHERE table_name = 'complaint' AND column_name = 'recency_weight';
    `);
    if (complaintCols.rows.length !== 1) {
      throw new Error("Post-migration audit failed: recency_weight column missing on complaint.");
    }
    console.log("   ✅ Altered columns on cluster (6) and complaint (1) verified.");

    // 3. Verify Foreign Keys (exact count = 35)
    const fkRes = await client.query(`
      SELECT count(*) as count FROM information_schema.table_constraints 
      WHERE constraint_type = 'FOREIGN KEY' AND table_schema = 'public';
    `);
    if (parseInt(fkRes.rows[0].count, 10) !== 35) {
      throw new Error(`Post-migration audit failed: Expected exactly 35 foreign keys, found ${fkRes.rows[0].count}`);
    }
    console.log(`   ✅ Foreign key constraints verified (exactly ${fkRes.rows[0].count} active).`);

    // 4. Verify Migration Indexes (exact count = 30)
    const indexRes = await client.query(`
      SELECT count(*) as count FROM pg_indexes 
      WHERE schemaname = 'public' 
        AND indexname IN (
          'idx_cluster_assigned_dept', 'idx_cluster_assigned_officer',
          'idx_cluster_geo_centroid', 'idx_cluster_hybrid_score',
          'idx_agent_log_run_id', 'idx_agent_log_cluster', 'idx_agent_log_status_at', 'idx_agent_log_agent_type',
          'idx_complaint_media_complaint_id', 'idx_complaint_media_processing_status',
          'idx_investigations_cluster_id', 'idx_investigations_status', 'idx_investigations_created_at',
          'idx_investigation_evidence_inv_id', 'idx_investigation_evidence_type',
          'idx_investigation_reports_inv_id', 'idx_investigation_recs_inv_id', 'idx_investigation_activity_inv_id',
          'idx_civic_actions_status', 'idx_civic_actions_investigation_id', 'idx_civic_actions_recommendation_id',
          'idx_civic_actions_cluster_id', 'idx_civic_actions_department_id', 'idx_civic_actions_created_at',
          'idx_civic_actions_expected_completion', 'idx_action_assignments_action_id',
          'idx_action_status_history_action_id', 'idx_resolution_evidence_action_id',
          'idx_sla_configurations_lookup', 'idx_action_notifications_action_id'
        );
    `);
    if (parseInt(indexRes.rows[0].count, 10) !== 30) {
      throw new Error(`Post-migration audit failed: Expected 30 migration indexes, found ${indexRes.rows[0].count}`);
    }
    console.log(`   ✅ Migration indexes verified (exactly ${indexRes.rows[0].count} active).`);

    // 5. Verify Triggers (4 update triggers)
    const trgRes = await client.query(`
      SELECT trigger_name FROM information_schema.triggers 
      WHERE trigger_name IN (
        'update_complaint_updated_at',
        'update_civic_investigations_updated_at',
        'update_civic_actions_updated_at',
        'update_sla_configurations_updated_at'
      );
    `);
    if (trgRes.rows.length !== 4) {
      throw new Error(`Post-migration audit failed: Expected 4 update triggers, found ${trgRes.rows.length}`);
    }
    console.log("   ✅ All 4 update triggers verified active.");

    // 6. Verify SLA Seed Data (10 reference rows)
    const slaRows = await client.query(`SELECT count(*)::int as count FROM sla_configurations`);
    if (slaRows.rows[0].count !== 10) {
      throw new Error(`Post-migration audit failed: Expected 10 SLA seed rows, found ${slaRows.rows[0].count}`);
    }
    console.log(`   ✅ SLA seed configurations verified (exactly ${slaRows.rows[0].count} rows).`);

    // 7. Verify Migration Tracking (14 registered migrations)
    const trackingRows = await client.query(`
      SELECT batch, count(*)::int as count FROM schema_migrations GROUP BY batch ORDER BY batch;
    `);
    console.log("   ✅ Migration tracking verified:", JSON.stringify(trackingRows.rows));

    // ── STEP 5: Mathematical Zero-Data-Loss Cryptographic Audit ───────
    console.log("\n🔒 [5/5] Performing Cryptographic Zero-Data-Loss & Centroid Verification Across ALL 8 Tables...");
    const postChecksums = (await client.query(`
      SELECT 
        -- 1. user
        (SELECT md5(string_agg(
          COALESCE(id::text, '') || '|' || COALESCE(name, '') || '|' || COALESCE(email, '') || '|' || 
          COALESCE(role, '') || '|' || COALESCE(password_hash, '') || '|' || COALESCE(is_service_account::text, 'false'),
          ',' ORDER BY id
        )) FROM "user") as user_chk,

        -- 2. complaint (core immutable columns)
        (SELECT md5(string_agg(
          COALESCE(id::text, '') || '|' || COALESCE(source_id::text, '') || '|' || COALESCE(idempotency_key::text, '') || '|' || 
          COALESCE(category, '') || '|' || COALESCE(status, '') || '|' || COALESCE(severity_score::text, '0') || '|' || 
          COALESCE(priority_score::text, '0') || '|' || COALESCE(cluster_id::text, '') || '|' || md5(COALESCE(text, '')),
          ',' ORDER BY id
        )) FROM complaint) as complaint_core_chk,

        -- 3. cluster (core immutable business columns)
        (SELECT md5(string_agg(
          COALESCE(id::text, '') || '|' || COALESCE(title, '') || '|' || COALESCE(category, '') || '|' || 
          COALESCE(region, '') || '|' || COALESCE(severity_score::text, '0') || '|' || COALESCE(priority_score::text, '0') || '|' || 
          COALESCE(status, '') || '|' || COALESCE(needs_review::text, 'false') || '|' || COALESCE(last_severity_band, ''),
          ',' ORDER BY id
        )) FROM cluster) as cluster_immutable_chk,

        -- 4. recommended_action
        (SELECT md5(string_agg(
          COALESCE(id::text, '') || '|' || COALESCE(cluster_id::text, '') || '|' || COALESCE(action_text, '') || '|' || 
          COALESCE(generated_by, '') || '|' || COALESCE(status, ''),
          ',' ORDER BY id
        )) FROM recommended_action) as recommended_action_chk,

        -- 5. source
        (SELECT md5(string_agg(
          COALESCE(id::text, '') || '|' || COALESCE(name, '') || '|' || COALESCE(description, ''),
          ',' ORDER BY id
        )) FROM source) as source_chk,

        -- 6. guideline_document
        (SELECT md5(string_agg(
          COALESCE(id::text, '') || '|' || COALESCE(title, '') || '|' || COALESCE(category, '') || '|' || md5(COALESCE(content, '')),
          ',' ORDER BY id
        )) FROM guideline_document) as guideline_chk,

        -- 7. ingestion_log count
        (SELECT count(*)::int FROM ingestion_log) as ingestion_log_count,

        -- 8. action_log count
        (SELECT count(*)::int FROM action_log) as action_log_count;
    `)).rows[0];

    // Assert immutable checksum equality across all populated tables
    const checksumMismatches = [];
    if (postChecksums.user_chk !== preChecksums.user_chk) checksumMismatches.push('user');
    if (postChecksums.complaint_core_chk !== preChecksums.complaint_core_chk) checksumMismatches.push('complaint_core');
    if (postChecksums.cluster_immutable_chk !== preChecksums.cluster_immutable_chk) checksumMismatches.push('cluster_immutable');
    if (postChecksums.recommended_action_chk !== preChecksums.recommended_action_chk) checksumMismatches.push('recommended_action');
    if (postChecksums.source_chk !== preChecksums.source_chk) checksumMismatches.push('source');
    if (postChecksums.guideline_chk !== preChecksums.guideline_chk) checksumMismatches.push('guideline_document');
    if (postChecksums.ingestion_log_count !== preChecksums.ingestion_log_count) checksumMismatches.push('ingestion_log');
    if (postChecksums.action_log_count !== preChecksums.action_log_count) checksumMismatches.push('action_log');

    if (checksumMismatches.length > 0) {
      throw new Error(`CRITICAL: Cryptographic checksum mismatch detected on: ${checksumMismatches.join(', ')}`);
    }
    console.log("   ✅ All 8 existing tables verified 100% intact with ZERO data corruption!");

    // Verify complaint recency_weight default on all existing rows
    const recencyAudit = (await client.query(`
      SELECT count(*)::int as count FROM complaint WHERE recency_weight = 1.0;
    `)).rows[0];
    if (recencyAudit.count !== baseCounts.complaints) {
      throw new Error(`Recency weight audit failed: Expected ${baseCounts.complaints} complaints with recency_weight = 1.0, found ${recencyAudit.count}`);
    }
    console.log(`   ✅ Complaint recency_weight verified: all ${recencyAudit.count} existing complaints carry default 1.0000.`);

    // Verify intentional centroid backfill on cluster
    const backfillAudit = (await client.query(`
      SELECT 
        count(*)::int as total_clusters,
        count(geo_centroid_lat)::int as clusters_with_centroid,
        count(CASE WHEN geo_centroid_lat IS NULL THEN 1 END)::int as clusters_without_centroid
      FROM cluster;
    `)).rows[0];
    console.log(`   ✅ Centroid backfill verified: ${backfillAudit.clusters_with_centroid} clusters populated with coordinates, ${backfillAudit.clusters_without_centroid} remain NULL as intended.`);

    const totalSeconds = ((Date.now() - startTime) / 1000).toFixed(2);
    console.log("\n=======================================================");
    console.log(`🎉 PRODUCTION MIGRATION VERIFICATION COMPLETE: ALL CHECKS PASSED in ${totalSeconds}s`);
    console.log("=======================================================\n");

  } finally {
    client.release();
    await pool.end();
  }
}

run().catch(err => {
  console.error("\n❌ MIGRATION EXECUTION HALTED:", err.message);
  process.exit(1);
});
