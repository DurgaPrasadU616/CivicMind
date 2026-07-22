# CivicMind AI 🏛️🧠

![Next.js](https://img.shields.io/badge/Next.js-black?style=for-the-badge&logo=next.js&logoColor=white)
![Express.js](https://img.shields.io/badge/Express.js-000000?style=for-the-badge&logo=express&logoColor=white)
![PostgreSQL](https://img.shields.io/badge/PostgreSQL-316192?style=for-the-badge&logo=postgresql&logoColor=white)
![Gemini](https://img.shields.io/badge/Google_Gemini-8E75B2?style=for-the-badge&logo=google&logoColor=white)
![Vercel](https://img.shields.io/badge/Vercel-000000?style=for-the-badge&logo=vercel&logoColor=white)

**AI Platform for Civic Issue Discovery, Prioritization, and Resolution**

🚀 **Live Demo:** [https://aicivilmind.vercel.app/](https://aicivilmind.vercel.app/)  
⚙️ **Live API:** [https://civilmindapi.vercel.app/](https://civilmindapi.vercel.app/)

CivicMind AI is a civic intelligence platform designed to help municipal governments and non-governmental organizations (NGOs) detect community problems before they escalate. By unifying citizen reporting channels, news feeds, and simulated social signals, CivicMind AI leverages vector embeddings, deterministic severity formulas, and large language models (LLMs) to automatically cluster, rank, and recommend solutions for civic issues.

![Login Page](./screenshots/login.png)
<!-- To add a dashboard screenshot, save your image as 'dashboard.png' in the 'screenshots' folder and uncomment the line below -->
<!-- ![Dashboard Screenshot](./screenshots/dashboard.png) -->

---

## Table of Contents
1. [Executive Summary & Problem Statement](#executive-summary--problem-statement)
2. [High-Level Architecture](#high-level-architecture)
3. [Layered Architecture Breakdown](#layered-architecture-breakdown)
   - [Data Sources](#1-data-sources)
   - [Ingestion Service](#2-ingestion-service)
   - [AI Processing Layer](#3-ai-processing-layer)
   - [Data Storage Layer](#4-data-storage-layer)
   - [Backend API](#5-backend-api)
   - [Next.js Dashboard](#6-nextjs-dashboard)
4. [End-to-End AI Pipeline](#end-to-end-ai-pipeline)
5. [System Design Decisions](#system-design-decisions)
6. [Security Architecture](#security-architecture)
7. [Current Limitations](#current-limitations)
8. [Technology Stack](#technology-stack)
9. [Project Structure](#project-structure)
10. [Getting Started & Local Development](#getting-started--local-development)
11. [Future Work](#future-work)

---

## Executive Summary & Problem Statement

### The Civic Challenge
Municipalities and civil organizations receive thousands of citizen complaints daily across disconnected communication channels—web portals, social media mentions, news reports, and field surveys. This fragmentation leads to:
- **Duplicate Intake**: Hundreds of individual reports about the same underlying incident (e.g., "water pipe burst on 5th Ave" and "no tap water in Downtown") are treated as isolated tickets.
- **Manual Prioritization**: Triage is frequently manual, subjective, or driven strictly by raw report volume rather than civic impact and population severity.
- **Delayed Response Times**: Critical infrastructure failures get buried under high-volume minor complaints, delaying intervention.

### The CivicMind AI Solution
CivicMind AI transforms raw, unstructured multi-channel signals into a unified, prioritized action plan:
- **Semantic Normalization & Vector Clustering**: Converts free-text reports into Gemini text embeddings (`text-embedding-004`) stored in `pgvector`, clustering semantically related complaints via cosine distance (`<=>`) to group duplicate issues.
- **Severity & Priority Scoring**: Computes objective severity scores using multi-variable weighting (volume, 7-day growth rate, category criticality, and affected population) combined with urgency decay formulas so long-standing critical issues remain visible.
- **Automated Action Plans**: Generates contextualized mitigation steps per cluster using `gemini-2.0-flash`, complete with deterministic rule-based fallbacks for offline or API error recovery.
- **Role-Gated Triage & Auditability**: Delivers dedicated interfaces for Citizens, NGOs, Government Officials, and System Administrators with full audit logs (`ingestion_log`) and least-privilege service access.

---

## High-Level Architecture

CivicMind AI follows a **Layered Architecture** with clear separation of concerns across data intake, preprocessing, AI execution, relational/vector storage, and API presentation.

```
┌─────────────────────────────────────────────────────────────┐
│                        Data Sources                         │
│  Citizen Portal    │   News RSS    │   Social Media (Sim)   │
└──────────────────────────────┬──────────────────────────────┘
                               │
                               ▼
┌─────────────────────────────────────────────────────────────┐
│                      Ingestion Service                      │
│  Validation │ Deduplication │ Normalization │ Audit Logging │
└──────────────────────────────┬──────────────────────────────┘
                               │
                               ▼
┌─────────────────────────────────────────────────────────────┐
│                     AI Processing Layer                     │
│  Embeddings │ Clustering │ Severity │ Priority │ Actions    │
└──────────────────────────────┬──────────────────────────────┘
                               │
                               ▼
┌─────────────────────────────────────────────────────────────┐
│                     Data Storage Layer                      │
│        PostgreSQL (Relational) + pgvector (Semantic)        │
└──────────────────────────────┬──────────────────────────────┘
                               │
                               ▼
┌─────────────────────────────────────────────────────────────┐
│                         Backend API                         │
│     Express REST │ JWT Auth │ RBAC │ Zod Schema Guards    │
└──────────────────────────────┬──────────────────────────────┘
                               │
                               ▼
┌─────────────────────────────────────────────────────────────┐
│                      Next.js Dashboard                      │
│      Citizen │ NGO │ Government Official │ Administrator    │
└─────────────────────────────────────────────────────────────┘
```

---

## Layered Architecture Breakdown

### 1. Data Sources
The system currently ingests civic feedback from three implemented channels:
- **Citizen Portal**: Real-time web submission interface allowing residents to report local issues with category tags, descriptions, and regional metadata.
- **News RSS Feeds**: Automated pulls from municipal and local news RSS streams to capture published community incidents and infrastructure reports (`newsIngestion.ts`).
- **Social Media (Simulated)**: Ingestion representing public civic discourse, normalized from a simulated social media dataset (`socialIngestion.ts`).

> **Normalization**: Regardless of origin, all incoming payloads are transformed into a standardized canonical schema via the shared `insertAndCluster()` pipeline (`common.ts`) before entering downstream AI layers.

---

### 2. Ingestion Service
The Ingestion Service preprocesses all data entering CivicMind AI:
- **Input Validation**: Enforces strict schema conformity and sanitization using Zod definitions (`complaint.ts`), rejecting malformed payloads early.
- **Deduplication**: Identifies and discards duplicate submissions using cryptographic idempotency keys (`ON CONFLICT DO NOTHING`) across daily ingestion runs.
- **Normalization & Category Detection**: Cleans raw text, extracts regional markers, and infers civic categories (`utility`, `safety`, `sanitation`, `infrastructure`, `noise`, `other`) when unassigned.
- **Source Tagging & Audit Logging**: Records attribution metadata (`source_type`, timestamp, raw feed URLs) and persists execution summaries to the `ingestion_log` table, tracking processed items, created rows, skipped duplicates, and partial feed failures (`status: 'success' | 'partial' | 'failed'`).
- **Automated CI/CD Orchestration**: Supports scheduled daily ingestion (`0 6 * * *` UTC) via a GitHub Actions workflow (`daily-ingestion.yml`) authenticating with dedicated, least-privilege service account credentials (`service_account` RBAC).

---

### 3. AI Processing Layer
The AI Processing Layer decouples semantic intelligence into distinct domain services inside `backend/src/services/`:

```
┌───────────────────────────────────────────────────────────────────────────┐
│                           AI Processing Layer                             │
│                                                                           │
│  • Embedding Service      →  Gemini text-embedding-004 (or local fallback)│
│  • Semantic Clustering    →  pgvector cosine distance (<=>) matching       │
│  • Severity Engine        →  Weighted score: volume + growth + population │
│  • Priority Engine        →  Urgency decay floor + resource cost factors  │
│  • Recommendation Engine  →  Gemini 2.0 Flash action plans + local backup │
└───────────────────────────────────────────────────────────────────────────┘
```

#### • Embedding Service (`embeddings.ts`)
- Generates vector representations of normalized complaint text using Google's `text-embedding-004` API.
- Implements a deterministic local embedding fallback algorithm when `GEMINI_API_KEY` is absent or the API returns errors.

#### • Semantic Clustering (`clustering.ts`)
- Queries existing active civic clusters within the target region using `pgvector` cosine distance (`<=>`).
- If an incoming complaint's similarity matches or exceeds the configured threshold (`CLUSTERING_THRESHOLD`), it attaches to the existing cluster and increments its statistics.
- If no existing cluster satisfies the threshold, a new semantic `cluster` record is automatically created.

#### • Severity Engine (`clustering.ts`)
- Evaluates impact on a `0–100` scale using a weighted formula (`WEIGHTS` in `scoring.ts`):
  $$\text{Severity} = w_v \cdot \text{Volume} + w_g \cdot \text{GrowthRate}_{7d} + w_c \cdot \text{Criticality} + w_p \cdot \text{Population} + w_r \cdot \text{ResolutionSpeed}$$
- Recalculates dynamically upon each new complaint attachment, assigning clusters into severity bands (`low`, `medium`, `high`).

#### • Priority Engine (`ranking.ts`)
- Computes `priority_score` combining base severity with time-based urgency decay (`URGENCY_DECAY_RATE`) and category-specific resource allocation weighting (`RESOURCE_COST_WEIGHTS`).
- Applies an exponential decay curve moderated by an absolute **Urgency Decay Floor (`URGENCY_DECAY_FLOOR = 0.20`)**, guaranteeing that long-standing critical issues maintain a minimum priority multiplier.
- Incorporates category-based resource cost factors (`utility`, `safety`, `infrastructure`, `sanitation`, `noise`) to moderate priority scores for municipal budgeting.

#### • Recommendation Engine (`recommendations.ts`)
- Monitors cluster severity band transitions (`low → medium`, `medium → high`). Upon escalation or new cluster initialization, invokes `gemini-2.0-flash`.
- Generates structured, concrete municipal action recommendations tailored to the cluster's category, region, and complaint summary.
- Maintains versioned records in the `recommended_action` table (`status: 'active' | 'superseded'`) and reverts to rule-based fallback protocols if Gemini API calls fail or credentials are unconfigured.

---

### 4. Data Storage Layer
The persistence layer separates relational transactional records from vector similarity indexes within a single PostgreSQL database instance (`db.ts`):

#### PostgreSQL (Relational Engine)
- **`source`**: Tracks intake source definitions and metadata (`citizen_portal`, `news_rss`, `social_media`).
- **`complaint`**: Records individual complaints, raw text, normalized fields, category assignments, vector embeddings, and foreign keys (`cluster_id`).
- **`cluster`**: Tracks aggregated cluster summaries, complaint counts, severity scores, priority scores, and lifecycle status (`pending`, `in_progress`, `resolved`).
- **`recommended_action`**: Stores versioned AI-generated and rule-based fallback action plans (`status: 'active' | 'superseded'`) linked to clusters.
- **`user`**: Stores user accounts, bcrypt password hashes (`password_hash`), and RBAC roles (`citizen`, `ngo`, `govt`, `admin`, `service_account`).
- **`ingestion_log`**: Stores audit logs (`run_at`, `source_type`, `processed`, `created`, `duplicates`, `errors`, `failed_feeds`, `status`) for all manual and scheduled ingestion runs.

#### pgvector (Vector Engine)
- **`complaint.embedding`**: Stores vector embeddings alongside relational data in the `complaint` table.
- **Exact Cosine Distance Search**: Leverages the `pgvector` extension's `<=>` operator (`1 - cosine_similarity`) to execute nearest-neighbor lookups constrained by region and category (`clustering.ts`).

> **Why pgvector?** Storing embeddings inside PostgreSQL eliminates external database synchronization overhead, extra network hops, and distributed transaction complexity. It allows atomic queries where relational filtering (`region`, `category`) and vector similarity search (`<=>`) execute in a single database query.

---

### 5. Backend API
Built on Node.js and Express with TypeScript typing, the Backend API serves as the interface for all client and CI/CD interactions:
- **Implemented REST Endpoints**:
  - `GET /api/health` — System health check (`health.ts`)
  - `POST /api/auth/register` — User registration (`auth.ts`)
  - `POST /api/auth/login` — User authentication returning JWT (`auth.ts`)
  - `POST /api/complaints` — Submit complaint (`complaints.ts`, protected by `submitLimiter` rate limit)
  - `GET /api/complaints/:id` — Get complaint details by ID (`complaints.ts`)
  - `GET /api/clusters` — Query active clusters with optional region/category/status filters (`complaints.ts`)
  - `POST /api/clusters/:id/status` — Update cluster lifecycle status (`complaints.ts`, protected by `authenticateToken` & `requireRole('ngo', 'govt', 'admin')`)
  - `GET /api/clusters/:id/actions` — Retrieve active and historical recommended actions (`complaints.ts`)
  - `POST /api/ingest/news` — Trigger RSS news feed ingestion (`ingest.ts`, protected by `authenticateToken` & `requireRole('admin', 'govt', 'ngo', 'service_account')`)
  - `POST /api/ingest/social` — Trigger simulated social media ingestion (`ingest.ts`, protected by `authenticateToken` & `requireRole('admin', 'govt', 'ngo', 'service_account')`)
  - `GET /api/ingestion/log` (also `GET /api/ingest/log`) — Paginated ingestion audit logs (`ingest.ts`, protected by `authenticateToken` & `requireRole('admin', 'govt')`)
- **Authentication & Authorization**: Stateless JSON Web Token (`JWT`) authentication via `authenticateToken` middleware with fine-grained `requireRole` guards.
- **Runtime Validation**: Request body and parameter verification using Zod schemas (`auth.ts`, `complaint.ts`), ensuring payload integrity before controller execution.

---

### 6. Next.js Dashboard
The frontend application (`frontend/src/`) is built with Next.js App Router, React, and Tailwind CSS, providing role-specific views based on authenticated JWT claims:
- **Citizen Role**: Submit new local issues via the reporting portal (`/portal`), track complaint resolution status (`/track`), and view regional cluster summaries.
- **NGO Role**: Monitor civic clusters (`/dashboard`), review AI recommended action plans, and coordinate field response efforts.
- **Government Official Role**: Access triage queues sorted by `priority_score`, inspect severity breakdown metrics, and update cluster lifecycle statuses (`pending → in_progress → resolved`).
- **Administrator Role**: Inspect system metrics and view detailed ingestion run histories via the **Ingestion History Panel (`IngestionHistoryPanel.tsx`)**, displaying badges for successful runs, skipped duplicates, and partial feed failures.

---

## End-to-End AI Pipeline

When a civic report enters CivicMind AI, it traverses an 8-stage processing pipeline:

```
   [ 1. Complaint Intake ]
             │   Raw submission via Citizen Portal, News RSS, or Social Feed
             ▼
   [ 2. Text Normalization & Embedding ]
             │   Clean text & generate embedding via text-embedding-004 (or fallback)
             ▼
   [ 3. Vector Similarity Search ]
             │   Query pgvector using cosine distance (<=>) with regional filters
             ▼
   [ 4. Semantic Cluster Detection ]
             │   Attach to existing cluster if similarity >= CLUSTERING_THRESHOLD, else create new
             ▼
   [ 5. Severity Calculation ]
             │   Compute 0-100 score: Volume + 7d Growth + Criticality + Population + Speed
             ▼
   [ 6. Priority Ranking ]
             │   Apply time-based urgency decay floor (0.20) & category cost factors
             ▼
   [ 7. LLM Action Generation ]
             │   If severity band escalates, generate action via Gemini 2.0 Flash (or fallback)
             ▼
   [ 8. Multi-Role Dashboard Delivery ]
                 Surface ranked cluster & action plan to Govt Officials, NGOs & Citizens
```

---

## System Design Decisions

- **Why PostgreSQL?**  
  PostgreSQL provides ACID compliance, relational stability, and reliable foreign key relationships required for tracking citizen complaints, user credentials, and ingestion logs (`db.ts`).

- **Why pgvector instead of Pinecone?**  
  Embedding vector search directly inside PostgreSQL eliminates dual-database synchronization complexity and network latency. It allows atomic transactions where relational filtering (`region`, `category`, `status`) and vector distance (`<=>`) execute in a single SQL query.

- **Why Gemini?**  
  Google's `text-embedding-004` and `gemini-2.0-flash` models provide semantic understanding for categorizing citizen text and generating concrete municipal action steps.

- **Why Stateless JWT Authentication?**  
  Stateless JSON Web Tokens (`JWT`) verify user identities across Express route guards (`authenticateToken`) without querying session tables on every request. Role claims (`citizen`, `ngo`, `govt`, `admin`, `service_account`) enable immediate access control checks.

- **Why Deterministic Rule-Based Fallbacks?**  
  To maintain reliability during network dropouts, missing API keys in local development, or external rate limits, CivicMind AI implements deterministic fallback logic for embeddings (`embeddings.ts`) and action plans (`recommendations.ts`).

- **Why Node.js/Express & Next.js?**  
  Express.js provides a straightforward REST API server with flexible middleware support for authentication and rate limiting. Next.js App Router delivers server-side rendering and responsive client interfaces for citizens and municipal officials.

---

## Security Architecture

CivicMind AI implements only verified, existing security controls:

- **Authentication & Password Hashing**: User passwords are encrypted using `bcrypt` with `10` salt rounds (`auth.ts`). Authentication is governed by signed JSON Web Tokens (`JWT`).
- **Strict Role-Based Access Control (RBAC)**: Route access is gated by `requireRole` middleware. Specifically, automated ingestion scripts operate under a dedicated `'service_account'` role (`is_service_account` column) restricted strictly to `POST /api/ingest/news` and `POST /api/ingest/social` (`HTTP 403 Forbidden` on all other endpoints).
- **Zod Schema Enforcement**: API request bodies (`POST /api/auth/register`, `POST /api/auth/login`, `POST /api/complaints`) are validated against runtime Zod schemas before reaching business logic handlers.
- **Environment & Credential Isolation**: Sensitive credentials (`DATABASE_URL`, `JWT_SECRET`, `GEMINI_API_KEY`, and CI/CD `SERVICE_ACCOUNT_PASSWORD`) are loaded strictly from environment variables and secure GitHub Repository Secrets.

---

## Current Limitations

To maintain total transparency regarding current implementation boundaries, note the following limitations:

- **Simulated Social Media Data**: Social media ingestion (`socialIngestion.ts`) currently processes a simulated local dataset (`common.ts`) rather than connecting directly to live external social network firehoses.
- **External RSS Feed Dependency**: News ingestion (`newsIngestion.ts`) depends on the uptime and XML structure of external municipal RSS feeds. If external feeds fail or timeout, the service logs them under `failed_feeds` and reports `status: 'partial'` or `'failed'`.
- **In-Memory / Client JWT Storage**: Authentication issues stateless JWT tokens (`auth.ts`) which are currently returned in JSON payloads and managed by the client, without persistent `httpOnly` secure cookies.
- **Deterministic Fallback Activation**: When `GEMINI_API_KEY` is not set or external Gemini API endpoints return errors, the system automatically activates deterministic local embedding and rule-based action fallback logic (`recommendations.ts`).
- **On-Demand Priority & Severity Recalculation**: Cluster severity (`recalculateClusterSeverity`) and priority scores (`updateClusterPriorityScore`) are recalculated when complaints are added or when status queries occur, rather than via continuous background cron jobs.
- **Basic Rate Limiting**: Request rate limiting (`submitLimiter`) is currently applied only to `POST /api/complaints` via in-memory `express-rate-limit`, without a distributed cluster-wide Redis store.

---

## Technology Stack

| Layer | Technology | Implemented Purpose |
| :--- | :--- | :--- |
| **Frontend Framework** | Next.js, React, Tailwind CSS | Multi-role dashboard, App Router pages, and responsive UI components |
| **Language & Typing** | TypeScript | End-to-end type safety across backend routes, services, and frontend clients |
| **Backend API** | Node.js, Express | REST API routing, middleware orchestration, and Zod validation |
| **Relational & Vector DB** | PostgreSQL, `pgvector` (Neon) | ACID relational data storage and cosine distance (`<=>`) vector search |
| **AI Embeddings** | Gemini (`text-embedding-004`) | Semantic text vector generation (with local fallback algorithm) |
| **AI LLM Actions** | Gemini (`gemini-2.0-flash`) | Actionable municipal recommendation generation (with rule-based fallback) |
| **Security & Auth** | JWT, `bcrypt`, RBAC | Stateless authentication, password hashing, and role access verification |
| **CI/CD Automation** | GitHub Actions | Scheduled daily cron ingestion (`0 6 * * *` UTC) via `daily-ingestion.yml` |
| **Validation & Testing** | Zod, Jest (`109 tests`) | Request schema verification and automated integration/unit test suites |

---

## Project Structure

CivicMind AI strictly reflects existing filesystem structure across its backend, frontend, and database layers:

```
CivicMind/
├── backend/
│   ├── src/
│   │   ├── config/          # Database pool (db.ts), env loading, scoring weights, and seeding
│   │   ├── middleware/       # JWT authentication (authenticateToken) and RBAC guards (requireRole)
│   │   ├── routes/           # Express route controllers: auth.ts, complaints.ts, health.ts, ingest.ts
│   │   ├── services/         # Core business logic and AI processing orchestration
│   │   │   ├── embeddings.ts       # Gemini text-embedding-004 client and local fallback
│   │   │   ├── clustering.ts       # pgvector cosine distance (<=>) matching and cluster creation
│   │   │   ├── ranking.ts          # Priority scoring, urgency decay floor, and cost factor calculation
│   │   │   ├── recommendations.ts  # Gemini 2.0 Flash action generation and rule-based fallback
│   │   │   └── ingestion/          # Ingestion pipelines: newsIngestion.ts, socialIngestion.ts, common.ts, ingestionLogService.ts
│   │   └── validators/       # Zod schemas: auth.ts, complaint.ts
│   └── tests/                 # Jest integration and unit test suites across all services (`109 tests`)
├── frontend/
│   └── src/
│       ├── app/               # Next.js App Router pages (/dashboard, /login, /portal, /track)
│       ├── components/        # Reusable UI components (Navbar.tsx, IngestionHistoryPanel.tsx, DetailPanel.tsx, etc.)
│       ├── context/           # React context providers for global authentication state
│       └── lib/               # Shared TypeScript API client (api.ts)
└── migrations/                 # Sequential SQL migrations: 001_init.sql through 006_ingestion_log.sql
```

---

## Getting Started & Local Development

### Prerequisites
- **Node.js** (`v18+` recommended)
- **PostgreSQL** database with the `pgvector` extension enabled (e.g., [Neon Free Tier](https://neon.tech))
- **Gemini API Key** *(Optional)*: Obtainable via [Google AI Studio](https://aistudio.google.com/). If omitted, the platform automatically activates deterministic local and rule-based fallbacks.

### Setup Instructions

1. **Clone the Repository & Install Dependencies**
   ```bash
   git clone <your-repo-url>
   cd CivicMind
   npm run install:all
   ```

2. **Configure Environment Variables**
   ```bash
   cp backend/.env.example backend/.env
   ```
   Edit `backend/.env` and supply required variables:
   ```env
   DATABASE_URL="postgresql://user:password@endpoint.neon.tech/civicmind?sslmode=require"
   JWT_SECRET="your-super-secure-secret-key"
   GEMINI_API_KEY="your-gemini-api-key-optional"
   PORT=5000
   ```

3. **Execute Database Migrations**
   Run SQL migrations sequentially to initialize schemas, indexes, and pgvector capabilities:
   ```bash
   psql "$DATABASE_URL" -f migrations/001_init.sql
   psql "$DATABASE_URL" -f migrations/002_cluster.sql
   psql "$DATABASE_URL" -f migrations/003_recommendations.sql
   psql "$DATABASE_URL" -f migrations/004_priority_score.sql
   psql "$DATABASE_URL" -f migrations/005_auth.sql
   psql "$DATABASE_URL" -f migrations/006_ingestion_log.sql
   ```

4. **Launch Development Servers**
   ```bash
   npm run dev
   ```
   - **Frontend Dashboard**: `http://localhost:3000`
   - **Backend REST API**: `http://localhost:5000`

### Running the Test Suite
Verify end-to-end system integrity across clustering, scoring, authentication, and ingestion logging:
```bash
npm run test:backend
```
*Expected Output: `109 passed, 109 total` across 5 test suites.*

---

## Future Work

The following features represent planned architectural targets and enhancements not currently implemented:

- [ ] **NGO & Field Survey Ingestion**: Dedicated intake pipelines, webhooks, and schema parsers for structured NGO field assessment reports (`NGO Reports` and `Survey Ingestion`).
- [ ] **GIS Heat Maps**: Interactive spatial mapping and geographical clustering visualizations across municipal zones.
- [ ] **Real-Time Notifications & Webhook Engine**: Automated `SMS`, `Email`, `Push Notifications`, `WebSockets`, and outbound webhooks triggered when clusters cross high-severity thresholds (`score >= 75`).
- [ ] **Redis Caching & Distributed Rate Limiting**: In-memory Redis caching for high-traffic dashboard endpoints and distributed rate limiting across multi-instance deployments.
- [ ] **Message Queues (`RabbitMQ` / `Kafka`)**: Asynchronous ingestion buffering and queue processing to handle high-velocity data firehoses.
- [ ] **Background Workers (`BullMQ` / `Celery`)**: Dedicated background worker processes to continuously recalculate priority scores (`urgency_decay`) across all active clusters on a scheduled cadence.
- [ ] **Horizontal Scaling & Read Replicas**: Stateless backend deployments across load-balanced container instances (`AWS ALB` / `Kubernetes pods`), PostgreSQL read replicas for dashboard queries, and `CDN` distribution.
- [ ] **AI Monitoring & Observability**: Dedicated telemetry and token usage tracking for Gemini API latency, error rates, and embedding generation metrics.
- [ ] **Predictive Analytics & Mobile App**: Historical trend forecasting for municipal budgeting and dedicated native iOS/Android mobile applications for citizens and field workers.
- [ ] **Multilingual & HttpOnly Cookie Support**: Automatic multi-language translation for citizen complaints and migration from client-side token storage to `httpOnly` secure cookies.

---

## Author

Built and architected by **Durga** — Final-year B.Tech Computer Science & Engineering student.
