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

# Pipeline shortcuts
npx tsx scripts/pipeline/run-pipeline.ts quick            # Scrape + load + extract + count
npx tsx scripts/pipeline/run-pipeline.ts full-discovery   # All stages except dedup
npx tsx scripts/pipeline/run-pipeline.ts analyze-priority # classify → analyze → load → count

# Pipeline options
#   --data-sets 1,2,3    Filter specific datasets
#   --max-process 50     Limit files per stage
#   --budget 500         AI cost cap (cents)
#   --priority 1-5       Minimum AI priority level
#   --concurrency 4      Parallel operations
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

- **Routing:** Wouter (not React Router). Uses `<Switch>`/`<Route>`, `useLocation()` returns `[location, setLocation]`
- **State:** TanStack React Query for server state; URL query params for filters via `useUrlFilters()` hook; localStorage for bookmarks/search history
- **UI Kit:** shadcn/ui (New York style) with Radix UI primitives in `client/src/components/ui/`
- **Styling:** Tailwind CSS with dark mode via class strategy. Custom elevation utilities (`.hover-elevate`, `.active-elevate`) in `index.css`
- **Visualizations:** D3.js (force-directed network graph), Recharts (charts), PDF.js (document viewer)
- **Icons:** lucide-react throughout

#### Key frontend patterns

- **React Query config** (`client/src/lib/queryClient.ts`): `staleTime: Infinity` globally (data never auto-refetches). Individual queries override with shorter stale times (60s–300s). `retry: false`, no refetch on window focus. Query keys match API paths: `["/api/documents"]`, `["/api/persons", id]`
- **`apiRequest()` helper**: Wraps fetch with `credentials: 'include'` and error handling. Used for mutations
- **`useUrlFilters()` hook** (`client/src/hooks/use-url-filters.ts`): Syncs filter state with URL search params via `window.history.replaceState()`. Used by documents, people, timeline, and network pages for shareable/bookmarkable filter state
- **Keyboard shortcuts** (`client/src/hooks/use-keyboard-shortcuts.ts`): `/` or `Cmd+K` for search, `?` for help, `g+key` for navigation (g+p=people, g+d=docs, g+t=timeline, g+n=network, g+h=home)
- **PDF viewer fallback chain**: proxy endpoint → sourceUrl → presigned R2 URL in iframe

### Backend (server/)

- `routes.ts` — All API endpoints (~30 routes under `/api/`)
- `storage.ts` — Database query layer implementing `IStorage` interface with multi-tier caching
- `db.ts` — Drizzle ORM connection pool (max 10 connections, 30s idle timeout)
- `r2.ts` — Cloudflare R2 (S3-compatible) client for document storage
- `chat/` — AI chat module (DeepSeek streaming via SSE with RAG retrieval)
- Rate limiting: 20 req/min chat, 10 req/min exports (in-memory, per-IP)

#### Server-side caching (storage.ts)

Multi-tier in-memory caching with inflight deduplication (concurrent requests share one fetch):
- **Aggregate caches (5min):** stats, sidebarCounts, persons, timelineEvents, networkData
- **Document filters (10min):** types, datasets, mediatypes
- **Detail caches (5min, LRU max=500):** individual person/document lookups
- **Search results (1min, LRU max=100):** per-query caching
- **Cache pre-warming:** On startup, fetches stats, sidebar counts, filters, persons, timeline, and first page of documents

#### R2 production filtering

In production (R2 configured), only documents with an `r2Key` are returned from queries. Documents with 0 bytes are always excluded. This is enforced by `r2Filter()` in storage.ts.

#### Document content serving

- `GET /api/documents/:id/content-url` — Presigned R2 URL (1hr expiry, clamped 60s–7200s)
- `GET /api/documents/:id/pdf` — PDF proxy with 100MB streaming limit
- `GET /api/documents/:id/video` — Video proxy with HTTP 206 range request support
- Response fields `localPath`, `r2Key`, `fileHash` are stripped from client responses via `omitInternal()`

### Database (shared/schema.ts)

PostgreSQL with Drizzle ORM. Tables: `persons`, `documents`, `connections`, `personDocuments`, `timelineEvents`, `pipelineJobs`, `budgetTracking`, `users`, `bookmarks`, `conversations`, `messages`. Schema changes go through `shared/schema.ts` then `npm run db:push`.

Key indexes: `idx_documents_processing_status`, `idx_documents_media_type`, `idx_persons_document_count`. Types are inferred via `$inferSelect`/`$inferInsert` and validated with drizzle-zod `createInsertSchema()`.

### Data Pipeline (scripts/pipeline/)

Multi-stage pipeline orchestrated by `run-pipeline.ts` with 13 stages:
1. `scrape-wikipedia` → `download-torrent` (aria2) → `upload-r2` → `process` (text extraction)
2. `classify-media` → `analyze-ai` (DeepSeek, two-tier: free rule-based + paid LLM)
3. `load-persons` → `load-documents` → `import-downloads` → `load-ai-results`
4. `extract-connections` → `update-counts` → `dedup-persons` (4-pass cleanup)

AI analysis uses DeepSeek (`deepseek-chat`) with budget tracking. Documents >200 chars are chunked at 24KB boundaries. Tier 0 (free) uses regex patterns for classification; Tier 1 calls DeepSeek for entity/connection/event extraction.

Person deduplication in `db-loader.ts` uses multiple matching strategies: exact normalized, spaceless (OCR errors), sorted parts, edit distance ≤ 2, nickname resolution (60+ mappings), and alias matching.

## Build System

The build (`script/build.ts`) uses an allowlist approach for esbuild server bundling — only 33 critical packages are bundled to reduce cold-start syscalls; all others stay external. Client builds via Vite to `dist/public/`, server bundles to `dist/index.cjs` (CommonJS, minified).

Dev mode: Express with tsx + Vite HMR middleware. Production: `serveStatic()` serves built client files.

## Environment Variables

Required: `DATABASE_URL`, `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET_NAME`, `R2_PUBLIC_URL`, `DEEPSEEK_API_KEY`

## Deployment

Fly.io (`fly.toml`): region `iad`, port 5000, 512MB RAM, multi-stage Docker build (Node 20 slim). CI via GitHub Actions on push to main (`flyctl deploy --local-only`). Docker uses 3 stages: deps → build → production (only dist/ and data/ai-analyzed/ copied to final image).
