# SaveMyContext Claude Code Plugin

This plugin adds a `save-context` skill for Claude Code. The skill asks Claude to create a Markdown handoff from the current session, copies that Markdown to the clipboard, and uploads the exact Markdown to SaveMyContext.

## Install

Load this folder as a Claude Code plugin during development:

```bash
claude --plugin-dir ./claude-plugin
```

The command appears as:

```text
/savemycontext:save-context
```

Set these environment variables when needed:

```bash
export SAVEMYCONTEXT_BACKEND_URL=http://127.0.0.1:18888
export SAVEMYCONTEXT_BACKEND_TOKEN=<token-if-required>
```

Local bootstrap mode does not require a token until a SaveMyContext app token exists.
