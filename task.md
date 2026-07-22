# CivicMind — Task Tracker

## Completed Tasks

### Task 1: Core Complaint Pipeline (citizen_portal)
- [x] Database schema: `source` + `complaint` tables with indexes and triggers
- [x] Seeded 5 source types: citizen_portal, social_media, survey, ngo_report, news_rss
- [x] `POST /api/complaints` — citizen submission with Zod validation, idempotency, rate limiting
- [x] `GET /api/complaints/:id` — complaint status lookup (CM-xxx format)
- [x] Embedding generation (Gemini API with deterministic fallback)
- [x] Vector clustering via pgvector cosine similarity (threshold: 0.70)
- [x] Multi-factor severity scoring (volume, growth, population, resolution speed)
- [x] Priority scoring (severity × urgency decay × resource cost)
- [x] AI action recommendations (Gemini with rule-based fallback)
- [x] Cluster status management with complaint cascade
- [x] Authentication (JWT) and role-based access (citizen/ngo/govt/admin)

### Task 2: Dashboard & Frontend
- [x] Citizen portal page (`/portal`) — complaint submission form
- [x] Admin dashboard (`/dashboard`) — table + map views, cluster detail panel
- [x] Source badge display per complaint (indigo=portal, cyan=news, pink=social)
- [x] Priority/severity score visualization in detail panel
- [x] AI action plan recommendation panel (Gemini AI vs rule-based badge)
- [x] Cluster status update operations (in_progress, resolved)
- [x] Citizen tracker (`/track`) — stepper UI with cluster linking
- [x] Auth context (login, register, JWT management)
- [x] Navbar with role badges and logout

### Task 3: Multi-Source Ingestion Pipeline
- [x] **Common helpers** (`backend/src/services/ingestion/common.ts`)
  - `getSourceId()` — source name → numeric ID lookup
  - `generateIdempotencyKey()` — SHA-256 deterministic UUID from arbitrary string
  - `insertAndCluster()` — dedup-aware insert + full clusterComplaint() pipeline
- [x] **News RSS ingestion** (`backend/src/services/ingestion/newsIngestion.ts`)
  - 3 public Indian RSS feeds (NDTV, The Hindu Bangalore, Indian Express)
  - `isCivicRelevant()` — 40+ keyword filter to avoid noise
  - `inferCategory()` — keyword-to-category mapping
  - Parallel feed fetch with 10s timeout per feed
  - Dedup across feeds (title-based) + dedup across runs (URL-based idempotency key)
- [x] **Social media ingestion** (`backend/src/services/ingestion/socialIngestion.ts`)
  - 20 realistic mock civic complaint posts
  - SIMULATED data (not live Twitter/X API — paid tier required)
  - Transparent: `simulated: true` flag in meta_data
  - Coverage: 6 categories × 5 Bangalore regions
  - Same insertAndCluster() pipeline as citizen portal and news
- [x] **API endpoints** (`backend/src/routes/ingest.ts`)
  - `POST /api/ingest/news` — admin/govt/ngo only
  - `POST /api/ingest/social` — admin/govt/ngo only
  - GitHub Actions cron TODO comment (lines 7-26)
- [x] **Tests** (`backend/tests/ingestion.test.ts`)
  - `generateIdempotencyKey` — deterministic, UUID format, different inputs → different keys
  - `getSourceId` — valid source returns ID, unknown returns null
  - `insertAndCluster` — insert calls clusterComplaint, duplicate returns null
  - News keyword filtering — civic-relevant text accepted, non-civic rejected
  - News category inference — keywords map to correct categories, default "other"
  - News source-not-found error handling
  - Social source-not-found error handling
  - Social mock ingestion — 20 posts inserted, 0 errors
  - Social duplicate skip — all 20 skipped gracefully
  - HTTP auth — unauthenticated rejected, citizen rejected, admin accepted
- [x] **Dashboard source display** — color-coded badges in cluster detail complaint list
- [x] **Fast-xml-parser** dependency added to backend/package.json

## Pending Tasks

### Task 4: Survey & NGO Report Ingestion (future)
- [ ] Survey response ingestion pipeline
- [ ] NGO report ingestion pipeline
- [ ] Respective API endpoints

## Test Results

```
Test Suites: 5 passed, 5 total
Tests:       111 passed, 111 total
Time:        ~8.5s
```

| Suite | Tests | Coverage |
|-------|-------|----------|
| complaints.test.ts | 30 | Clustering, severity, routes, validation, rate limits, error paths |
| auth.test.ts | 17 | Register, login, JWT, role middleware |
| recommendations.test.ts | 18 | Bands, escalation, generation, store, non-blocking |
| ranking.test.ts | 26 | Urgency decay, cost factor, priority formula |
| ingestion.test.ts | 20 | News/social/common helpers, HTTP auth |
