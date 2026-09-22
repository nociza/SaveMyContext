# Summaries, organization, and private writing

## Boundaries

The application database remains authoritative. Basic Memory is a rebuildable
search projection. Source-backed digests, owner-reviewed memories, active tasks,
and editorial drafts are different records; no summary can publish a draft or
manufacture an active task. Original text is never replaced by generated content.

This release deliberately uses **extractive digests**, not automatic paraphrased
factual summaries. The model selects coordinates into immutable source text;
the server resolves the actual quotes. Unsupported model-authored prose is not
accepted by the schema. A readable overview can include an assistant answer and
the owner's later response without presenting the answer as the owner's promise.
Quote selection/grouping can still be misleading, so digests remain reviewable
and are not independently verified facts. Blog prose belongs in an editable draft.

## Configuration

External processing remains opt-in:

```dotenv
SAVEMYCONTEXT_WORKSPACE_EXTERNAL_PROCESSING=true
SAVEMYCONTEXT_WORKSPACE_GENERATE=true
SAVEMYCONTEXT_WORKSPACE_SUMMARY_MODEL=your-explicit-policy-compatible-model
SAVEMYCONTEXT_WORKSPACE_SUMMARY_MAX_CHARS=120000
SAVEMYCONTEXT_ALLOW_PAID_FALLBACK=false
```

Configure the existing OpenAI-compatible endpoint/key in a protected runtime file.
The summary route uses exactly the named model, not the legacy orchestrator's
browser automation or fallback chain. No model is chosen for you and no remote
privacy policy is relaxed. The general compatible client also prevents a free
primary from falling through to paid candidates unless explicitly enabled.
An explicitly selected paid primary is an intentional paid configuration.

Jev is optional, separately keyed, and used only for action/idea/decision
classification. It gets the full role-labelled context for up to 64 candidate
excerpts and a 32,000-character serialized context; larger inputs abstain.
Unavailable classification does not prevent the independent digest lane.

Digests cover visible message text, including code and quotations. Attachments,
images/audio, and project-file references do not imply imported content. Each
span is <=6,000 characters; chunk inputs are <=12,000 characters; the default
source budget is 120,000 characters. Oversized inputs report `needs_budget`
rather than silently summarizing only a prefix. Each request caps output at
2,400 tokens and uses a 25-second timeout. Long sources use a reconciliation
pass over selected passages and the latest four spans. This is bounded context,
not a guarantee of perfect cross-chunk contradiction detection.

Unchanged map-stage chunks reuse cache entries keyed by source span contents,
roles/times, requested model, and prompt/version. Returned model/usage metadata
is preserved with each entry; `unreported` is explicit if a provider omits it.
The final reconciliation is rerun. No private cache or transcript belongs in Git.

## Summary and organization API

- `GET /sources/{id}` includes the digest for that source revision and `is_current`.
- `POST /sources/{id}/reprocess`: `expected_revision` plus `dry_run` (default true).
  Explicit apply queues one source, preserves owner-reviewed records and history,
  and can retry interpretation after a configuration change without rescraping.
- `GET/PATCH /organization/{key}` supports `source:<id>` or `memory:<id>`.
  PATCH requires `expected_version` (0 for a new record), `category`, `area`, and
  `topics`. Categories are note/reflection/reference/idea/decision/question.
  Topics normalize case/whitespace and deduplicate; up to 12 are allowed.
- `GET /topics`; sources and memories accept `category` and `topic` filters.

Facets are owner-managed and do not guess a taxonomy. Journal maps naturally to
reflection; factual material to reference; discarded remains archival/rejection
state. Projects remain the primary work context. A formal topic-alias/hierarchy
editor is not introduced in this release.

For newly captured or explicitly reprocessed sources longer than 48,000
characters, the semantic projection includes 12,000-character chunks covering
the whole source. SQLite stores only their source/revision/offset pointers.
Search hydrates a chunk hit from the current source and rechecks visibility and
revision, never returning stale index text. Obsolete chunks are withdrawn from
the projection; original source revisions are retained. Existing historical
sources acquire chunk pointers on recapture or explicit reprocess, not through
an uncontrolled full-archive backfill.

