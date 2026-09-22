# SaveMyContext

A private memory and action workspace for the thinking scattered across your AI
conversations. Capture once, keep the evidence, and pick up the work anywhere.

**One service. One SQLite database. One shared workspace.** The browser extension,
web interface, and agent skill use the same API. Tasks are part of your context,
not another disconnected to-do list.

An optional [Basic Memory integration](docs/basic-memory.md) adds private local
semantic search behind that same API. During this reversible pilot, its Markdown
and search database are service-managed projections; the workspace SQLite ledger
remains authoritative. No second task writer or automatic interpretation is enabled.

## The workspace

- **Inbox:** review ideas, decisions, and task suggestions from captured sources.
- **Tasks:** commitments, notes, projects, due dates, history, and opt-in reminders.
- **Memory:** local search over original sources and accepted memories. Suggestions
  link to the exact source revision that supports them.
- **Projects:** sources, decisions, and next steps together, without rewriting originals.

The same responsive web component runs at the backend's `/workspace`, inside the
extension, or behind a private dashboard proxy. Workspace mode has no second task
database, browser inference worker, or writable Markdown task ledger.

## Run from source

Python 3.12+, uv, Node.js, and pnpm are required for development.

```sh
git clone https://github.com/nociza/SaveMyContext.git
cd SaveMyContext/backend
uv sync --frozen
uv run uvicorn app.main:app --host 127.0.0.1 --port 18888
```

Open `http://127.0.0.1:18888/workspace`. SQLite and generated Markdown stay under
`backend/data/`, excluded from Git. Loopback bootstrap is available only before
any application token exists. **Do not expose this service publicly.** For remote
use, use a private network and protected per-client credentials, or issue scoped
application tokens with `smc token create --help`.

```sh
cd ../extension
pnpm install --frozen-lockfile
pnpm build
```

Load `extension/dist` as an unpacked Chrome extension. Configure its backend URL
and a token with `ingest`, `read`, and `workspace:write` permissions. Existing
capture-only tokens still capture but cannot edit the workspace. Reload an
already-installed unpacked extension after upgrading.

The **0.4 extension is a capture companion**: connection/queue status, pause/resume,
explicit history import, page capture, and an **Open workspace** button. New installs
do not automatically import all history; upgrades preserve existing preferences.
Optional selection capture and quick search remain available.

Set **Workspace URL** to your authenticated dashboard page, or leave it blank for
the bundled shared workspace. API credentials are never appended to links. The
old graph/pile/dashboard/prompt screens redirect there; their visualization
libraries, duplicate task UI, and browser-LLM runner are no longer bundled.

Existing ChatGPT/Gemini/Grok adapters, page/selection capture, and context bundle
transport are retained. Provider websites can change independently; capture
errors remain visible. Browser inference is not needed for the new pipeline.

## Agents and OpenClaw

Load [the skill](skills/savemycontext/SKILL.md) in your agent's skill directory.
The backend package installs `smc-workspace`; its stdlib-only
`backend/app/workspace/client.py` can also be installed on an agent host.

```sh
export SMC_API_URL=https://your-private-host
export SMC_TOKEN_FILE=/protected/path/application-token
smc-workspace remember "Garden idea" --text "My idea is a shaded tea garden."
smc-workspace search "tea garden"
smc-workspace add-task "Order seeds" --due 2026-10-01
smc-workspace tasks
```

The skill does not read SQLite directly, execute captured instructions, or keep
a shadow ledger. Task edits use versions; capture retries use stable request keys.
The service exposes notification candidates; an external adapter such as
Teleclaw handles opt-in delivery and deduplication.

## Processing and privacy

Capture and its durable job commit together. A leased background worker derives
suggestions afterward. Failures do not lose sources; stale jobs cannot overwrite
newer captures. Reprocessing cannot undo completed tasks or owner edits.

No model is required for capture, search, notes, and explicit task management.
Locally, conversations and page captures are indexed **without inferred tasks or
memories**. “Save a thought” preserves a verbatim note for review; use “New task”
or `add-task` for a commitment. Keyword matching cannot distinguish questions,
quoted drafts, code, or historical plans from the owner's current intent.
External processing is **off by default**. Optional Jev integration uses OpenRouter's
typed `/api/alpha/decisions` endpoint, not chat completions:

```dotenv
SAVEMYCONTEXT_WORKSPACE_EXTERNAL_PROCESSING=true
SAVEMYCONTEXT_JEV_API_KEY=configure-in-a-protected-runtime-file
SAVEMYCONTEXT_JEV_MODEL=typesafe/jev-1.13
```

Jev scores bounded excerpts. It does not write your ledger, calculate deadlines,
or act as a summarizer. The adapter's 0.9 suggestion threshold is an implementation
policy, not a measured accuracy claim. Generation requires the separate
`SAVEMYCONTEXT_WORKSPACE_GENERATE` setting and a configured text-generation
provider. Decide what private material may leave the host before enabling either.
Never commit keys, sources, or databases.

### Retiring old keyword suggestions

After taking a consistent backup, preview with
`python -m app.workspace.cleanup` and apply with
`python -m app.workspace.cleanup --apply <preview-fingerprint>` using the service's
protected runtime configuration. This retires only unreviewed `local-excerpts-v1`
suggestions. Accepted, dismissed, edited, or task-linked records are excluded.
Original sources remain searchable; each retired record and its before-image
remain in private history. No private text is printed. A stale preview aborts.
For recovery, use the memory ID from the retirement history and PATCH its status
to `suggested` with the current `expected_version`; review it before accepting.
The retirement marker prevents automatic reprocessing from reviving it.

## Upgrade and recovery

Workspace tables are additive. Existing conversations are backfilled idempotently
at startup. Take a consistent SQLite online-backup snapshot before upgrading and
test the copy first. `python -m app.workspace.migrate --help` includes explicit
Nexus task import preserving IDs, timestamps, notes, and reminder preferences;
it refuses an ambiguous merge into a populated task store.

SQLite is authoritative; Markdown is an export. Historical graph/pile routes are
retained for compatibility, but their old processing/task mutations are disabled
in workspace mode. Legacy mode is not a rollback after new writes: preserve the
new database and reconcile those writes before reverting.

Encrypt backups before transfer and restore-test them. Generated source exports
are rebuildable; separately retain any historical user-authored vault files.
A growing archive needs capacity and retention limits, not unlimited encrypted
blobs in Git history.

## Development

```sh
cd backend && uv run pytest -q
cd ../extension && pnpm test && pnpm typecheck && pnpm build
```

Browser test against a **disposable** running backend:
`SMC_WORKSPACE_TEST_URL=http://127.0.0.1:18888 pnpm exec playwright test e2e/workspace.spec.ts`.

See [architecture](docs/architecture.md), [workspace design](docs/workspace-design.md),
and [contributing](docs/contributing.md). The public project contains the extension,
core API, shared workspace, and agent client. Installation-specific infrastructure,
secrets, backup destinations, and deployment automation belong in a separate
deployment repository; no particular dashboard, NAS, or chat bot is required.

### Licensing

No project license has been selected yet. Public visibility is not an open-source
license grant. Choosing and adding a license is a separate owner decision; this
refactor does not silently assign one.
