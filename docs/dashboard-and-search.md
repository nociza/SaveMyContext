---
title: Workspace and Search
---

# Workspace and Search

Use **Open workspace** in the extension popup. By default it opens the bundled
shared workspace; Settings can point it to an authenticated external dashboard.

The same component provides Inbox, Memory, Tasks, and Projects at the backend's
`/workspace` and in dashboard integrations. The API owns all persistent state:
there is no separate extension task database.

The optional quick-search shortcut remains available on permitted pages. Page
selection capture and context suggestions are opt-in. Tokens are never encoded
in external workspace links.

The former extension dashboard, graph explorer, piles, note pages, and prompt
manager have been retired. Their old HTML entry points redirect to the workspace;
old view/filter parameters are not forwarded to external sites.

See [Using SaveMyContext](using-save-my-context.md) for current controls.
