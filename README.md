# CivicMind AI

**Helping governments and NGOs discover community problems before they become crises.**

CivicMind AI ingests citizen complaints, social media reports, and news data, then uses AI to cluster related issues, score severity, rank priority, and generate recommended actions — all surfaced on a real-time dashboard for officials and NGOs.

![Dashboard Screenshot](./screenshots/dashboard.png)
<!-- Replace with an actual screenshot or GIF of your dashboard, e.g. ./screenshots/dashboard-demo.gif -->

---

## Live Demo

> Add your deployed link here once hosted (e.g. Vercel + Render/Railway).

---

## Problem It Solves

Citizens report civic problems through many disconnected channels — complaint portals, social media, surveys, NGO field reports, and news. On their own, these signals are scattered, repetitive, and hard to prioritize manually. CivicMind AI unifies them into one pipeline that automatically:

- Clusters semantically similar reports (e.g. "no water," "pipe burst," "tanker not coming" → one **Water Supply Issue** cluster)
- Scores severity based on volume, growth rate, category criticality, and affected population
- Ranks clusters by priority so limited government resources go where they matter most
- Generates a concrete recommended action per cluster using an LLM
- Notifies officials when an issue crosses a severity threshold

---

## Architecture

```
Citizen Portal ──┐
Social Media ─────┼──► Ingestion API ──► NLP/Embedding ──► Vector Clustering ──► Severity Scoring
News RSS ─────────┘                                              │                    │
                                                                  ▼                    ▼
                                                          Priority Ranking ──► LLM Recommended Actions
                                                                  │
                                                                  ▼
                                                     PostgreSQL + pgvector (persistence)
                                                                  │
                                                                  ▼
                                                        Backend API (Express + JWT Auth)
                                                                  │
                                                                  ▼
                                                    Next.js Dashboard (Govt / NGO / Admin)
```

**End-to-end flow:**
1. A complaint/report enters through the citizen portal, a simulated social feed, or a news RSS pull.
2. Text is cleaned and converted into a vector embedding (Gemini API, with a deterministic local fallback if no API key is present).
3. The embedding is compared via cosine similarity against existing open clusters (pgvector `<=>` operator). It either attaches to a matching cluster or creates a new one.
4. Severity is recalculated using a weighted formula (volume, 7-day growth rate, category criticality, estimated affected population, historical resolution speed).
5. Priority score combines severity with urgency decay and resource-cost factors, so clusters are ranked realistically — not just by raw severity.
6. When a cluster is new or escalates into a higher severity band, an LLM call generates a recommended action (with a rule-based fallback if the LLM call fails or no API key is set).
7. Everything is served through a JWT-authenticated API to a role-gated dashboard (Citizen / NGO / Govt Official / Admin).

---

## Tech Stack

| Layer | Technology |
|---|---|
| Frontend | Next.js, React, Tailwind CSS, TypeScript |
| Backend | Node.js, Express, TypeScript |
| Database | PostgreSQL + `pgvector` extension (hosted on Neon) |
| Auth | JWT (in-memory token storage), bcrypt password hashing, role-based access control |
| Embeddings / LLM | Gemini API (`text-embedding-004` for embeddings, `gemini-2.0-flash` for recommended actions), with deterministic/rule-based fallbacks when no API key is configured |
| Clustering | Cosine similarity over vector embeddings via `pgvector` |
| Validation | Zod (both frontend and backend schema validation) |
| Testing | Jest — 90+ unit/integration tests across clustering, scoring, auth, and API routes |
| Ingestion | Citizen portal (live), News RSS (live), Social media (simulated dataset) |

---

## Core Features

- **Multi-source ingestion** — citizen complaint portal, news RSS feeds, and a simulated social media feed, all normalized into a single pipeline
- **Semantic clustering** — groups differently-worded reports about the same underlying issue using vector similarity, not keyword matching
- **Rule-based severity scoring** — transparent, tunable formula rather than an opaque black-box model, so officials can trust and audit the ranking
- **Priority ranking** — severity combined with urgency decay (old critical issues don't silently disappear) and resource-cost weighting
- **LLM-generated recommended actions** — with full history/versioning per cluster, and automatic fallback if the LLM is unavailable
- **Role-based dashboard** — Citizens submit and track; NGOs and Govt Officials review, act, and resolve; Admins manage the system
- **Real authentication** — JWT-based login/register with bcrypt password hashing and protected routes

---

## Project Structure

```
CivicMind/
├── backend/
│   ├── src/
│   │   ├── config/          # env validation, DB pool, seeding, scoring weights
│   │   ├── middleware/       # JWT auth, role guards
│   │   ├── routes/           # complaints, clusters, auth endpoints
│   │   ├── services/         # embeddings, clustering, ranking, recommendations, ingestion
│   │   └── validators/       # Zod schemas
│   └── tests/                 # Jest test suites
├── frontend/
│   └── src/
│       ├── app/               # login, portal, dashboard, track pages
│       ├── components/        # Navbar, filter bar, detail panel
│       ├── context/           # Auth + app state
│       └── lib/               # API client
└── migrations/                 # SQL migrations (init, clustering/pgvector, recommendations, priority score, auth)
```

---

## Getting Started

### Prerequisites
- Node.js
- A PostgreSQL database with the `pgvector` extension available (e.g. [Neon](https://neon.tech) — free tier, pgvector pre-enabled)
- (Optional) A [Gemini API key](https://aistudio.google.com/) for real embeddings/LLM actions — the app falls back to deterministic/rule-based logic if omitted

### Setup

```bash
# Clone and install
git clone <your-repo-url>
cd CivicMind
npm run install:all

# Configure environment
cp backend/.env.example backend/.env
# Fill in DATABASE_URL, GEMINI_API_KEY (optional), JWT_SECRET

# Run migrations, in order
psql "$DATABASE_URL" -f migrations/001_init.sql
psql "$DATABASE_URL" -f migrations/002_cluster.sql
psql "$DATABASE_URL" -f migrations/003_recommendations.sql
psql "$DATABASE_URL" -f migrations/004_priority_score.sql
psql "$DATABASE_URL" -f migrations/005_auth.sql

# Run both frontend and backend
npm run dev
```

Visit `http://localhost:3000`.

### Running Tests

```bash
npm run test:backend
```

---

## Roadmap / Future Work

- [ ] Survey and NGO report ingestion pipelines
- [ ] Scheduled ingestion via GitHub Actions cron (currently manual trigger)
- [ ] Cron-based priority score decay recalculation (currently recalculated on read)
- [ ] Notification/alerting system for high-severity clusters
- [ ] Persistent (httpOnly cookie) auth session option

---

## Author

Built by Durga — final-year B.Tech CSE student.
