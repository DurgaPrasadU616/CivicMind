# CivicMind — Project Walkthrough

## Overview

CivicMind is an AI-powered civic complaint aggregation and prioritization platform. It ingests citizen complaints from multiple sources, clusters them using vector embeddings, scores severity/priority with a multi-factor algorithm, and generates AI-powered action recommendations for municipal authorities.

**Target city:** Bangalore (BBMP jurisdiction) — but the system is source-agnostic and region-configurable.

---

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│  Data Sources                                                │
│  ┌────────────┐  ┌──────────────┐  ┌─────────────────────┐ │
│  │  Citizen    │  │  News RSS    │  │  Social Media       │ │
│  │  Portal     │  │  (real API)  │  │  (SIMULATED data)   │ │
│  │  POST       │  │  NDTV, Hindu │  │  Mock dataset —     │ │
│  │  /api/      │  │  Indian Exp  │  │  not live Twitter/X  │ │
│  │  complaints │  │              │  │                      │ │
│  └─────┬──────┘  └──────┬───────┘  └──────────┬──────────┘ │
│        │                │                      │             │
│        └────────────────┼──────────────────────┘             │
│                         ▼                                    │
│           ┌─────────────────────────┐                        │
│           │   insertAndCluster()    │ ← shared pipeline      │
│           │   (common.ts)           │                        │
│           └──────────┬──────────────┘                        │
│                      ▼                                       │
│           ┌─────────────────────────┐                        │
│           │   embed → cluster →     │                        │
│           │   score → recommend     │                        │
│           │   (clustering.ts)       │                        │
│           └──────────┬──────────────┘                        │
│                      ▼                                       │
│           ┌─────────────────────────┐                        │
│           │   PostgreSQL + pgvector │                        │
│           │   (complaint, cluster,  │                        │
│           │    recommended_action)  │                        │
│           └──────────┬──────────────┘                        │
│                      ▼                                       │
│           ┌─────────────────────────┐                        │
│           │   Next.js Dashboard     │                        │
│           │   (table + map views)   │                        │
│           └─────────────────────────┘                        │
└─────────────────────────────────────────────────────────────┘
```

---

## Data Sources — What's Live vs Simulated

This distinction matters for demos, portfolios, and interview settings.

### 1. Citizen Portal (LIVE)
- **How:** Citizens submit complaints via the web form at `/portal`
- **Endpoint:** `POST /api/complaints` (no auth required, rate-limited)
- **Source ID:** `citizen_portal`
- **Data:** Real user-submitted text, optional GPS coordinates, category selection

### 2. News RSS (LIVE — real feeds, real parsing)
- **How:** Fetches public Indian news RSS feeds, filters for civic relevance
- **Endpoint:** `POST /api/ingest/news` (admin/ngo/govt only)
- **Source ID:** `news_rss`
- **Feeds used:**
  1. NDTV Top Stories — `https://feeds.feedburner.com/ndtvnews-top-stories`
  2. The Hindu Bangalore — `https://www.thehindu.com/news/cities/bangalore/feeder/default.rss`
  3. Indian Express India — `https://indianexpress.com/section/india/feed/`
- **Filtering:** 40+ civic keywords (water, road, pothole, electricity, garbage, etc.) — articles must match at least one keyword
- **Dedup:** Deterministic SHA-256 hash of article URL → idempotency_key prevents re-ingestion
- **Category inference:** Keyword-to-category mapping (infrastructure, sanitation, utility, noise, safety, other)
- **Region:** Not extracted (left null) — news articles rarely have precise GPS coordinates

> **Note:** These are real, publicly accessible RSS feeds. The fetch + parse + filter pipeline is production-quality. For a city-specific deployment, you'd swap in BBMP-specific feeds.

### 3. Social Media (SIMULATED — not live Twitter/X API)
- **How:** Ingests a hand-crafted dataset of 20 realistic civic complaint social media posts
- **Endpoint:** `POST /api/ingest/social` (admin/ngo/govt only)
- **Source ID:** `social_media`
- **Why simulated:** Live Twitter/X API access requires a paid Basic ($100/mo) or Pro ($5000/mo) tier. For a demo/portfolio/interview, a mock dataset is transparent and sufficient to prove the pipeline works end-to-end.
- **Transparency:** All mock posts are tagged with `simulated: true` in their `meta_data` JSONB field
- **Coverage:** 20 posts across 6 categories and 5 Bangalore regions — infrastructure (6), sanitation (4), utility (4), safety (3), noise (2), other (1)
- **When real API is available:** Replace the `MOCK_POSTS` array with real Twitter API calls; the `insertAndCluster()` pipeline stays identical

### 4. Survey & NGO Report (SEEDED but not ingested yet)
- The `source` table has `survey` and `ngo_report` seeded
- No ingestion pipeline exists for these yet — planned for future work

---

## Ingestion Pipeline Details

### Shared Pipeline (`common.ts`)

All ingestion paths converge on `insertAndCluster()`:

1. **Dedup check:** Generates a deterministic UUID from raw content via SHA-256 → `idempotency_key`. The complaint table has a UNIQUE constraint on this column, so `ON CONFLICT DO NOTHING` silently skips duplicates.

2. **Insert complaint:** Writes to `complaint` table with `source_id`, `text`, `category`, `latitude`, `longitude`, `meta_data`.

