---
title: Getting Started
---

# Getting Started

This is the shortest path to a working SaveMyContext setup.

## What you need

- `uv` for the backend install
- Chrome or another Chromium browser
- `pnpm` to build the extension bundle
- An OpenAI-compatible key or Google AI key if you want richer AI summaries and graph extraction

SaveMyContext still works without an AI key, but it falls back to simpler heuristics.

## 1. Install and start the backend

Recommended local install:

```bash
uv tool install savemycontext
savemycontext service install --start
```

That installs SaveMyContext as a user service and starts it in the background.

Useful checks:

```bash
savemycontext service status
savemycontext service logs -f
savemycontext config path
```

If you do not want a background service yet, run it in the foreground:

```bash
savemycontext config init
savemycontext run
```

The default local backend URL is:

```text
http://127.0.0.1:18888
```

## 2. Add an AI provider to the backend

For best results, configure an OpenAI-compatible backend such as OpenRouter:

```bash
savemycontext config set \
  --openai-api-key YOUR_KEY \
  --openai-base-url https://openrouter.ai/api/v1 \
  --openai-model openai/gpt-4.1-mini
```

You can also use a Google key:

```bash
savemycontext config set --google-api-key YOUR_KEY
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

Open the SaveMyContext settings page from the extension and enter your backend URL.

- Local backend: `http://127.0.0.1:18888`
- Remote backend: `https://your-domain`

If your backend already uses app-token auth, create a token and paste it into the extension settings:

```bash
savemycontext init-admin --username admin
savemycontext token create --name chrome-extension --scope ingest --scope read
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

## Read next

- [Using SaveMyContext](using-save-my-context.md)
- [Vault and Storage](vault-and-storage.md)
- [Troubleshooting](troubleshooting.md)
