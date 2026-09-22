---
title: Contributing
---

# Contributing

The `docs/` folder is intentionally user-facing. If you contribute to SaveMyContext, keep the documentation centered on how people install, run, and use the product.

## Before you open a pull request

Understand the product boundaries:

- `backend/`: FastAPI service, SQLite ledger, optional processing, agent client, and generated convenience UI
- `frontend/`: independent static app and dashboard embedding package; the sole UI source of truth
- `extension/`: lightweight capture, reliable delivery, optional quick search, settings, and workspace launcher

There is no selected project license yet. Resolve licensing before treating this
as a generally reusable open-source release; public visibility alone is insufficient.

## Local setup

Frontend (Node 22+, no dependencies to install):

```sh
cd frontend
npm test
npm run build
npm run build:backend
npm run check:backend
```

Commit the generated backend distribution together with frontend changes. Never
edit the generated copy instead of its source. Browser tests exercise independent
hosting, token isolation, dashboard embedding, and the extension consumer.

Backend:

```bash
cd backend
uv sync --group dev
uv run --group dev python -m pytest -q
```

Extension:

```bash
cd extension
pnpm install
pnpm test
pnpm typecheck
pnpm build
pnpm check:bundle
pnpm test:e2e
```

## Contribution expectations

- Keep user behavior coherent. SaveMyContext is most useful when the backend, extension, and vault all tell the same story.
- Prefer real fixes over compatibility shims when the current behavior is unclear or unsafe.
- Keep docs in `docs/` user-facing. Design notes and rough architecture memos belong somewhere else if they need to exist at all.
- Update the user docs when setup steps, auth behavior, capture behavior, storage layout, or vault output changes.

## Good areas to help with

- provider capture reliability
- vault readability
- search quality
- source attribution and review quality
- onboarding and installation polish
- docs clarity

Keep provider fixtures sanitized: no real conversations, account identifiers, tokens,
or browser profiles. Capture changes need parser and browser regression tests,
including drift, retries, and project membership. UI work belongs in the shared
workspace instead of a second extension-specific app. Do not restore browser-based
model workers. Hostnames, NAS layouts, and private deployment instructions belong
in the deployment repository, not the portable product.

## When you change user-facing behavior

Please update whichever pages are affected:

- `Getting Started` for install or setup changes
- `Using SaveMyContext` for capture and workflow changes
- `Dashboard and Search` for extension UI behavior
- `Vault and Storage` for file layout changes
- `Security and Access` for auth and token changes
- `Troubleshooting` for new failure modes or clearer recovery steps

## Read next

- [SaveMyContext Docs](index.md)
