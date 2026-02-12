# NEXUS — Enterprise Legal RAG Architecture Plan

## Context

Building an enterprise legal RAG application for law firms handling class action suits. Users need to ingest large document collections, extract entities/relationships via AI, search semantically ("find communications suggesting awareness of contamination"), and get cited answers from an "Ask the Evidence" chat interface — all with RBAC, audit logging, and privilege tagging.

This plan borrows proven patterns from the Epstein File Explorer (entity extraction pipeline, deduplication, schema design) and replaces every weak point (keyword-only search, no embeddings, single-user, no temporal data on relationships) with production-grade alternatives.

**Stack:** FastAPI + Python backend, React + TypeScript frontend, PostgreSQL + pgvector, DeepSeek for batch extraction, Claude for chat synthesis.

---

## Architecture Overview

```
                OFFLINE (Pipeline)                           ONLINE (App)

Documents ──→ PyMuPDF text extraction              User searches / asks questions
    │              │                                        │
    │              ▼                                        ▼
    │     Chunking (512 tokens, 64 overlap)        Hybrid retrieval:
    │         │              │                     ├─ pgvector cosine similarity
    │         ▼              ▼                     ├─ PostgreSQL tsvector/tsquery
    │    Embeddings    DeepSeek extraction          ├─ SQL filters (date, person, type, privilege)
    │    (OpenAI)      (entities, relationships)    └─ Reciprocal Rank Fusion
    │         │              │                              │
    │         ▼              ▼                              ▼
    └──→ PostgreSQL ◄──────────────────────────── Claude synthesizes answer
         ├─ document_chunks (pgvector)                with [Doc #ID] citations
         ├─ persons, connections (relational)              │
         ├─ timeline_events                                ▼
         └─ audit_log                              SSE streaming to React UI
```

**How this differs from the Epstein File Explorer repo:**

| Epstein File Explorer | NEXUS |
|---|---|
| Keyword ILIKE search only | pgvector semantic + tsvector keyword + SQL filters |
| No embeddings | OpenAI text-embedding-3-small → pgvector HNSW index |
| No dates on connections | `date_from`/`date_to` on connections table |
| Single user, no auth | JWT + RBAC (admin, attorney, paralegal, reviewer) |
| In-memory caching | Redis |
| CLI pipeline scripts | Celery task queue with retries and monitoring |
| pdf.js text extraction (no OCR) | PyMuPDF + pytesseract OCR fallback |
| DeepSeek for chat | Claude for chat (better reasoning), DeepSeek for batch (cheaper) |
| File-based AI results | Database-stored with pipeline job tracking |

---

## How DeepSeek Is Used in the Epstein Repo (Analysis)

The Epstein File Explorer uses DeepSeek in two completely separate roles:

### Role 1: Batch Document Analysis Pipeline (offline)

DeepSeek processes documents **offline** in a 13-stage pipeline, NOT at query time. It acts as a **structured data extraction engine** — reads each document once and outputs JSON with persons, connections, events, locations, key facts, and summaries. These are loaded into PostgreSQL tables that power the entire UI.

**Two-tier system:**
- **Tier 0 (free):** Regex pattern matching — classifies doc types, detects 40+ hardcoded known persons, extracts dates/locations
- **Tier 1 (paid, ~$0.003/doc):** DeepSeek API (`deepseek-chat`) — sends text in 24KB chunks with a structured extraction prompt, returns JSON

### Role 2: Chat / "Ask the Archive" (currently disabled)

The chat retrieval is **not vector-based** — it's pure keyword matching:
1. Tokenize query, remove stopwords
2. SQL `ILIKE` against persons, documents, events tables
3. `String.includes()` against AI analysis JSON files on disk
4. Concatenate up to 20K chars of context
5. Send to DeepSeek for answer synthesis

**Key limitation:** No semantic understanding. "Who visited the island?" won't match documents saying "flew to Little St. James" because they share no keywords.

### How OCR Was Accomplished

It wasn't real OCR. The project uses `pdfjs-dist` to extract **embedded text layers** from PDFs (`page.getTextContent()`). Scanned image PDFs with no text layer return empty strings. The DOJ-released PDFs have embedded text from DOJ digitization, which is why this works.

---

## Directory Structure

