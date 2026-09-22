---
title: Architecture
---

# Architecture

SaveMyContext has one private service and one shared workspace. Keep browser
capture, authoritative state, and deployment infrastructure separate.

| Component | Owns | Does not own |
| --- | --- | --- |
| Extension | Provider adapters, Projects context, durable delivery/retries, capture controls | Inference, graph UI, task database, backend filesystem paths |
| Core API | SQLite ledger, source revisions, ingestion, tasks, search, optional processing | Provider login sessions or fleet administration |
| Shared workspace | Inbox, memory, tasks, projects through the API | A second persistence model |
| CLI / skill | Explicit agent reads and writes using scoped credentials | Direct SQLite access or automatic execution of captured instructions |
| Deployment repository | Hosts, secrets references, reverse proxy, backups, monitoring, rollout | Product behavior duplicated for one installation |

The shared workspace source lives in `frontend/src/`. Its independent Node-only
build emits a static application and an ESM embedding entry point. The extension
imports the local `@savemycontext/ui` package, not backend files. Python wheels
vendor generated assets for convenient `/workspace` hosting; CI rejects drift.
`SAVEMYCONTEXT_WORKSPACE_UI_ENABLED=false` disables those static routes without
disabling the API. Separate hosts configure a public API URL and an exact CORS
origin; bearer credentials remain in tab memory. See the
[frontend guide](frontend.md) for deployment and embedding contracts.

## Delivery and recovery

Normalized captures are staged in extension-origin IndexedDB before delivery.
An acknowledged receipt is required before removing an item; retries preserve stable
identities. Queue limits are bounded and errors are visible. Changing the backend
does not redirect previously queued evidence to a new destination.

The popup reads a queue count, not capture bodies or the conversation corpus.
Pause and provider/account restrictions are rechecked between deliveries. An
in-flight request can finish. No browser model worker runs.

The backend owns durable source revisions and processing jobs. Optional external
processing is off by default; suggested memories require review. Task edits are
versioned and cannot be silently undone by a later capture.

## Storage

SQLite is the authoritative operational ledger. Basic Memory is an optional
service-managed search projection. Cold raw evidence can be moved to a verified,
encrypted archive using the [archive workflow](evidence-archive.md); this does not
move live SQLite onto a network filesystem. Archive roots and backup policies are
installation configuration, never hard-coded provider requirements.

## Public project boundary

Keep extension, core API, shared component, and agent client in this repository.
Core behavior must run on a fresh local installation without a particular domain,
NAS, private tunnel, chat bot, or infrastructure repository.

Fleet-specific rollout scripts, runtime secrets, machine inventory, monitoring
destinations, and archive mount paths belong in the deployment repository.
No hosted service or license grant is implied by the public code.

The old graph/pile API is retained for compatibility, but its extension UI and
browser inference runner are no longer maintained. Do not add new clients for those
routes; use the workspace API. A separate backend retirement can follow audited
consumer inventory and migrations, not an extension UI cleanup.
