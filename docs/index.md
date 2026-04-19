---
title: SaveMyContext Docs
---

# SaveMyContext

SaveMyContext turns AI conversations and saved web pages into a local knowledge base. It captures chats from ChatGPT, Gemini, and Grok, syncs them to a backend you control, writes an Obsidian-friendly Markdown vault, and gives you search and dashboard views inside the extension.

## Common scenarios

- **Tesla + Grok:** talk through ideas or decisions while driving and have that conversation waiting in your vault later.
- **ChatGPT research:** archive long research threads automatically so they stay searchable after the browser tab is gone.
- **Gemini journaling:** use Gemini for reflection, daily notes, or task planning and have those chats filed into a journal or shared to-do list.

## What you get

- automatic history sync from supported AI chat providers
- saved pages and text selections alongside your chats
- searchable notes, dashboards, and graph views
- a local Markdown vault with readable notes and source material
- one-host remote access with a single pasteable connection string

## Start here

- [Getting Started](getting-started.md)
- [Using SaveMyContext](using-save-my-context.md)
- [Dashboard and Search](dashboard-and-search.md)
- [Vault and Storage](vault-and-storage.md)
- [Security and Access](security-and-access.md)
- [Remote Access](remote-access.md)
- [Troubleshooting](troubleshooting.md)
- [Contributing](contributing.md)

## Typical flow

1. Run `smc install` or `smc install --remote`.
2. Load the extension and connect it.
3. Use ChatGPT, Gemini, or Grok normally.
4. Let SaveMyContext sync in the background.
5. Search the result in the extension or open the vault in Obsidian.

## Important behavior

- Remote backends must use `https://`.
- A fresh local backend can be used without a token only until the first app token is created.
- After the first app token exists, all protected access, including `http://127.0.0.1` and `http://localhost`, requires that token.
- The extension expects a token with `ingest` and `read` scopes.

## Read next

- [Getting Started](getting-started.md)
- [Security and Access](security-and-access.md)