```
nexus/
├── client/                            # React + TypeScript + Vite
│   ├── src/
│   │   ├── components/
│   │   │   ├── ui/                    # shadcn/ui (reuse Epstein pattern)
│   │   │   ├── chat-panel.tsx         # RAG chat with streaming + citations
│   │   │   ├── search-bar.tsx         # Hybrid search with filter sidebar
│   │   │   ├── document-viewer.tsx    # PDF viewer with annotation overlay
│   │   │   ├── annotation-layer.tsx   # Highlight/note overlay on PDFs
│   │   │   └── privilege-badge.tsx
│   │   ├── hooks/
│   │   │   ├── use-url-filters.ts     # Port from Epstein repo
│   │   │   ├── use-chat.ts            # SSE streaming hook
│   │   │   └── use-auth.ts
│   │   ├── pages/
│   │   │   ├── dashboard.tsx
│   │   │   ├── documents.tsx
│   │   │   ├── search.tsx             # Hybrid search results
│   │   │   ├── chat.tsx               # "Ask the Evidence"
│   │   │   ├── people.tsx
│   │   │   ├── admin/
│   │   │   │   ├── users.tsx
│   │   │   │   ├── audit-log.tsx
│   │   │   │   └── pipeline.tsx       # Pipeline monitoring
│   │   │   └── exports.tsx
│   │   └── lib/
│   │       ├── api.ts                 # API client (port apiRequest() pattern)
│   │       └── query-client.ts
│   └── vite.config.ts
│
├── server/                            # FastAPI + Python
│   ├── main.py                        # FastAPI app + middleware
│   ├── config.py                      # Pydantic BaseSettings
│   ├── db/
│   │   ├── session.py                 # SQLAlchemy async engine
│   │   ├── models.py                  # ORM models
│   │   └── migrations/               # Alembic
│   ├── api/
│   │   ├── deps.py                    # Dependency injection (auth, db)
│   │   ├── documents.py
│   │   ├── search.py                  # Hybrid search endpoint
│   │   ├── chat.py                    # RAG chat with SSE
│   │   ├── persons.py
│   │   ├── annotations.py
│   │   ├── admin.py
│   │   ├── exports.py
│   │   └── auth.py                    # JWT + RBAC
│   ├── services/
│   │   ├── retrieval.py               # Hybrid retrieval (vector + FTS + filters)
│   │   ├── embedding.py               # Embedding generation
│   │   ├── llm.py                     # LLM abstraction (DeepSeek, Claude)
│   │   ├── entity_extraction.py       # Two-tier extraction (port from Epstein)
│   │   └── deduplication.py           # Entity dedup (port from Epstein)
│   ├── pipeline/
│   │   ├── tasks.py                   # Celery task definitions
│   │   ├── ingest.py                  # Upload + S3 storage
│   │   ├── extract_text.py            # PyMuPDF + OCR fallback
│   │   ├── chunk.py                   # Recursive text splitting
│   │   ├── embed.py                   # Batch embedding generation
│   │   ├── analyze.py                 # Two-tier entity extraction
│   │   ├── load_entities.py           # Load structured data to DB
│   │   └── deduplicate.py             # 4-pass entity dedup
│   └── middleware/
│       ├── audit.py                   # Audit logging
│       └── rate_limit.py
│
├── docker-compose.yml                 # Postgres+pgvector + Redis
├── pyproject.toml
└── Dockerfile
```

---

## Schema Design

### Core tables (key fields only)

