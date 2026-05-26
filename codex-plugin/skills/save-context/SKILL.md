---
name: save-context
description: Use when the user asks to save, dump, upload, log, or hand off the current Codex context to SaveMyContext as Markdown.
---

# Save Context

Create an agent-authored Markdown handoff from the current Codex session, upload that Markdown to SaveMyContext, and copy it to the user's clipboard.

## Markdown Requirements

Write a single Markdown file under `.savemycontext/` in the current workspace. Include the information another agent would need to continue the work:

- Current objective and latest user request.
- Current state and decisions already made.
- Important constraints, assumptions, risks, and unresolved questions.
- Files changed or inspected, with paths.
- Commands run, test results, failures, and verification status.
- Tool calls or external actions that matter.
- Artifacts, generated files, screenshots, local paths, or URLs.
- Next steps.

Do not rely on the uploader to summarize the session. The Markdown file is the portable context artifact.

## Upload Command

After writing the Markdown file, run the bundled uploader from this plugin:

```bash
python3 <plugin-root>/hooks/savemycontext_codex_hook.py dump-markdown --provider codex --markdown .savemycontext/<handoff-file>.md
```

Resolve `<plugin-root>` from the loaded skill path. For this skill it is two directories above this `SKILL.md`.

The uploader copies the Markdown to the clipboard by default, even if the backend upload falls back to an offline bundle. Use `--no-clipboard` only for headless automation.

Use `--title` when there is a clear title, and add `--custom-tag` values if the user gives a project, pile, or migration label.
