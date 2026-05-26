---
name: save-context
description: Save, dump, upload, log, or hand off the current Claude Code context to SaveMyContext as Markdown.
allowed-tools: Bash(python3 *)
---

# Save Context

Create an agent-authored Markdown handoff from the current Claude Code session, upload that Markdown to SaveMyContext, and copy it to the user's clipboard.

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

After writing the Markdown file, run:

```bash
python3 ${CLAUDE_SKILL_DIR}/scripts/dump_markdown.py --provider claude --markdown .savemycontext/<handoff-file>.md
```

Use `--title` when there is a clear title, and add `--custom-tag` values if the user gives a project, pile, or migration label.

The uploader copies the Markdown to the clipboard by default, even if the backend upload falls back to an offline bundle. Use `--no-clipboard` only for headless automation.