```sql
CREATE EXTENSION IF NOT EXISTS vector;

-- Auth
CREATE TABLE roles (
    id          SERIAL PRIMARY KEY,
    name        TEXT NOT NULL UNIQUE,  -- 'admin', 'attorney', 'paralegal', 'reviewer'
    permissions JSONB NOT NULL DEFAULT '[]',
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE users (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email           TEXT NOT NULL UNIQUE,
    password_hash   TEXT NOT NULL,
    full_name       TEXT NOT NULL,
    role_id         INTEGER NOT NULL REFERENCES roles(id),
    is_active       BOOLEAN NOT NULL DEFAULT TRUE,
    last_login_at   TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Multi-tenancy
CREATE TABLE case_matters (
    id          SERIAL PRIMARY KEY,
    name        TEXT NOT NULL,          -- "Doe v. Acme Corp"
    description TEXT,
    status      TEXT NOT NULL DEFAULT 'active',
    created_by  UUID REFERENCES users(id),
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE user_case_matters (
    user_id     UUID NOT NULL REFERENCES users(id),
    matter_id   INTEGER NOT NULL REFERENCES case_matters(id),
    PRIMARY KEY (user_id, matter_id)
);

-- Documents
CREATE TABLE documents (
    id                  SERIAL PRIMARY KEY,
    matter_id           INTEGER NOT NULL REFERENCES case_matters(id),
    title               TEXT NOT NULL,
    description         TEXT,
    document_type       TEXT NOT NULL,
    source              TEXT,
    date_published      DATE,
    date_original       DATE,
    page_count          INTEGER,
    is_redacted         BOOLEAN DEFAULT FALSE,
    key_excerpt         TEXT,
    tags                TEXT[],
    media_type          TEXT,
    file_size_bytes     BIGINT,
    file_hash           TEXT,            -- SHA-256 for dedup
    s3_key              TEXT,
    extracted_text      TEXT,
    extracted_text_len  INTEGER DEFAULT 0,
    processing_status   TEXT NOT NULL DEFAULT 'pending',
    ai_analysis_status  TEXT NOT NULL DEFAULT 'pending',
    ai_cost_cents       INTEGER DEFAULT 0,
    privilege_status    TEXT NOT NULL DEFAULT 'none',
    privilege_reviewed_by UUID REFERENCES users(id),
    privilege_reviewed_at TIMESTAMPTZ,
    uploaded_by         UUID REFERENCES users(id),
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_documents_matter_id ON documents(matter_id);
CREATE INDEX idx_documents_processing_status ON documents(processing_status);
CREATE INDEX idx_documents_document_type ON documents(document_type);
CREATE INDEX idx_documents_privilege_status ON documents(privilege_status);
CREATE INDEX idx_documents_date_original ON documents(date_original);
CREATE INDEX idx_documents_file_hash ON documents(file_hash);

-- Full-text search on title/description/excerpt
ALTER TABLE documents ADD COLUMN tsv tsvector
    GENERATED ALWAYS AS (
        to_tsvector('english', coalesce(title, '') || ' ' || coalesce(description, '') || ' ' || coalesce(key_excerpt, ''))
    ) STORED;
CREATE INDEX idx_documents_tsv ON documents USING GIN(tsv);

-- Chunks with embeddings (the vector store)
CREATE TABLE document_chunks (
    id              SERIAL PRIMARY KEY,
    document_id     INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    chunk_index     INTEGER NOT NULL,
    content         TEXT NOT NULL,
    char_offset     INTEGER NOT NULL,
    char_length     INTEGER NOT NULL,
    page_start      INTEGER,
    page_end        INTEGER,
    embedding       vector(1536),     -- OpenAI text-embedding-3-small
    token_count     INTEGER,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(document_id, chunk_index)
);

CREATE INDEX idx_chunks_embedding ON document_chunks
    USING hnsw (embedding vector_cosine_ops)
    WITH (m = 16, ef_construction = 64);
CREATE INDEX idx_chunks_document_id ON document_chunks(document_id);

ALTER TABLE document_chunks ADD COLUMN tsv tsvector
    GENERATED ALWAYS AS (to_tsvector('english', content)) STORED;
CREATE INDEX idx_chunks_tsv ON document_chunks USING GIN(tsv);

-- Entities
CREATE TABLE persons (
    id                  SERIAL PRIMARY KEY,
    matter_id           INTEGER NOT NULL REFERENCES case_matters(id),
    name                TEXT NOT NULL,
    normalized_name     TEXT NOT NULL,
    aliases             TEXT[],
    role                TEXT NOT NULL DEFAULT 'named individual',
    description         TEXT,
    category            TEXT NOT NULL DEFAULT 'other',
    occupation          TEXT,
    document_count      INTEGER NOT NULL DEFAULT 0,
    connection_count    INTEGER NOT NULL DEFAULT 0,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_persons_matter_id ON persons(matter_id);
CREATE INDEX idx_persons_normalized_name ON persons(normalized_name);
CREATE INDEX idx_persons_document_count ON persons(document_count DESC);

-- Connections WITH TEMPORAL FIELDS (critical gap in Epstein repo)
CREATE TABLE connections (
    id                  SERIAL PRIMARY KEY,
    person_id_1         INTEGER NOT NULL REFERENCES persons(id) ON DELETE CASCADE,
    person_id_2         INTEGER NOT NULL REFERENCES persons(id) ON DELETE CASCADE,
    connection_type     TEXT NOT NULL,
    description         TEXT,
    strength            INTEGER NOT NULL DEFAULT 1 CHECK (strength BETWEEN 1 AND 5),
    date_from           DATE,            -- enables "connections between X and Y from 2005-2010"
    date_to             DATE,
    document_ids        INTEGER[],
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CHECK (person_id_1 < person_id_2)   -- canonical ordering prevents dupes
);

CREATE INDEX idx_connections_person1 ON connections(person_id_1);
CREATE INDEX idx_connections_person2 ON connections(person_id_2);
CREATE INDEX idx_connections_date_range ON connections(date_from, date_to);

CREATE TABLE person_documents (
    id              SERIAL PRIMARY KEY,
    person_id       INTEGER NOT NULL REFERENCES persons(id) ON DELETE CASCADE,
    document_id     INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    context         TEXT,
    mention_type    TEXT NOT NULL DEFAULT 'mentioned',
    page_number     INTEGER,
    UNIQUE(person_id, document_id, mention_type)
);

CREATE INDEX idx_person_documents_person ON person_documents(person_id);
CREATE INDEX idx_person_documents_document ON person_documents(document_id);

-- Timeline Events
CREATE TABLE timeline_events (
    id              SERIAL PRIMARY KEY,
    matter_id       INTEGER NOT NULL REFERENCES case_matters(id),
    event_date      DATE NOT NULL,
    date_precision  TEXT DEFAULT 'day',
    title           TEXT NOT NULL,
    description     TEXT NOT NULL,
    category        TEXT NOT NULL,
    person_ids      INTEGER[],
    document_ids    INTEGER[],
    significance    INTEGER NOT NULL DEFAULT 1 CHECK (significance BETWEEN 1 AND 5),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_timeline_events_date ON timeline_events(event_date);
CREATE INDEX idx_timeline_events_matter ON timeline_events(matter_id);

-- Audit Log
CREATE TABLE audit_log (
    id              BIGSERIAL PRIMARY KEY,
    user_id         UUID NOT NULL REFERENCES users(id),
    action          TEXT NOT NULL,
    resource_type   TEXT,
    resource_id     TEXT,
    metadata        JSONB,
    ip_address      INET,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_audit_log_user ON audit_log(user_id, created_at DESC);
CREATE INDEX idx_audit_log_action ON audit_log(action, created_at DESC);

-- Annotations
CREATE TABLE annotations (
    id              SERIAL PRIMARY KEY,
    document_id     INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    user_id         UUID NOT NULL REFERENCES users(id),
    annotation_type TEXT NOT NULL DEFAULT 'highlight',
    content         TEXT,
    page_number     INTEGER,
    start_offset    INTEGER,
    end_offset      INTEGER,
    color           TEXT DEFAULT '#FFEB3B',
    is_shared       BOOLEAN DEFAULT FALSE,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_annotations_document ON annotations(document_id);

-- Chat
CREATE TABLE conversations (
    id              SERIAL PRIMARY KEY,
    matter_id       INTEGER NOT NULL REFERENCES case_matters(id),
    user_id         UUID NOT NULL REFERENCES users(id),
    title           TEXT NOT NULL DEFAULT 'New Chat',
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE messages (
    id              SERIAL PRIMARY KEY,
    conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    role            TEXT NOT NULL,
    content         TEXT NOT NULL,
    citations       JSONB,
    retrieval_metadata JSONB,
    token_count     INTEGER,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Pipeline tracking
CREATE TABLE pipeline_jobs (
    id              SERIAL PRIMARY KEY,
    document_id     INTEGER REFERENCES documents(id),
    job_type        TEXT NOT NULL,
    status          TEXT NOT NULL DEFAULT 'pending',
    priority        INTEGER NOT NULL DEFAULT 0,
    attempts        INTEGER NOT NULL DEFAULT 0,
    max_attempts    INTEGER NOT NULL DEFAULT 3,
    error_message   TEXT,
    metadata        JSONB,
    celery_task_id  TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    started_at      TIMESTAMPTZ,
    completed_at    TIMESTAMPTZ
);

CREATE TABLE budget_tracking (
    id              SERIAL PRIMARY KEY,
    date            DATE NOT NULL,
    model           TEXT NOT NULL,
    input_tokens    INTEGER NOT NULL DEFAULT 0,
    output_tokens   INTEGER NOT NULL DEFAULT 0,
    cost_cents      INTEGER NOT NULL DEFAULT 0,
    document_id     INTEGER REFERENCES documents(id),
    job_type        TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

---

## Document Pipeline (7 Stages)

Modeled after Epstein repo's pipeline but using Celery tasks instead of CLI scripts.

| Stage | File | What it does | Ported from Epstein? |
|-------|------|-------------|---------------------|
| 1. Ingest | `pipeline/ingest.py` | Upload → SHA-256 dedup → S3 → create document row | New |
| 2. Extract text | `pipeline/extract_text.py` | PyMuPDF text extraction + pytesseract OCR fallback for scanned PDFs | Port `pdf-processor.ts`, add real OCR |
| 3. Chunk | `pipeline/chunk.py` | RecursiveCharacterTextSplitter (512 tokens, 64 overlap) → `document_chunks` rows | New (Epstein only chunks for LLM input, not for retrieval) |
| 4. Embed | `pipeline/embed.py` | OpenAI text-embedding-3-small in batches of 100 → pgvector | New (Epstein has no embeddings) |
| 5. Analyze | `pipeline/analyze.py` | Tier 0: regex entity/type classification. Tier 1: DeepSeek structured extraction | **Port** `ai-analyzer.ts` two-tier pattern |
| 6. Load entities | `pipeline/load_entities.py` | Parse AI results → persons, connections, timeline_events, person_documents | **Port** `db-loader.ts` `loadAIResults()` |
| 7. Deduplicate | `pipeline/deduplicate.py` | 4-pass entity dedup (junk removal, union-find, single-word merge, nicknames) | **Port** `db-loader.ts` `deduplicatePersonsInDB()` |

### Text extraction with OCR fallback (Stage 2)

The Epstein repo uses pdf.js which only reads embedded text. NEXUS adds OCR fallback:

```python
import fitz  # PyMuPDF
import pytesseract
from PIL import Image

