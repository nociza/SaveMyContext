---
title: Architecture and Production Roadmap
---

# Architecture and Production Roadmap

> The 0.3 [workspace design](workspace-design.md) supersedes the implementation
> roadmap below. Legacy transport/projection code remains for compatibility;
> the shared SQLite workspace is the default product and mutation boundary.

## Product decision

SaveMyContext should be a private, provider-independent memory layer, not another AI chat client. It captures source
conversations and pages once, preserves enough evidence to audit them later, and builds useful projections such as
notes, tasks, entities, dashboards, and an Obsidian-friendly vault.

The production target available today is a single-tenant, self-hosted backend used through the Chrome extension and
CLI. A managed service remains a roadmap item. It should deploy this same core per customer before considering a
multi-tenant data plane; product logic must not fork into the private control-plane repository.

## Current data flow

```text
Provider page / CLI
        |
        v
Chrome extension capture adapters
        |
        v
Authenticated ingest and source-capture APIs
        |
        v
Relational source records (sessions, messages, captures, sync events)
        |
        +--> classification and structured processing
        |
        +--> Markdown, source notes, graph, dashboards, and to-do projections
        |
        +--> local database and vault search
```

The relational records are canonical for captured sessions, messages, source captures, and processing metadata. The
Markdown vault is a durable, user-owned export that should be rebuildable from those records. The shared to-do note
is intentionally user-editable, so code touching it must preserve manual edits.

Search is local-only. Configuring an AI provider for enrichment does not send search queries or existing vault notes
to that provider.

## Invariants

- A newer full snapshot must never be overwritten by an older snapshot.
- Client capture timestamps more than 24 hours in the future are rejected before they can poison snapshot ordering.
- Replaying identical input must not create duplicate messages, sync events, AI work, or Git commits.
- Source-capture retries reuse a client key, and the same key can never identify different source content.
- Accepted relational source state commits before enrichment and projection work; a later provider or filesystem
  failure must not erase source material.
- Raw source and derived output remain distinguishable and traceable.
- Manual pile assignment is authoritative until the user asks to reclassify it.
- File updates are atomic, and local CLI/server processes serialize generated exports and Git operations with
  advisory filesystem locks.
- Processing freshness is server-owned state, not a comparison between browser and server clocks. Stale workers
  must prove the source revision they processed before replacing derived output.
- The extension uses the same API, scopes, and `smc_conn_1_...` enrollment contract for local, remote, and future
  managed deployments.

## Why the pipeline should change next

Ingestion now commits canonical source state before its best-effort enrichment phase, so projection failure cannot
roll back an accepted capture. For PostgreSQL deployments, it then re-reads and locks that session through the
synchronous second phase; competing workers refresh after the winner commits instead of duplicating AI or Git work.
Automatic processors also use a conditional database write before changing pile state, so a concurrent manual
assignment wins. SQLite receives equivalent same-process serialization and is supported only as a single-process
local database.

The request still performs optional AI processing, whole-vault projections, and Git versioning synchronously.
There is no durable retry job or lease if the process dies between the source commit and a completed second phase,
and capture latency still includes all successful derived work.

The next architecture should make source capture the short synchronous transaction:

1. Validate authentication, limits, provider identity, snapshot ordering, and an idempotency key.
2. Commit raw source changes plus a durable outbox event in one database transaction.
3. Let a worker claim the outbox event with a lease and create a versioned processing run.
4. Produce structured outputs with prompt/model/version lineage and explicit retry or terminal error state.
5. Refresh affected Markdown and search projections atomically, then record the projection version.

This makes processing retryable without asking the extension to recapture data and allows expensive projections to
be rebuilt or replaced safely.

## Readiness status

Implemented hardening includes a source-before-enrichment commit boundary, stale-snapshot protection, replay-safe
unchanged snapshots, collision-safe note identities, durable manual pile locks, atomic/directory-synced file
replacement, ownership-checked graph/path cleanup, cross-process export/Git locking, idempotent source-capture
recovery, cross-worker phase-two serialization on PostgreSQL, conditional manual-pile authority, future-clock-skew
rejection, explicit processing/projection freshness, optimistic protection for manual to-do edits, transactional
single-use enrollment, request-size limits, database-backed readiness, local-only search, locked dependency graphs,
immutable CI action pins with automated dependency updates, and CI across backend, extension, PostgreSQL, and
browser integration suites.

Extension `0.2.1` is the compatibility floor for the optimistic to-do and browser-worker source-revision contracts.
Older builds do not send the required preconditions and are intentionally rejected instead of receiving
last-write-wins behavior.

CI now initializes and probes a fresh PostgreSQL schema twice. That catches portability and idempotence regressions,
but it is not a substitute for exercising upgrades from every supported released schema.

The following remain release gates for a broadly operated service:

1. Versioned migrations (preferably Alembic) plus PostgreSQL upgrade, rollback, and compatibility tests.
2. Durable outbox/worker processing with leases, retry policy, processing lineage, dead-letter recovery, and an
   idempotent database-to-file operation log for the user-editable shared to-do projection.
3. Pagination and indexed retrieval for session, graph, dashboard, and search APIs at large corpus sizes.
4. Backup/restore exercises, metrics, structured logs, alerts, resource limits, and an operator runbook.
5. Provider-adapter contract fixtures and drift monitoring that do not rely only on live third-party pages.
6. Signed Chrome Web Store distribution, reproducible release artifacts, compatibility policy, and rollback drills.
7. A lossless, versioned context-import format with explicit conflict and partial-import reporting.

Until these gates are complete, treat the project as a hardened self-hosted release candidate rather than claiming a
fully managed production service.
