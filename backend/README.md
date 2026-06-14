# SaveMyContext Server

Self-hosted FastAPI backend and Linux/macOS service CLI for SaveMyContext.

## Install As a Tool

Recommended user flow on Linux and macOS:

```bash
uv tool install savemycontext
smc install
```

The package name is `savemycontext`. It installs both `smc` and `savemycontext` command aliases; the docs use `smc`.

On Linux, `smc install` writes a `systemd --user` service. On macOS, it writes a per-user `launchd` agent. If one machine should serve other devices, use:

```bash
smc install --remote
```

Remote setup starts the backend, enables managed remote exposure, and prints a `smc_conn_1_...` connection string for the extension.

Useful commands:

```bash
smc status
smc logs -f
smc config path
smc doctor
```

## Processing

SaveMyContext captures and stores conversations without an AI key. Add an OpenAI-compatible or Google key when you want richer summaries, classification, and graph extraction.

Recommended OpenRouter settings:

```bash
smc config set \
  --openai-api-key your_openrouter_key \
  --openai-base-url https://openrouter.ai/api/v1 \
  --openai-model google/gemma-4-31b-it:free \
  --openai-model-fallbacks google/gemma-4-26b-a4b-it:free,google/gemma-3-27b-it:free,google/gemma-3-12b-it:free,google/gemma-3-4b-it:free,google/gemma-3n-e4b-it:free,google/gemma-3n-e2b-it:free,openai/gpt-4.1-mini
```

You can also edit the generated env file directly:

- Linux: `~/.config/savemycontext/savemycontext.env`
- macOS: `~/Library/Application Support/savemycontext/savemycontext.env`

Browser automation is experimental and disabled by default.

## Vault And To-Do Versioning

SaveMyContext writes the Obsidian vault under `markdown/SaveMyContext`, keeps a shared `Dashboards/To-Do List.md`, and initializes a local git repository in that vault by default. Session notes, dashboards, graph files, and to-do updates are committed automatically.

## Run In the Foreground

```bash
smc config init
smc run
```

## Development

Run the local development server from source with:

```bash
uv sync --group dev
uv run python -m app.dev
```

Run the backend tests with:

```bash
uv run --group dev python -m pytest -q
```
