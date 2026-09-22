---
title: Getting Started
---

# Getting Started

Build from this repository to get the current capture companion and shared workspace.
Python 3.12+, uv, Node.js, pnpm, and a Chromium browser are needed.

## 1. Start the private backend

```sh
git clone https://github.com/nociza/SaveMyContext.git
cd SaveMyContext/backend
uv sync --frozen
uv run uvicorn app.main:app --host 127.0.0.1 --port 18888
```

Open `http://127.0.0.1:18888/workspace`. Runtime data stays in the ignored
`backend/data/` directory. No model key is required. External interpretation is
off by default; capture does not infer commitments from arbitrary conversation text.

Loopback bootstrap works only before an application token exists. For a remote
backend, use HTTPS, private access controls, and a scoped token. Do not expose an
unauthenticated service. See [security](security-and-access.md).

## 2. Build the extension

In another terminal:

```sh
cd SaveMyContext/extension
pnpm install --frozen-lockfile
pnpm build
```

Open your browser's extensions page, enable Developer mode, and load
`extension/dist` as an unpacked extension. After rebuilding an existing installation,
click Reload on its extension card.

## 3. Connect

Open extension Settings. Enter the backend URL and scoped token, or use an existing
connection bundle. The default URL matches the backend command above.

Capture and quick search require `ingest` and `read`. Editing through the built-in
workspace also requires `workspace:write`; a capture-only token cannot edit tasks.
Tokens are kept in local browser storage and are never added to workspace links.

Optionally set **Workspace URL** to your authenticated dashboard page. Leave it
blank to use the bundled instance of the same shared workspace component.
Remote backends request only their required host permission when you connect.

## 4. Capture and import

Visit a supported AI conversation while signed in. Supported response traffic
is captured as you work. To import older conversations, open the popup from that
provider tab and choose **Import history**, then confirm.

New installations do not automatically import all history. Existing installations
keep their previous setting. Optional automatic/scheduled imports and capture
filters remain in Settings.

Pause stops new saves and queued delivery; it does not erase existing evidence.
An already-sent request may finish. Activity while paused is not captured; import
history after resuming if you need to recover it.

## Upgrading from the old extension

The old dashboard, pile, note, and prompt URLs redirect to the shared workspace.
The extension no longer runs AI prompts in provider tabs or changes backend
storage paths. No database migration or deletion is required for this update.

[Using SaveMyContext](using-save-my-context.md) · [Troubleshooting](troubleshooting.md)
