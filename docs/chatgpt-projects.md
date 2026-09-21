# ChatGPT Projects capture

SMC imports conversations from both ordinary history and the independently
paginated Projects index. A project chat uses the same conversation ID and
active-branch parser as an ordinary chat. Nested `/g/g-p-…/c/…` page routes also
work for DOM fallback. No bank-style credentials, new model API, or extension
permission is required.

## Identity and organization

- The private SQLite database maps `(provider, account key, upstream project ID)`
  to an SMC project. Names are labels, not identity; a deterministic suffix keeps
  similarly named personal/imported projects distinct.
- Renames and moves update membership without creating a new transcript revision,
  extraction job, accepted memory, or task.
- An omitted membership means **unknown**. Only an explicit null in a successful
  conversation-detail response means **no project**. Missing projects in a list
  never delete local sources.
- Capture timestamps prevent replayed membership from overwriting newer evidence.
- Manual project assignment, including choosing “No project,” takes precedence
  over subsequent imports. Pre-upgrade manual assignments are preserved too.

## Shared context is not a transcript

Exposed project instructions and file references are stored in a separate private
provider-context record and displayed under “ChatGPT project context.” They are
escaped as text and are not fed to extraction or treated as user instructions.
Sparse detail responses do not erase richer sidebar context.

**File contents are not downloaded or backed up.** Files absent from the provider
response are labeled unknown rather than declared nonexistent. Empty projects
are discovered but are materialized in SMC only when a conversation is imported.
Projects whose only chats are excluded by the user's capture rules also remain
excluded. Existing chat account-selection/indexing rules still apply.

## Retry and efficiency contract

Project lists use cursor pagination, independently of the ordinary history
watermark. Conversation IDs are deduplicated across both lists. Project changes
during enumeration, repeated cursors, malformed shapes, bounds, permission errors,
or partial failures produce an incomplete/failed sync, not a successful watermark.
Ordinary chat capture can still proceed if the Projects index fails.

GET requests have response-size/time bounds and bounded retries for 429/5xx.
Retry-After is respected for short delays; long rate limits require a later run.
Detail downloads use the existing concurrency limit of four. An acknowledged
project/chat update fingerprint avoids repeated downloads when unchanged (maximum
24-hour cache age); absent update timestamps or session account identity force a
refresh. Cache identities are scoped to the signed-in session user.

The existing destination-pinned IndexedDB outbox retains captures until durable
acknowledgement. Project captures additionally require `provider_project_ack` from
the updated workspace backend, so an older server cannot silently drop metadata.
Deploy the backend before reloading the unpacked extension.

## Compatibility and verification

These are undocumented browser endpoints, not a supported OpenAI API contract.
On 2026-09-21 a read-only inspection of a signed-in Edge session verified:

- sidebar `items[].gizmo.gizmo` metadata, sibling `files`, and nullable `cursor`;
- per-project `/backend-api/gizmos/{id}/conversations?cursor=0`, with `items` and
  nullable `cursor`;
- the nested project conversation URL route.

No live project names, IDs, chat text, credentials, or response dumps belong in
fixtures or Git. Tests use invented data. Automated coverage includes pagination,
drift, rate limits, duplicate/moving chats, metadata-only changes, sparse context,
account isolation, manual overrides, rollback, safe browser rendering, and the
built extension's project-only-history bridge → outbox → SQLite integration.

The schema adds `workspace_provider_projects` and
`workspace_source_project_bindings`; it does not rewrite historical transcripts.
External interpretation/Jev remains controlled by existing settings and is not
enabled by this feature.
