---
title: SaveMyContext
description: A lightweight capture companion and private memory workspace.
---

# SaveMyContext

Keep useful context from AI conversations in a private workspace you control.
The browser extension captures; the workspace is where you search, review memories,
manage tasks, and organize projects.

[Get started](getting-started.md) · [Using the extension](using-save-my-context.md) ·
[Architecture](architecture.md) · [Contributing](contributing.md)

The interface can also be [built and hosted independently or embedded](frontend.md),
without the extension or any particular dashboard.

## A small extension, one workspace

- Automatic capture of supported conversation responses in ChatGPT, Gemini, and Grok.
- Explicit history import, including ChatGPT Projects and project-only conversations.
- Durable delivery with retries, visible capture errors, and pause/resume.
- Optional page/selection capture and quick search.
- One workspace for memory, inbox, tasks, and projects, shared by the standalone
  backend, extension fallback, and private dashboard integrations.

No graph explorer, duplicate to-do interface, prompt manager, or browser inference
runner is bundled in the extension. No model or hosted account is required for
capture, local search, notes, or explicit tasks.

## Own your data

A self-hosted API owns the SQLite ledger. Optional cold evidence archives and
Basic Memory search projections do not replace that ledger. Browser tokens stay
in local extension storage, not browser sync. External processing is opt-in.

Browser adapters use your existing provider session; provider websites can change.
Errors are surfaced rather than treated as successful captures. Agent context
handoffs use the CLI/skill instead of pretending every provider has a browser adapter.

SaveMyContext is open source under the [Apache License 2.0](https://github.com/nociza/SaveMyContext/blob/main/LICENSE).
Read the [privacy policy](privacy.md) before enabling capture.
