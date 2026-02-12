# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Full-stack TypeScript application for exploring publicly released Jeffrey Epstein case files from the U.S. Department of Justice. Browse, search, and analyze documents across 12 data sets including court filings, depositions, FBI reports, flight logs, and financial records.

## Commands

```bash
npm run dev          # Start dev server (Express + Vite HMR), runs on port 5000
npm run build        # Build client (Vite) + server (esbuild) to dist/
npm run start        # Run production build (dist/index.cjs)
npm run check        # TypeScript type checking (tsc --noEmit)
npm run db:push      # Push Drizzle schema to PostgreSQL

# Pipeline (data processing)
npx tsx scripts/pipeline/run-pipeline.ts <stage>         # Run a specific pipeline stage
npx tsx scripts/pipeline/run-pipeline.ts all             # Run all stages
npx tsx scripts/pipeline/run-pipeline.ts download-torrent --data-sets 1,3,8  # Download specific sets
```

## Architecture

### Three-layer monorepo structure

- **`client/src/`** — React 18 frontend (Vite dev server, builds to `dist/public`)
- **`server/`** — Express 5 backend (bundled with esbuild to `dist/index.cjs`)
- **`shared/`** — Shared Drizzle ORM schema and TypeScript types used by both layers

### Path aliases (tsconfig)
- `@/*` → `./client/src/*`
- `@shared/*` → `./shared/*`

### Frontend (client/src/)

- **Routing:** Wouter (lightweight, not React Router)
- **State:** TanStack React Query for server state; URL query params for filters; localStorage for bookmarks/search history
- **UI Kit:** shadcn/ui (New York style) with Radix UI primitives — components live in `client/src/components/ui/`
- **Styling:** Tailwind CSS with dark mode via class strategy
- **Visualizations:** D3.js (force-directed network graph), Recharts (charts), PDF.js (document viewer)
- **Pages:** Dashboard, Documents, Document Detail, Document Compare, People, Person Detail, Network, Timeline, Search, AI Insights

### Backend (server/)

- `routes.ts` — All API endpoints (~30 routes under `/api/`)
- `storage.ts` — Database query layer implementing `IStorage` interface (raw SQL via Drizzle)
- `db.ts` — Drizzle ORM connection pool
- `r2.ts` — Cloudflare R2 (S3-compatible) client for document storage
- `chat/` — AI chat module (DeepSeek streaming with RAG retrieval)
- In-memory caching with TTLs (5 min stats, 1 min docs, 10 min timeline/network)
- Rate limiting: 20 req/min chat, 10 req/min exports

### Database (shared/schema.ts)

PostgreSQL with Drizzle ORM. 8 tables: `persons`, `documents`, `connections`, `personDocuments`, `timelineEvents`, `pipelineJobs`, `budgetTracking`, `users`, plus `bookmarks` and `conversations` for user features. Schema changes go through `shared/schema.ts` then `npm run db:push`.

### Data Pipeline (scripts/pipeline/)

Multi-stage pipeline orchestrated by `run-pipeline.ts`: scrape → download (aria2 torrents) → import → upload to R2 → extract text → classify media → AI analysis (DeepSeek) → load entities to DB → extract connections → dedup persons. Uses `commander` for CLI, `p-limit`/`p-retry` for concurrency, and tracks AI costs via `budgetTracking` table.

## Environment Variables

Required: `DATABASE_URL`, `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET_NAME`, `R2_PUBLIC_URL`, `DEEPSEEK_API_KEY`

## Deployment

Fly.io (`fly.toml`): region `iad`, port 5000, 512MB RAM, multi-stage Docker build (Node 20 slim). CI via GitHub Actions on push to main (`flyctl deploy --local-only`).