def extract_text(pdf_bytes: bytes) -> list[PageText]:
    doc = fitz.open(stream=pdf_bytes, filetype="pdf")
    pages = []
    for page in doc:
        text = page.get_text("text")
        # OCR fallback: if < 50 chars per page, it's likely a scanned image
        if len(text.strip()) < 50:
            pix = page.get_pixmap(dpi=300)
            img = Image.frombytes("RGB", [pix.width, pix.height], pix.samples)
            text = pytesseract.image_to_string(img)
        pages.append(PageText(page_num=page.number + 1, text=text))
    return pages
```

### Two-tier AI analysis (Stage 5)

Direct port from `scripts/pipeline/ai-analyzer.ts`:

**Tier 0 (free):** Regex patterns classify document types (`flight\s+log`, `deposition`, `grand\s+jury`, etc.), detect known persons via case-insensitive matching, extract dates and locations. Zero API cost.

**Tier 1 (DeepSeek, ~$0.003/doc):** Sends extracted text in 24KB chunks to `deepseek-chat` (temp=0.1) with a structured prompt requesting: persons (name, role, category), connections (person pairs, type, strength), events (date, title, significance), locations, and key facts as JSON.

For NEXUS, the extraction prompt should be **generalized** (remove Epstein-specific references) and made **configurable per case matter**. The hardcoded known persons list should be replaced with a per-matter entity dictionary loaded from the database.

---

## RAG Retrieval Algorithm

The core upgrade over the Epstein repo's keyword-only retrieval. Lives in `server/services/retrieval.py`.

```python
async def hybrid_retrieve(
    query: str,
    matter_id: int,
    user: User,
    filters: SearchFilters,  # date_range, person_ids, doc_types, privilege_allowed
    top_k: int = 20,
    alpha: float = 0.7,     # 70% semantic, 30% keyword
) -> RetrievalResult:

    # 1. Embed the query
    query_embedding = await embed_query(query)  # text-embedding-3-small

    # 2. Vector similarity search (pgvector cosine distance)
    #    WITH SQL filters: matter_id, privilege_status, date_range, doc_type
    vector_results = await db.execute("""
        SELECT dc.id, dc.content, d.title, d.id as doc_id,
               1 - (dc.embedding <=> :query_vec) AS semantic_score
        FROM document_chunks dc
        JOIN documents d ON d.id = dc.document_id
        WHERE d.matter_id = :matter_id
          AND d.privilege_status = ANY(:allowed_privileges)
          AND (:date_from IS NULL OR d.date_original >= :date_from)
          AND (:date_to IS NULL OR d.date_original <= :date_to)
        ORDER BY dc.embedding <=> :query_vec
        LIMIT :limit
    """)

    # 3. Full-text keyword search (PostgreSQL tsvector)
    keyword_results = await db.execute("""
        SELECT dc.id, dc.content, d.title,
               ts_rank_cd(dc.tsv, websearch_to_tsquery('english', :query)) AS kw_score
        FROM document_chunks dc
        JOIN documents d ON d.id = dc.document_id
        WHERE dc.tsv @@ websearch_to_tsquery('english', :query)
          AND d.matter_id = :matter_id
          AND d.privilege_status = ANY(:allowed_privileges)
        ORDER BY kw_score DESC
        LIMIT :limit
    """)

    # 4. Reciprocal Rank Fusion (merge semantic + keyword results)
    k = 60  # RRF constant
    scores = {}
    for rank, row in enumerate(vector_results):
        scores[row.id] = alpha * (1 / (k + rank + 1))
    for rank, row in enumerate(keyword_results):
        scores[row.id] = scores.get(row.id, 0) + (1 - alpha) * (1 / (k + rank + 1))

    # 5. Take top_k, assemble context with citation tracking
    top_chunks = sorted(scores, key=scores.get, reverse=True)[:top_k]
    context = assemble_context_with_citations(top_chunks)

    # 6. Also fetch matched persons via entity links
    matched_persons = await find_persons_in_chunks(top_chunks, matter_id)

    return RetrievalResult(context=context, citations=citations, persons=matched_persons)
