# SaveMyContext

SaveMyContext turns your conversations with ChatGPT, Gemini, and Grok into a private knowledge base you actually keep.

It runs a backend you control, syncs through a Chrome extension, and writes everything into searchable notes, dashboards, a shared to-do list, and an Obsidian-friendly Markdown vault.

## Scenarios

- **Tesla + Grok:** you talk through an idea, trip plan, or problem while driving. Later, that Grok conversation is already in your knowledge base instead of trapped in the car.
- **ChatGPT research:** you run long research threads, compare options, and refine questions. SaveMyContext archives the thread, classifies it, and keeps it searchable with the rest of your notes.
- **Gemini journal and planning:** you use Gemini for journaling, reflection, or task planning. SaveMyContext files it into your journal, ideas, or shared to-do list instead of leaving it buried in chat history.

## What You Get

- automatic history sync from ChatGPT, Gemini, and Grok
- saved pages and saved text selections alongside chat history
- a searchable dashboard, graph, and quick search inside the extension
- a local Markdown vault that works well with Obsidian
- one-host remote setup with a single pasteable connection string

## Quick Start

Install the backend:

```bash
uv tool install savemycontext
smc install --remote
```

The package name is `savemycontext`. The command is `smc`.

Build and load the extension:

```bash
cd extension
pnpm install
pnpm run dev
```

Then open `chrome://extensions`, enable Developer Mode, and load `extension/dist`.

Paste the emitted `smc_conn_1_...` string into the extension's `Connection string` field.

Then just use ChatGPT, Gemini, or Grok normally. SaveMyContext syncs in the background.

If you only want local sync on one machine, use:

```bash
smc install
```

## What Happens After Sync

- research-heavy chats are archived as factual notes and graph data
- reflective chats are filed into your journal
- brainstorming threads become idea notes
- explicit task-editing chats update the shared to-do list
- raw source material stays stored alongside the cleaned note

If you configure an AI provider, SaveMyContext produces richer summaries and structure. Without one, it still captures and organizes your data with simpler heuristics.

## Share It Across Devices

The common path is:

```bash
smc install --remote
```

Later, you can issue more connection strings with:

```bash
smc share
smc invite --device laptop
smc invite --security per_device_code --device work-laptop
```

## Docs

- [Getting Started](docs/getting-started.md)
- [Using SaveMyContext](docs/using-save-my-context.md)
- [Remote Access](docs/remote-access.md)
- [Security and Access](docs/security-and-access.md)
- [Dashboard and Search](docs/dashboard-and-search.md)
- [Vault and Storage](docs/vault-and-storage.md)
- [Troubleshooting](docs/troubleshooting.md)

## Development

Backend:

```bash
cd backend
uv sync
uv run pytest -q
```

Extension:

```bash
cd extension
pnpm test
pnpm typecheck
pnpm build
```
