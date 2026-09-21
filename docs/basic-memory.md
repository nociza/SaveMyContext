# Basic Memory integration pilot

The existing workspace API remains the single write boundary for the dashboard,
extension, and Teleclaw. Basic Memory 0.23.2 supplies local semantic retrieval and
knowledge links through its MCP interface. It does not interpret conversations,
create commitments automatically, or bypass the workspace's authorization.

## Ownership and recovery

This is a reversible **projection pilot**, not a migration of the source of truth.
The workspace SQLite database still owns original conversations, immutable source
revisions, accepted memories, task status, and audit history. A reconciliation
worker writes deterministic Markdown notes to a dedicated Basic Memory project.
Basic Memory indexes those notes into its own SQLite database. Do not edit this
project directly or connect an unrestricted agent writer to its MCP endpoint.

That differs deliberately from using standalone Basic Memory, where Markdown is
authoritative. In this pilot its files can be regenerated from the authoritative
workspace backup. If direct Markdown authoring is introduced later, those files
must become part of encrypted authoritative backups before accepting such edits.

No original row is deleted or relocated. Disabling `SAVEMYCONTEXT_BASIC_MEMORY_URL`
restores the previous exact-search behavior without reverting a database or losing
new writes. The additive projection table can remain in place on rollback.

## Run privately

Run Basic Memory in a separate pinned environment. Set its `BASIC_MEMORY_CONFIG_DIR`
to a protected directory containing a project named `savemycontext`. Disable
auto-update and telemetry, enable local FastEmbed semantic search, and bind its
MCP server to **127.0.0.1**, not a public or Tailscale interface. The model download
is public; document embedding runs locally. No external LLM is required.

```sh
bm mcp --transport streamable-http --host 127.0.0.1 --port 8791 --project savemycontext
```

Configure the existing workspace service:

```dotenv
SAVEMYCONTEXT_BASIC_MEMORY_URL=http://127.0.0.1:8791/mcp
SAVEMYCONTEXT_BASIC_MEMORY_PROJECT=savemycontext
SAVEMYCONTEXT_BASIC_MEMORY_SYNC=true
```

Only numeric loopback HTTP endpoints are accepted by the adapter. The existing
workspace service supplies scoped authentication to remote clients; they never
receive a Basic Memory credential or endpoint. Loopback is not authentication
against other local processes: the deployment assumes trusted application hosts.
Keep the Basic Memory process unprivileged and its files private.

The deployment lock explicitly permits Basic Memory's required FastMCP 4.0.0b1
and companion package, not arbitrary beta dependencies. Upgrade this dependency
as a release, rerunning the smoke test and restore rehearsal, not on agent startup.

## Retrieval contract

`GET /api/v1/workspace/search?q=...&mode=auto&scope=all` keeps the existing `items`
shape and adds `retrieval` metadata. Modes are `auto`, `exact`, and `semantic`;
scopes are `all`, `curated` (accepted memories and open tasks), and `sources`.
The agent CLI exposes `search --mode ... --scope ...` with the same behavior.

- Exact search uses the complete original local index with AND term matching.
- Semantic search uses Basic Memory vector search, **not its default hybrid**,
  which misranked a paraphrase in our local evaluation. Similarity is a retrieval
  hint, not fact confidence. The initial minimum similarity is 0.65, a policy
  setting in code, not a calibrated correctness claim.
- Semantic hits are resolved only through service-owned opaque paths, then
  checked against current source/task status and the synchronized fingerprint.
  The response body comes from the workspace, never from returned model/index text.
- Suggested/rejected/superseded memories are not projected as curated knowledge.
  Explicitly completed tasks stay completed; curated search excludes them.
  Inactive records have no Markdown/vector placeholder: reconciliation removes
  only their deterministic service-owned note, using the upstream single-note
  API. The canonical row and audit history remain available for recovery. An
  acknowledgement in SQLite prevents repeatedly deleting an already-absent note;
  restoring/accepting the record projects it again. Older withdrawal placeholders
  are removed without rebuilding unchanged conversation embeddings.
- Sources over 48,000 characters use first/last 24,000-character excerpts in the
  semantic index. Full originals remain available through source detail and exact
  search. The UI discloses this limit. Middle-only paraphrases can be missed.
- On an index outage, exact search remains available and the response/UI clearly
  marks degraded retrieval. Capture, task edits, and audit commits do not wait for
  Basic Memory. Sync retries on subsequent reconciliation passes.

Raw sources are labelled untrusted source material, not instructions. Basic
Memory may parse structured text within them; our adapter never promotes such
observations into accepted memories or tasks. Source links and human review are
still needed to resolve historical plans and contradictions.

## Rebuild and diagnostics

Run with the service's protected runtime configuration:

```sh
python -m app.workspace.knowledge_admin status
python -m app.workspace.knowledge_admin rebuild
```

`rebuild` invalidates only projection acknowledgements. The background worker
replays current records in bounded batches; it does not change source/task rows.
It removes derived notes for inactive records, never original source files or
canonical history. Use it after restoring/replacing the Basic Memory project or
changing projection format. `sync` runs one batch for an operator-controlled
rehearsal; do not run competing sync writers against the production project.

The authenticated overview exposes bounded status and queue counts. Error text,
source content, queries, tokens, and model payloads do not belong in fleet metrics.

## Tests

Unit tests cover idempotent reconciliation, source changes during sync, archive
filtering, accepted-only memory retrieval, completed tasks, index outages,
safe deterministic paths, bounded excerpts, and remote endpoint rejection.

Against a disposable Basic Memory project named `evaluation*`, run:

```sh
PYTHONPATH=. python scripts/basic_memory_smoke.py
```

Set the two Basic Memory configuration variables to that test project first.
The smoke test creates synthetic notes and tests actual MCP writes/vector search.
It must never run against a production project. A small synthetic corpus does not
establish real-corpus relevance, latency, or prompt-injection robustness.
