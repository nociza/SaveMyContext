# TSMC

TSMC (Total Sync: My Context) is a local-first second-brain pipeline for web AI chats. It ships two components:

- A Chrome extension that watches supported AI web apps, captures normalized conversation deltas, and syncs them to a local backend.
- A FastAPI backend that stores sessions in SQLite, mirrors transcripts to Markdown, and runs classification plus post-processing pipelines for journal, factual, and idea workflows.

## Project Layout

- `backend/`: FastAPI app, persistence, Markdown export, LLM abstraction, processing pipelines, and tests.
- `extension/`: MV3 Chrome extension built with TypeScript and Vite.
- `docs/architecture.md`: implementation plan and system design.
- `spec.md`: original project specification.

## Backend Quickstart

```bash
cd backend
uv sync
uv run uvicorn app.main:app --reload
```

The backend stores runtime data under `backend/data/`.

Copy [`backend/.env.example`](/Volumes/Brookline/Projects/Personal/tsmc/backend/.env.example) to `backend/.env` if you want to enable OpenAI or Google-backed processing.

## Extension Quickstart

```bash
cd extension
pnpm install
pnpm build
```

For browser-level extension E2E coverage, install Playwright's bundled Chromium once:

```bash
cd extension
pnpm exec playwright install chromium
pnpm test:e2e
```

Load `extension/dist/` as an unpacked Chrome extension. Open the extension options page and point it at your FastAPI backend, usually `http://127.0.0.1:8000`.

## Verification

Backend:

```bash
cd backend
uv run pytest -q
```

Extension:

```bash
cd extension
pnpm test
pnpm typecheck
pnpm build
pnpm test:e2e
```

## Processing Model

- `journal`: personal context and task-oriented conversation summaries.
- `factual`: subject-predicate-object triplets for a lightweight knowledge graph.
- `ideas`: brainstorm summaries with pros, cons, next steps, and a share-ready short post.

When no LLM API key is configured, the backend falls back to deterministic heuristics so the ingest pipeline still works end to end.