## Editorial API

All routes are below the configured workspace API base. Reading requires `read`;
mutations require `workspace:write`. Existing capture-only tokens cannot approve
or export articles. Give an autonomous summarizer only the permissions it needs;
the server cannot prove a human read a checkbox sent by a broadly authorized agent.

1. `POST /drafts`: title, slug, body, private brief, optional project_id/source_ids,
   destination (`markdown-export` by default). Drafts are private, not auto-written
   by a background model. Source references pin their revision.
2. `GET /drafts`, `GET /drafts/{id}`, `PATCH /drafts/{id}` with full editable fields
   and expected_version. Every edit preserves a revision and clears approval.
3. `GET /drafts/{id}/preview`: exact allowlisted public payload, destination,
   version, content_hash, privacy findings, and stale source references.
4. `POST /drafts/{id}/approve`: expected_version, content_hash, destination,
   confirm_public=true. Empty copy, known privacy hazards, stale references,
   changed copy, and changed destinations block approval.
5. `POST /drafts/{id}/export`: expected_version and content_hash. Requires current
   approval and returns an idempotent receipt with status `exported`. It performs
   no remote publication. `GET /drafts/{id}/history` retains private versions.

Editing prose preserves pinned source revisions. If source evidence changes,
review it and explicitly remove/re-add its reference before re-approval; ordinary
editing must not silently dismiss a stale-evidence warning.

The public contract is intentionally small:

```json
{"format":"smc-article-v1","title":"An article","slug":"an-article","body":"Reviewed Markdown."}
```

It excludes private briefs, source IDs/revisions/URLs, account metadata, and
approval history. Preview renders text, not HTML or MDX. Automated privacy checks
are conservative but incomplete; review every word and obtain any necessary
permissions before sharing third-party text. No automatic media export is included.

## Optional Git-backed website adapter

The reference adapter updates `public/data/articles.json` in an explicitly chosen
static-site repository. That site must validate the `smc-article-v1` array via
`npm run validate:content`. A Markdown/JSON export is enough for other renderers;
no GitHub, Cloudflare, OpenClaw, or specific CMS is mandatory.

```sh
# Uses the existing protected SMC_API_URL and SMC_TOKEN_FILE configuration.
# Default: fetch an already-approved exact revision and preview the local change.
python -m app.workspace.publish DRAFT_ID \
  --hash APPROVED_CONTENT_HASH --destination my-site --site /absolute/site

# Explicitly write, validate, commit the one collection, and push normally.
python -m app.workspace.publish DRAFT_ID \
  --hash APPROVED_CONTENT_HASH --destination my-site --site /absolute/site \
  --write --commit --push
```

The destination label must match approval. Before writing, configure the protected
`SMC_PUBLISH_TARGETS_FILE` outside the public repository, mapping each label to
`repository` (absolute path), `remote` (e.g. origin), `url` (exact Git push URL),
and `branch` (e.g. main). The adapter verifies this binding and refuses changed
targets on retries. Do not let source
content choose the checkout or Git remote. The tool requires a clean worktree,
rejects redirected/symlinked collections, validates before committing, and never
force-pushes. Private receipts live beside the protected credential file, outside
the site repository. A failed push resumes the recorded commit only if HEAD is
unchanged. `pushed` does not mean deployment verified; check the site's deployment
separately. An edited article requires fresh approval. Withdrawal is an explicit
site operation, never an automatic side effect of source archival.

## Upgrade, tests, and rollout

Eight additive tables hold summaries, map cache, source index pointers, facets,
topic links, drafts, draft revisions, and export receipts. Take and restore-test a
consistent protected application backup before deploying. Encryption is an operator
policy; plaintext backups expose their contents to anyone with storage access. SQLite stays on local
disk; no NAS relocation or historical cleanup is required. Old releases can ignore
these tables, but restoring an old backup loses new writing/review state.

Regression coverage lives in `test_summary_editorial.py`, `test_knowledge.py`,
`test_publishing_adapter.py`, and the workspace browser suite. Live model quality,
account policy compatibility, host deployment, and actual blog publication are
separate checks—not implied by a green fixture suite.
