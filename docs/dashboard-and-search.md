---
title: Dashboard and Search
---

# Dashboard and Search

The extension gives you three main ways to work with saved context: the popup, the dashboard, and the quick search overlay.

## The popup

The popup is the fastest control surface. It shows:

- backend connection status
- the latest synced session
- corpus mix by pile
- history sync status
- processing status
- provider drift alerts when a provider site changes in a way that affects capture

From the popup you can:

- `Save page`
- `Search page`
- open the `Dashboard`
- open `Settings`
- run the processing queue when experimental browser processing is enabled

## The dashboard

The dashboard lives inside the extension and reads from the backend API. It has three top-level views:

### Overview

Use this for the high-level snapshot:

- total sessions
- total messages
- total fact triplets
- graph node count
- recent activity
- provider mix
- pile breakdown

### Knowledge

Use this for graph-heavy exploration:

- graph nodes and edges
- top entities
- relationship density
- quick jumps into factual workspaces

### Operations

Use this to inspect storage and pipeline health:

- backend status
- vault path
- to-do list path
- auth mode
- git availability
- sync timing
- processing mode

## Pile workspaces

Each pile has its own workspace page. These are especially useful once your archive grows.

### Atlas

The atlas view combines graph structure, note lists, and filters. Use it when you want to see how notes and entities cluster together.

### Storylines

Storylines group related notes into larger threads. Use this when you want guided exploration instead of a raw graph.

### Graph Ops

Graph Ops focuses on retrieval quality and graph maintenance. Use it to spot weakly connected areas and inspect graph quality issues.

## Note reader

When you open a note, SaveMyContext gives you three views:

- `Overview`: structured metadata and note summary
- `Transcript`: the captured conversation messages
- `Markdown`: the raw saved Markdown note

This is useful when you want both a readable summary and the original stored text in one place.

## Search behavior

Search can return four kinds of results:

- `session`: a synced conversation note
- `entity`: a graph entity derived from factual triplets
- `source_capture`: a saved page or saved selection
- `todo_list`: the shared to-do file

Search results include enough metadata to help you decide what to open next, including pile, provider, and note path when available.

## When to use which tool

- Use the popup when you want a quick save or a status check.
- Use quick search when you are already on a web page and want to pull saved context into the current task.
- Use the dashboard when you want to understand the archive as a whole.
- Use pile workspaces when you already know the kind of material you want to explore.

## Read next

- [Using SaveMyContext](using-save-my-context.md)
- [Vault and Storage](vault-and-storage.md)
- [Troubleshooting](troubleshooting.md)
