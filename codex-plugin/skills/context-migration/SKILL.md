---
name: context-migration
description: Use when the user wants to save Codex work into SaveMyContext, export a complete context handoff, or migrate a conversation between Codex, Claude, and SaveMyContext.
---

# SaveMyContext Context Migration

Use SaveMyContext as the durable store for agent conversations and handoffs.

## What To Preserve

When preparing a migration bundle, include:

- Goal and latest user request.
- Full message history available from the transcript.
- Current working directory, model, permission mode, branch/status details if relevant, and environment assumptions.
- Files changed, tests run, failures, pending work, blockers, and exact commands that matter.
- Any source transcript path or exported artifact path.

## Backend API

SaveMyContext accepts portable context bundles at:

```text
POST {SAVEMYCONTEXT_BACKEND_URL:-http://127.0.0.1:18888}/api/v1/context/import
```

Export a stored session from:

```text
GET /api/v1/context/export/{session_id}
```

Use `SAVEMYCONTEXT_BACKEND_TOKEN` or `SMC_BACKEND_TOKEN` as a bearer token when the backend is not in local bootstrap mode.

## Utility Script

This plugin ships a utility at:

```text
hooks/savemycontext_codex_hook.py
```

From the plugin root:

```bash
python3 hooks/savemycontext_codex_hook.py export --provider codex --transcript <codex-transcript-path> --out-dir savemycontext-context-bundles
python3 hooks/savemycontext_codex_hook.py export --provider claude --transcript <claude-transcript-path> --out-dir savemycontext-context-bundles
python3 hooks/savemycontext_codex_hook.py import savemycontext-context-bundles/<bundle>.json
python3 hooks/savemycontext_codex_hook.py dump-markdown --provider codex --markdown .savemycontext/<handoff-file>.md
```

The export command writes both JSON and Markdown. Use the JSON for SaveMyContext import and the Markdown when pasting a complete handoff into another interface.

For user-invoked saves, prefer the `save-context` skill. It asks Codex to author the Markdown handoff first, then uses `dump-markdown` only to upload the file.

## Hook Behavior

When the plugin is enabled and its hooks are trusted, the `Stop` hook reads Codex's `transcript_path`, converts it into a `savemycontext.context.v1` bundle, and posts it to SaveMyContext. If the backend is unreachable, it writes an offline bundle under the plugin data directory so the context can be imported later.
