# SaveMyContext workspace

## Product contract

Capture once, preserve the evidence, remember what matters, and continue the work
from any interface. Tasks are actionable memory, not a separate application.

The supported deployment is one private FastAPI process, one local SQLite file,
and a protected export directory. The process hosts the web workspace and a
durable job loop. The extension, dashboard, and agent CLI all use the same API.
SQLite files are never shared over a network. Existing provider adapters and
context bundles remain compatible.

## Ownership

- Provider sessions and page captures retain their original records and raw evidence.
- Workspace sources and immutable revisions normalize those records for retrieval.
- Notes, ideas, decisions, and task suggestions reference an exact source revision.
- Accepted tasks and user edits are authoritative. Reprocessing never changes them.
- Projects are associations, not exclusive classification pipelines.
- Markdown is a portable export, never a second writable task database.
- Captured text is data, never permission to execute a command.

## Processing

Capture and an outbox job commit together. A single worker leases jobs, releases
the database transaction, performs optional inference, and applies results only
if the source revision is still current. Failed jobs back off and become visibly
failed after bounded attempts. Replays are idempotent. There is no browser-driven
inference in the workspace pipeline and no whole-vault regeneration per capture.

Local capture and search work without a model: conversations and page captures
are indexed, not classified into commitments by keyword. Explicit notes are
preserved verbatim for review. External processing is disabled by default and
requires explicit configuration. Jev is an optional typed decision
adapter, not a summarizer, calculator, authorization system, or mandatory service.
Bounded excerpts include full conversation context within the action budget;
larger inputs abstain from action inference. Model and processor versions accompany
derived records. Ambiguous inferred tasks remain suggestions. Direct owner task
commands use the task API and do not pass through inference.

## Interfaces

The web workspace has Inbox, Tasks, Memory, Projects, and private Writing with shared search.
The same browser module runs standalone and embedded in Nexus; it receives a
base URL, not a secret. Nexus proxies requests using a protected server credential.
Standalone users supply a revocable token held only in memory for that tab.
The agent CLI uses a protected token file. Separate client credentials are
revocable independently; capture-only credentials cannot edit tasks.

Source-backed digests and editorial drafts are separate tables, not extra memory
kinds. See [the summary and publishing contract](writing-and-summaries.md).

## Migration and release

New tables are additive. Existing sources are backfilled idempotently. Existing
Nexus task IDs, completion dates, notes, tags, and notification settings are
imported in one transaction from a consistent SQLite snapshot. Import refuses
conflicting populated task stores. Legacy Markdown tasks require an explicit
import and are never silently reconciled by title with the Nexus ledger.

Before cutover: pass regression tests, restore-test the candidate database,
verify API/auth contracts, and validate desktop/mobile views. Preserve the old
database and release. Stop the old task writer before the final snapshot and
port cutover. Rollback after new writes requires migrating those writes back;
never silently revert to a stale database. Cloud control-plane and graph-heavy
legacy interfaces are retained for compatibility, not part of the new default.

## Privacy and operations

Application content stays out of Git, telemetry, and generic monitoring alerts.
Backups cover the database plus any non-rebuildable attachments and are encrypted
before leaving the host. Archive size determines capacity and backup destination;
small-state Git backups are not an unbounded conversation archive strategy.
Notifications remain opt-in. Source imports never enable them.
