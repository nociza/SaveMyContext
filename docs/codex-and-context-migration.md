# Codex and Context Migration

SaveMyContext includes agent plugin packages for Codex and Claude Code:

```text
codex-plugin/
claude-plugin/
```

The plugin has two jobs:

- Log Codex sessions into the same SaveMyContext backend used by the Chrome extension.
- Let Codex or Claude Code author a large Markdown context handoff, then store that exact Markdown in SaveMyContext.
- Create portable `savemycontext.context.v1` bundles for moving work between Codex, Claude, and other interfaces.

## Backend Endpoints

Import a context bundle:

```http
POST /api/v1/context/import
```

Export a stored SaveMyContext session:

```http
GET /api/v1/context/export/{session_id}
```

The bundle preserves provider, source interface, session id, account, title, source URL, captured time, custom tags, metadata, artifacts, messages, raw transcript data, processed pile outputs, triplets, and the Markdown handoff.

## Web Chat Dumps

When the extension popup is opened on a ChatGPT, Gemini, Grok, or Claude page, it shows a Markdown dump action. The action:

- prefers the already-scraped SaveMyContext session when the current browser tab has a captured session id;
- falls back to extracting the visible chat from the page DOM;
- stores the Markdown as a `savemycontext.context.v1` handoff when the backend is reachable;
- copies the Markdown directly to the user's clipboard.

Claude web pages use the DOM fallback path because they do not currently have a network scraper.

## Codex Plugin

The plugin root is:

```text
codex-plugin/
```

Its default hook file is:

```text
codex-plugin/hooks/hooks.json
```

When enabled and trusted in Codex, the `Stop` hook reads Codex's `transcript_path`, converts it to a context bundle, and posts it to the backend. If the backend is unavailable, it writes the bundle under the plugin data directory for later import.

The `save-context` skill is the preferred user-invoked command. It asks Codex to write the handoff Markdown from the live session context, then copies that Markdown to the clipboard and uploads it:

```bash
python3 codex-plugin/hooks/savemycontext_codex_hook.py dump-markdown --provider codex --markdown .savemycontext/<handoff-file>.md
```

The uploader does not summarize the session. It wraps the Markdown as a `savemycontext.context.v1` import, stores the Markdown as a `handoff_markdown` artifact, posts it to the backend, and reports whether clipboard copy succeeded. Use `--no-clipboard` only for headless automation.

## Claude Code Plugin

The Claude Code plugin root is:

```text
claude-plugin/
```

Load it during development with:

```bash
claude --plugin-dir ./claude-plugin
```

The command appears as:

```text
/savemycontext:save-context
```

Claude Code writes the Markdown handoff, copies it to the clipboard, and uploads it with the bundled skill script:

```bash
python3 ${CLAUDE_SKILL_DIR}/scripts/dump_markdown.py --provider claude --markdown .savemycontext/<handoff-file>.md
```

Configure the backend with:

```bash
export SAVEMYCONTEXT_BACKEND_URL=http://127.0.0.1:18888
export SAVEMYCONTEXT_BACKEND_TOKEN=<token-if-required>
```

## Manual Exports

From `codex-plugin/`:

```bash
python3 hooks/savemycontext_codex_hook.py export --provider codex --transcript <codex-transcript-path>
python3 hooks/savemycontext_codex_hook.py export --provider claude --transcript <claude-transcript-path>
python3 hooks/savemycontext_codex_hook.py import savemycontext-context-bundles/<bundle>.json
python3 hooks/savemycontext_codex_hook.py dump-markdown --provider codex --markdown .savemycontext/<handoff-file>.md
```

Use the JSON file for SaveMyContext import. Use the Markdown file as a complete pasteable handoff into another AI interface. Use `dump-markdown` when an agent has already authored the Markdown and you want SaveMyContext to store that exact artifact.
