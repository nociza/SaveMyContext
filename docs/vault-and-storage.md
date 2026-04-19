---
title: Vault and Storage
---

# Vault and Storage

SaveMyContext writes a managed Markdown vault on disk. You can open that vault directly in Obsidian or browse it from the filesystem.

## Default locations

The exact paths depend on how you run SaveMyContext.

### Linux service install

- database: `~/.local/share/savemycontext/savemycontext.db`
- Markdown root: `~/.local/share/savemycontext/markdown`
- vault root: `~/.local/share/savemycontext/markdown/SaveMyContext`
- browser profiles: `~/.local/share/savemycontext/browser-profile/`

### macOS service install

- config: `~/Library/Application Support/savemycontext/config.toml`
- env: `~/Library/Application Support/savemycontext/savemycontext.env`
- database: `~/Library/Application Support/savemycontext/data/savemycontext.db`
- Markdown root: `~/Library/Application Support/savemycontext/data/markdown`
- vault root: `~/Library/Application Support/savemycontext/data/markdown/SaveMyContext`
- browser profiles: `~/Library/Application Support/savemycontext/data/browser-profile/`

You can print the active paths with:

```bash
smc config path
```

## Vault layout

The generated vault looks like this:

```text
SaveMyContext/
  Journal/
  Factual/
  Ideas/
  Todo/
  Sessions/
  Captures/
  Sources/
  Graph/
    Entities/
    Indexes/
  Dashboards/
  README.md
  AGENTS.md
  manifest.json
```

## What each area contains

- `Journal/`, `Factual/`, `Ideas/`, `Todo/`: processed conversation notes
- `Sessions/`: synced conversations that have not been classified yet
- `Captures/`: saved pages and saved selections
- `Sources/`: raw provider payloads and raw source documents
- `Graph/Entities/`: one note per extracted entity
- `Graph/Indexes/`: entity and relationship indexes
- `Dashboards/`: category indexes, graph index, captures index, home dashboard, and the shared to-do list
- `README.md`: a human-facing vault summary
- `AGENTS.md`: a machine-facing summary for tools that read the vault directly
- `manifest.json`: a machine-readable snapshot of counts and entry points

## Session notes and source documents

For each synced conversation, SaveMyContext writes two companion files:

1. a readable processed note
2. a source document with raw sync captures and raw message payloads

For each manual page or selection capture, SaveMyContext also writes:

1. a readable capture note
2. a raw source document

This split makes the vault easier to read without losing the original captured material.

## The shared to-do list

The shared to-do list lives here:

```text
SaveMyContext/Dashboards/To-Do List.md
```

SaveMyContext treats this as one shared file. `todo` conversations update that file instead of creating a separate disconnected task list in each note.

## Git versioning

Git versioning is enabled by default for the vault.

When git is available, SaveMyContext:

- initializes a git repository inside the vault
- commits note changes automatically
- records to-do list updates
- records source capture saves
- records vault relocation changes

This makes the vault easier to audit and roll through over time.

## Moving the vault

To move the vault to a new Markdown root:

```bash
smc config set --markdown-dir /absolute/path
```

You can also change the storage path from the extension settings, but that is an admin operation. In practice:

- local bootstrap access can do it during first setup
- remote setups need an app token that also includes `admin`

When the storage path changes, SaveMyContext rebuilds the managed vault in the new location.

## Read next

- [Security and Access](security-and-access.md)
- [Troubleshooting](troubleshooting.md)
