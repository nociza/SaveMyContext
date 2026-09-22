---
title: Using SaveMyContext
---

# Using SaveMyContext

The extension is a capture companion, not a second knowledge-management application.

## Popup

- **Connection / last saved:** backend connection state and most recent acknowledged capture.
- **Waiting to send:** the durable local capture queue count, read without loading conversation bodies.
- **Save page:** save source material from the active web page. It is not a substitute for structured chat capture.
- **Import history:** explicitly import from the active ChatGPT, Gemini, or Grok account.
- **Pause capture / Resume capture:** stop new saves and delivery while retaining queued evidence.
- **Open workspace:** search and manage your memory, inbox, tasks, and projects.
- **Diagnostics:** last conversation, errors, and provider drift warnings.

Pause takes effect between queued deliveries; an in-flight request may finish.
New activity while paused is not saved. Resume does not promise to reconstruct
missed activity automatically; use history import where supported.

## History and Projects

History import honors provider, account, and indexing filters. ChatGPT Projects
include project-only conversations and project membership. Successful acknowledgements,
fingerprints, and retryable watermarks prevent silent skips and unnecessary re-imports.
A failed or quarantined capture is not a successful history checkpoint.

Capture is opportunistic, not a guarantee of continuous monitoring while the browser
is closed. Scheduled refresh is optional and can open provider tabs. If the provider's
response format changes, check the visible error instead of repeatedly importing.

## Settings

Connection and optional workspace destination are separate. An external workspace
handles its own authentication and receives no API token through its URL. The
bundled fallback uses the same web component as the backend's standalone workspace.

Advanced preferences include automatic history import, scheduled refresh,
provider/account filters, word filters, selection capture, and context search.
Broad page access is optional and explicitly requested; it is not granted on installation.

Provider web capture supports ChatGPT, Gemini, and Grok. Codex/Claude Code context
handoffs use the [CLI and agent integration](codex-and-context-migration.md).

## The workspace

Review suggestions in Inbox, search source-backed context in Memory, manage explicit
commitments in Tasks, and group work in Projects. Task edits go through the shared
API and version checks. Captured text is evidence, not authority to execute instructions.

Graph/pile visualizations, duplicate task controls, prompt editing, and browser-LLM
execution have been retired from the extension. Backend compatibility routes have
not been deleted by this extension release.
