---
title: Getting Started
---

# Getting Started

This is the shortest path to a working SaveMyContext setup, with clear expectations for what happens after you install it.

## What you need

- `uv` for the backend install
- Chrome or another Chromium browser
- `pnpm` to build the extension bundle
- An OpenAI-compatible key or Google AI key if you want richer AI summaries and graph extraction

SaveMyContext still works without an AI key, but it falls back to simpler heuristics.

## 1. Pick your setup

### One machine only

If you just want the backend on the machine you are using right now:

```bash
uv tool install savemycontext
smc install
```

### One host for all of your devices

If this machine should serve your laptop, phone, tablet, or other Chrome profiles too:

```bash
uv tool install savemycontext
smc install --remote
```

That installs SaveMyContext as a user service, starts it in the background, enables managed remote access, and prints the first connection string.

The package name is still `savemycontext`; it installs the `smc` command.

Useful checks:

```bash
smc status
smc logs -f
smc config path
```

If you do not want a background service yet, run it in the foreground:

```bash
smc config init
smc run
```

The default local backend URL is:

```text
http://127.0.0.1:18888
```

## 2. Add an AI provider to the backend

SaveMyContext still captures and stores everything without an AI key. Add one if you want cleaner summaries, better classification, and richer graph extraction.

A simple OpenAI-compatible setup looks like this:

```bash
smc config set \
  --openai-api-key YOUR_KEY \
  --openai-base-url https://openrouter.ai/api/v1 \
  --openai-model openai/gpt-4.1-mini
```

You can also use a Google key:

```bash
smc config set --google-api-key YOUR_KEY
```

## 3. Build and load the extension

The extension is currently loaded unpacked.

```bash
cd extension
pnpm install
pnpm run dev
```

Then open `chrome://extensions`, enable Developer Mode, and load `extension/dist`.

## 4. Connect the extension to the backend

Open the SaveMyContext settings page from the extension.

### Fast remote setup

If you ran `smc install --remote`, you already have the first connection string. Paste that `smc_conn_1_...` value into the extension's `Connection string` field.

If you want to mint another reusable string later:

```bash
smc share
```

If you do not pass `--username`, the CLI automatically manages the local owner account used for issued device tokens.

For stronger policies, create per-device bundles instead:

```bash
smc invite --device laptop
smc invite --security per_device_code --device work-laptop
```

### Manual setup

You can also enter the backend URL and token directly if you do not want to use connection strings.

- Local backend: `http://127.0.0.1:18888`
- Remote backend: `https://your-domain`

If your backend already uses app-token auth, create a token and paste it into the extension settings:

```bash
smc init-admin --username admin
smc token create --name chrome-extension --scope ingest --scope read
```

The extension validates the backend before saving the settings. It checks:

- that the server is actually SaveMyContext
- that the extension version is compatible
- that remote URLs use `https://`
- that the token is valid
- that the token includes `ingest` and `read`

## 5. Turn on the features you want

In the extension settings you can control:

- `Auto Sync History`
- enabled providers: ChatGPT, Gemini, and Grok
- indexing mode: index everything or require trigger words
- blacklist words
- selection capture

## 6. Trigger the first sync

Visit ChatGPT, Gemini, or Grok while signed in. When `Auto Sync History` is enabled, SaveMyContext will:

1. read available conversation history from the provider site
2. sync the conversations to the backend
3. classify each conversation
4. write Markdown notes and related source files
5. update the graph and dashboards

Open the extension popup and then `Dashboard` to confirm that sessions, messages, and graph data are appearing.

Three concrete first-run checks:

- ask ChatGPT to help with research and confirm the session appears in `factual`
- use Gemini for a journal-style reflection and confirm it lands in `journal`
- ask the model to update a shared task list and confirm `To-Do List.md` changes

## Read next

- [Using SaveMyContext](using-save-my-context.md)
- [Vault and Storage](vault-and-storage.md)
- [Troubleshooting](troubleshooting.md)
