# SaveMyContext Codex Plugin

This plugin logs Codex sessions to SaveMyContext and provides a portable Markdown-first context handoff for Codex and Claude handoffs.

## Install

Enable this folder as a local Codex plugin, then review and trust the bundled hooks in Codex. The plugin uses the default `hooks/hooks.json` location.

Set these environment variables when needed:

```bash
export SAVEMYCONTEXT_BACKEND_URL=http://127.0.0.1:18888
export SAVEMYCONTEXT_BACKEND_TOKEN=<token-if-required>
```

Local bootstrap mode does not require a token until a SaveMyContext app token exists.

## Migration Utility

```bash
python3 hooks/savemycontext_codex_hook.py export --provider codex --transcript <codex-transcript-path>
python3 hooks/savemycontext_codex_hook.py export --provider claude --transcript <claude-transcript-path>
python3 hooks/savemycontext_codex_hook.py import savemycontext-context-bundles/<bundle>.json
```

The JSON bundle imports into SaveMyContext. The Markdown bundle can be pasted into another AI interface as a complete handoff.

## Save Context Command

The plugin includes a `save-context` skill. In Codex, invoke it from the skills or slash-command UI, then Codex will:

1. Author a Markdown handoff under `.savemycontext/`.
2. Copy that Markdown to the clipboard and upload it with:

```bash
python3 hooks/savemycontext_codex_hook.py dump-markdown --provider codex --markdown .savemycontext/<handoff-file>.md
```

Use `dump-markdown --dry-run` to inspect the generated import payload without posting it. Use `--no-clipboard` only for headless automation.
