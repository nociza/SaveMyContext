# Capture integrity and repair preview

The default workspace pipeline is **capture → private local outbox → durable
backend evidence → validated transcript → optional interpretation**. Saving a
conversation does not call an LLM. External processing remains opt-in; this
release does not enable Jev or change runtime model settings.

## Browser capture

- Network observation reads a clone asynchronously; streamed replies reach the
  provider UI immediately. Observation is bounded to 8 MiB and two minutes.
  Oversized or unfinished streams are not truncated into an apparently complete
  transcript. They need a later complete conversation fetch.
- Preserve message roles, provider order, IDs, parents, Markdown, and indentation.
  Equal/missing timestamps never sort by arbitrary message IDs.
- ChatGPT selects the active mapping branch. Without that selection, only a
  single unambiguous path is usable; sibling answers are never concatenated.
  Only a successful structured GET with a path reaching an explicit root can
  claim completeness. Other provider captures remain partial for now.
- DOM extraction is explicitly partial, in document order, without invented
  alternating roles. Whole-page fallback text is unknown-role context, not proof
  of a complete conversation. This fallback remains a manual context export.
- Gemini/Grok history captures retain provider evidence alongside normalized
  messages. Heuristic text guesses are marked for backend review. Unknown
  provider shapes surface as drift instead of advancing a successful history
  watermark.

## Delivery and reconciliation

The extension-origin IndexedDB outbox persists until a JSON backend receipt is
acknowledged. Retries use the same capture; a service-worker restart is safe.
The once-per-minute alarm and startup retry pending deliveries. A destination
change never redirects private backlog to another backend, and current
provider/account/indexing restrictions can pause delivery. Credentials are read
from current extension settings, not copied into queue entries.

The outbox is capped at 1,000 captures / 128 MiB of serialized payloads. Capacity
errors are visible; unacknowledged items are not silently evicted. Browser profile
deletion/uninstall or browser storage eviction is not a backup. If the background
worker cannot persist a message, the content bridge retries four times and warns;
do not leave that page until persistence is restored. The popup shows backlog
and delivery errors. Existing legacy browser-processing tools remain available
for compatibility, but are not part of the default workspace capture pipeline.

SHA-256 fingerprints detect edits to already-seen IDs. Newer timestamped updates
create a new immutable source revision; stale/undated edits cannot roll back
accepted text. Partial/unknown snapshots may update existing IDs and append new
ones, but cannot delete absent messages. Only a newer, explicitly complete,
quality-checked snapshot may replace a branch. Original raw evidence and previous
workspace revisions remain retained.

## Quality checks

The deterministic gate checks empty content, parser-marker artifacts, missing
user turns in full snapshots, non-conversation roles, duplicate IDs, and parent
order. These are review signals, not a claim of semantic correctness. A genuine
assistant saying `text` may need review too; no content is silently thrown away.

Suspicious workspace ingests receive a durable quarantine receipt, backed by the
additive `workspace_capture_quarantine` table. They do not overwrite the current
transcript or reach an inference provider. Assistant-only incremental chunks can
be stored, but a resulting transcript without a user turn is withheld from
interpretation. Existing originals are unchanged and get computed “Needs repair”
labels in source lists/details. Quarantine status is available through the
authenticated workspace API/UI, without rendering raw request payloads.

Raw originals remain searchable; search results are not automatically promoted
to facts, commitments, or curated memories. This release does not delete existing
embeddings or infer missing prompts.

## Historical preview (no apply operation)

Build the offline provider replay tool with `pnpm build:capture-preview` in
`extension/`, then from `backend/` run:

```
uv run python -m app.workspace.capture_preview /protected/snapshot.sqlite \
  --parser ../extension/dist/tools/preview-captures.mjs
```

Use a consistent SQLite online-backup/verified restore, not a changing live file.
The tool opens it read-only, verifies integrity and an unchanged whole-file hash,
and emits counts plus before/proposed hashes and quality reasons—not transcripts,
titles, URLs, or credentials. `reviewable_reparse` means a candidate merits review,
**not** permission to replace history. Missing prompts, branch changes, and
synthetic-only provider evidence require special care. There is no `--apply`.

Applying any historical repair requires a separate approved, recoverable plan.
Deployment is code-only plus an additive quarantine table. Rollback switches
application code; never restore an older DB over new writes. Browser installation
is separate from server deployment: rebuild/reload the unpacked extension and
verify a new capture after upgrading.