```

### Privilege filtering

Enforced at the SQL level — privileged documents never appear in results for unauthorized users:

```python
def get_allowed_privileges(user: User) -> list[str]:
    if "privileged:read" in user.permissions:
        return ["none", "attorney_client", "work_product", "confidential", "under_review"]
    return ["none"]
```

### Why this answers the lawyer's questions

- **"Find communications suggesting awareness of contamination"** → vector search matches "knew about the spill", "internal memo re: water quality concerns"
- **"Between 2005-2010"** → SQL `date_original` filter applied before vector search
- **"Connected to defendant X"** → join through person_documents + connections tables
- **Privilege-tagged documents** automatically excluded for unauthorized users at the SQL level

---

## API Endpoints

```
# Authentication
POST   /api/auth/login                          # JWT token issuance
POST   /api/auth/refresh                        # Token refresh
GET    /api/auth/me                             # Current user profile

# Documents
GET    /api/documents?page&limit&search&type&date_from&date_to&privilege
POST   /api/documents/upload                     # Multipart, triggers pipeline
GET    /api/documents/:id
PATCH  /api/documents/:id                        # Metadata, privilege tagging
GET    /api/documents/:id/content-url            # Presigned S3 URL
GET    /api/documents/:id/chunks

# Search
POST   /api/search                               # Hybrid vector + keyword + filters
GET    /api/search/suggest                        # Autocomplete