3. **Cluster via `clusterComplaint()`:**
   - Generates a 1536-dim embedding (Gemini API if key available, deterministic hash-based fallback otherwise)
   - Finds the closest open cluster of the same category using pgvector cosine distance
   - If similarity ≥ 0.70: attaches to existing cluster, recalculates centroid
   - If below threshold: creates a new cluster with region from GPS coordinates
   - Recalculates multi-factor severity (volume, growth rate, affected population, resolution speed)
   - Updates priority score (severity × urgency decay × resource cost factor)
   - Fires async recommendation trigger (Gemini AI or rule-based fallback)

### News Ingestion (`newsIngestion.ts`)

```
RSS Feed URLs → fetch (parallel, 10s timeout) → XML parse (fast-xml-parser)
  → dedup across feeds → civic keyword filter → category inference
  → idempotency_key from URL → insertAndCluster()
```

### Social Media Ingestion (`socialIngestion.ts`)

```
MOCK_POSTS array → category inference → region-to-GPS mapping
  → idempotency_key from platform:author:postedAt → insertAndCluster()
```

---

## API Endpoints

| Method | Route | Auth | Description |
|--------|-------|------|-------------|
| GET | `/health` | None | DB health check |
| POST | `/api/auth/register` | None | Create user account |
| POST | `/api/auth/login` | None | Authenticate, return JWT |
| POST | `/api/complaints` | None (rate-limited) | Submit complaint + auto-cluster |
| GET | `/api/complaints/:id` | None | Fetch complaint by ID (CM-xxx) |
| GET | `/api/clusters` | None | List clusters with filters, sorted by priority |
| POST | `/api/clusters/:id/status` | JWT + ngo/govt/admin | Update cluster status |
| GET | `/api/clusters/:id/actions` | None | Get recommended action history |
| POST | `/api/ingest/news` | JWT + admin/govt/ngo | Trigger news RSS ingestion |
| POST | `/api/ingest/social` | JWT + admin/govt/ngo | Trigger social media mock ingestion |

### Triggering Ingestion (Manual)

```bash
# 1. Register/login as admin to get JWT
TOKEN=$(curl -s -X POST http://localhost:5000/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"admin@civicmind.gov","password":"admin123"}' | jq -r '.token')

# 2. Trigger news ingestion
curl -X POST http://localhost:5000/api/ingest/news \
  -H "Authorization: Bearer $TOKEN"

# 3. Trigger social media ingestion
curl -X POST http://localhost:5000/api/ingest/social \
  -H "Authorization: Bearer $TOKEN"
```

### Scheduled Execution (TODO — not built yet)

To run ingestion on a schedule (e.g. every 6 hours), add a GitHub Actions cron workflow:

```yaml
# .github/workflows/ingest-news.yml
name: Ingest News RSS
on:
  schedule:
    - cron: '0 */6 * * *'   # every 6 hours
  workflow_dispatch:          # manual trigger
jobs:
  ingest:
    runs-on: ubuntu-latest
    steps:
      - name: Trigger news ingestion
        run: |
          curl -X POST "$BACKEND_URL/api/ingest/news" \
           -H "Authorization: Bearer $INGEST_TOKEN" \
           -H "Content-Type: application/json"
```

---

## Scoring System

### Severity Score (0-100)
Multi-factor weighted formula:
- **Volume:** complaint count normalized against threshold (25%)
- **Growth rate:** complaints in last 7 days vs total (25%)
- **Affected population:** complaint count × multiplier (25%)
- **Resolution speed:** inverse of historical resolution days for category (25%)
- **Category weight:** safety gets 1.3× multiplier, noise gets 0.8×

### Priority Score (0-100)
`severity × urgency_decay × resource_cost_factor`
- **Urgency decay:** exponential decay over time (rate=0.05, floor=0.20) — older unresolved clusters decay in priority
- **Resource cost:** per-category weighting (noise=1.0, utility=0.7, infrastructure=0.85, etc.)

---

## Frontend

- **Portal (`/portal`):** Citizen complaint submission form with GPS mock generator
- **Dashboard (`/dashboard`):** Admin view with table + map modes, cluster detail panel, status management
  - Source badges color-coded: Indigo (portal), Cyan (news), Pink (social), Amber (survey), Emerald (NGO)
- **Tracker (`/track`):** Citizen-facing complaint stepper UI (Submitted → Clustered → In Review → Resolved)

---

## Testing

```bash
cd backend
npm test    # runs jest --runInBand --detectOpenHandles
```

5 test suites, 111 tests:
- `complaints.test.ts` — clustering, severity, REST routes, validation, rate limits
- `auth.test.ts` — register, login, JWT, role middleware
- `recommendations.test.ts` — severity bands, escalation, generation, store
- `ranking.test.ts` — urgency decay, cost factor, priority formula
- `ingestion.test.ts` — RSS parsing, keyword filtering, dedup, social mock, HTTP auth

---

## Running the Project

```bash
# Backend
cd backend
cp .env.example .env    # configure DATABASE_URL, JWT_SECRET, GEMINI_API_KEY (optional)
npm install
npm run dev             # starts on :5000

# Frontend
cd frontend
cp .env.local.example .env.local   # set NEXT_PUBLIC_API_URL=http://localhost:5000
npm install
npm run dev             # starts on :3000
```
