---
title: SaveMyContext Docs
---

# SaveMyContext

SaveMyContext turns AI conversations and saved web pages into a local knowledge base. It captures chats from ChatGPT, Gemini, and Grok, syncs them to a self-hosted backend, writes an Obsidian-friendly Markdown vault, builds a lightweight knowledge graph, and gives you search and dashboard views inside the extension.

## What SaveMyContext gives you

- Automatic history sync from supported AI chat providers
- Manual page and text-selection capture from regular web pages
- Category-based notes for `journal`, `factual`, `ideas`, and `todo`
- Search across notes, entities, saved sources, and the shared to-do list
- A graph view, category workspaces, and a note reader inside the extension
- Local Markdown files with matching source documents and optional git history

## How it is organized

1. The backend stores data, runs processing, and writes the vault.
2. The Chrome extension captures conversations and gives you save, search, and dashboard tools.
3. The vault stores readable notes, raw source files, graph files, and dashboards on disk.

## Start here

- [Getting Started](getting-started.md)
- [Using SaveMyContext](using-save-my-context.md)
- [Dashboard and Search](dashboard-and-search.md)
- [Vault and Storage](vault-and-storage.md)
- [Security and Access](security-and-access.md)
- [Troubleshooting](troubleshooting.md)
- [Contributing](contributing.md)

## Typical workflow

1. Start the backend.
2. Load the extension and connect it to the backend.
3. Visit ChatGPT, Gemini, or Grok while signed in.
4. Let history sync run, or save a page or selection manually.
5. Open the popup or dashboard to search, inspect notes, and browse the graph.
6. Open the vault in Obsidian if you want direct file access.

## Important behavior

- Remote backends must use `https://`.
- A fresh local backend can be used without a token only until the first app token is created.
- After the first app token exists, all protected access, including `http://127.0.0.1` and `http://localhost`, requires that token.
- The extension expects a token with `ingest` and `read` scopes.

## Read next

- [Getting Started](getting-started.md)
- [Security and Access](security-and-access.md)
