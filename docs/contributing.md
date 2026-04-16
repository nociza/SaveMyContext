---
title: Contributing
---

# Contributing

The `docs/` folder is intentionally user-facing. If you contribute to SaveMyContext, keep the documentation centered on how people install, run, and use the product.

## Before you open a pull request

Understand the two main parts of the project:

- `backend/`: FastAPI service, storage, processing, and vault generation
- `extension/`: Chrome extension for capture, search, dashboard, and settings

## Local setup

Backend:

```bash
cd backend
uv sync
uv run pytest -q
```

Extension:

```bash
cd extension
pnpm install
pnpm test
pnpm typecheck
pnpm build
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
- graph quality
- onboarding and installation polish
- docs clarity

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
