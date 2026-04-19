---
title: Troubleshooting
---

# Troubleshooting

This page covers the problems you are most likely to run into during setup and normal use.

## The extension will not save my backend URL

Check these first:

- the URL is correct
- the backend is running
- remote URLs use `https://`
- the token is valid
- the token includes `ingest` and `read`

Useful backend commands:

```bash
smc status
smc logs -f
smc doctor
```

## Localhost suddenly started asking for a token

That is expected after the first app token is created.

SaveMyContext allows token-free loopback access only while there are no active tokens. Once any active token exists, all protected API access requires a token, including `127.0.0.1` and `localhost`.

## History sync is not running

Check the obvious inputs first:

- `Auto Sync History` is enabled
- the provider is enabled in settings
- you are signed in on the provider website
- you are visiting a supported provider page

If the popup or settings page shows a provider drift alert, the provider site may have changed enough to break capture. That is a signal to update the extension or inspect the provider-specific issue.

## Notes are syncing but AI summaries are missing

That usually means the backend does not have a working AI provider configured.

SaveMyContext can still:

- store the conversation
- write the note
- use heuristic classification

But richer outputs such as idea summaries, factual triplets, and cleaner source capture notes work best with an OpenAI-compatible key or Google key configured on the backend.

## The shared to-do list did not change

SaveMyContext only updates `To-Do List.md` for explicit shared-list editing requests.

If a conversation is general planning, reflection, or scheduling, it will stay in `journal` or another category instead of changing the shared list.

## Quick search opens, but nothing inserts

Quick search can insert text only when there is an active editable target:

- input
- textarea
- rich-text editor

Focus the field where you want the result inserted, then open quick search again.

## Quick search or page save does not work on the current tab

Those features only work on regular `http://` or `https://` pages. Browser internal pages, extension pages, and other restricted surfaces are outside the normal content-script path.

## The selection capture bubble does not appear

Check these conditions:

- `Selection Capture` is enabled in settings
- you selected actual text
- the current page is a regular `http://` or `https://` page

## Changing the knowledge storage path failed

Make sure the new path:

- is absolute, or uses `~`
- points to a directory, not a file
- is writable by the backend process

Also remember that storage changes are an admin operation. A standard extension token with only `ingest` and `read` will not be enough.

## A synced conversation looks outdated

Revisit the provider and let history sync run again. SaveMyContext now treats full conversation snapshots as authoritative, so updated message content, order changes, and removed messages should be reflected in the local copy after a fresh sync.

## Where to look when something feels wrong

- popup: connection state, history sync, processing state
- settings page: backend validation, provider drift alert, knowledge path state
- dashboard: system status, graph counts, category breakdown
- vault: source documents in `Sources/` when you need the raw material

## Read next

- [Security and Access](security-and-access.md)
- [Vault and Storage](vault-and-storage.md)