# Chat (RAG)
GET    /api/chat/conversations
POST   /api/chat/conversations
POST   /api/chat/conversations/:id/messages       # SSE streaming response

# Persons/Entities
GET    /api/persons?page&limit&category
GET    /api/persons/:id                           # With connections + documents
POST   /api/persons/merge                         # Manual dedup

# Annotations
GET    /api/documents/:id/annotations
POST   /api/documents/:id/annotations
PATCH  /api/annotations/:id
DELETE /api/annotations/:id

# Admin
GET    /api/admin/users
POST   /api/admin/users
PATCH  /api/admin/users/:id
GET    /api/admin/audit-log?user&action&date_from&date_to
GET    /api/admin/pipeline/status
POST   /api/admin/pipeline/run
GET    /api/admin/budget

# Export
POST   /api/exports                               # Court-ready document packages
GET    /api/exports/:id
```

---

## What to Port from Epstein File Explorer

| NEXUS Component | Epstein Source File | What to port |
|---|---|---|
| Two-tier AI extraction | `scripts/pipeline/ai-analyzer.ts` | Tier 0 regex patterns, Tier 1 DeepSeek prompt, chunk merging (`mergeAnalyses()`), cost tracking |
| Entity deduplication | `scripts/pipeline/db-loader.ts` lines 559-757 | 4-pass algorithm: junk removal, union-find, single-word merge, nickname resolution |
| Name normalization | `server/storage.ts` lines 150-310 | `normalizeName()`, `isSamePerson()`, 60+ nickname mappings, edit distance, OCR space collapse |
| Entity loading | `scripts/pipeline/db-loader.ts` lines 151-334 | `loadAIResults()` — parse AI JSON → persons/connections/events tables |
| SSE streaming | `server/chat/routes.ts` lines 89-115 | `data: JSON\n\n` event format (adapt to FastAPI `StreamingResponse`) |
| Chat system prompt | `server/chat/service.ts` lines 5-13 | Prompt structure — adapt for legal context with citation requirements |
| Schema foundation | `shared/schema.ts` | persons/connections/personDocuments/timelineEvents design (extend with temporal fields, privilege, RBAC) |
| URL filter sync | `client/src/hooks/use-url-filters.ts` | `useUrlFilters()` hook for shareable filter state in React frontend |
| shadcn/ui + layout | `client/src/components/ui/` + `App.tsx` | Component library + sidebar layout shell |

---

## Phased Roadmap

### Phase 1: Foundation (Weeks 1-3)
Auth (JWT + RBAC with 4 roles), document upload + S3 storage, document listing with pagination and filters, PDF viewer, PostgreSQL full-text search (tsvector — already better than Epstein's ILIKE), audit logging middleware.

**Deliverable:** Users can upload, view, and keyword-search documents with role-based access.

### Phase 2: Embeddings + RAG Chat (Weeks 4-6)
Text extraction pipeline (PyMuPDF + OCR fallback), chunking (512 tokens, 64 overlap), embedding generation (OpenAI), pgvector HNSW index, hybrid retrieval (vector + FTS + RRF fusion), `/api/search` endpoint, chat with SSE streaming + citation tracking.

**Deliverable:** Users can semantically search documents and ask questions with cited answers.

### Phase 3: AI Entity Extraction (Weeks 7-9)
Port two-tier analysis from Epstein repo (generalized for legal domain), entity loading, 4-pass deduplication, person/entity pages, Celery task queue for pipeline orchestration, pipeline monitoring dashboard.

**Deliverable:** Automated extraction populates persons, connections, and events. Pipeline runs as background tasks with monitoring.

### Phase 4: Enterprise Features (Weeks 10-12)
Privilege tagging workflow, annotation system (highlights, notes, review flags), annotation overlay in PDF viewer, court-ready export (PDF bundles with citation index), case matter multi-tenancy, admin dashboard (user management, audit log viewer, budget tracking).

**Deliverable:** Full enterprise feature set ready for law firm deployment.

---

## Verification Plan

1. **Pipeline:** Upload a PDF → verify text extraction (including OCR fallback) → verify chunks created with embeddings → verify entities extracted → verify persons/connections in DB
2. **Search:** Query "financial irregularities" → verify semantic matches (not just keyword) → verify date/privilege filters work → verify RRF fusion ranking
3. **Chat:** Ask "what documents mention the defendant's awareness?" → verify cited answer with document references → verify SSE streaming
4. **RBAC:** Login as paralegal → verify privileged docs hidden from search → login as attorney → verify privileged docs visible
5. **Audit:** Perform search → verify audit_log entry created with query, user, timestamp
6. **Dedup:** Load entities from multiple documents → verify duplicate persons merged correctly
