# SaveMyContext interface

One framework-independent UI, independently buildable as a static website or
embeddable in another application. This directory does not require the Python
backend or browser extension to build. It does require a compatible SMC API to
read and write data; it is not a second database or an offline replica.

## Standalone website

Node.js 22+ is sufficient; there are no npm dependencies to install.

```sh
cd frontend
npm test
npm run build
```

Serve `dist/` using any static web server, including under a URL subdirectory.
For a local preview, `python3 -m http.server 8080 --directory dist` is one option;
Python is not required for the frontend build itself.

The default API is `/api/v1/workspace` on the UI's origin. Reverse-proxy that path
to your private core API, or edit the deployed `dist/assets/config.json`:

```json
{ "apiBase": "https://api.example.com/api/v1/workspace", "view": "memory" }
```

The configuration is public. Never put a token in it, the page URL, HTML attributes,
or source control. API addresses must use HTTPS (loopback HTTP is allowed locally).
Serve the frontend over HTTPS in production. The token form keeps credentials only
in memory for the current tab; a reload requires reconnecting. It does not persist
them to cookies, localStorage, or sessionStorage.

For a separate UI origin, explicitly allow that **exact** origin on the API:

```sh
SAVEMYCONTEXT_CORS_ORIGINS='["https://ui.example.com"]'
```

CORS is not authentication. The API still needs private network/access controls
and an application token with `read` and `workspace:write` for workspace edits.
Do not use a wildcard origin or embed a service-wide token in a public website.
Cross-origin requests use the supplied bearer token, not cross-origin cookies.
A same-origin authenticated proxy can keep the backend credential server-side.
Give HTML and runtime config a revalidation/no-store cache policy when deploying.

## Embed in a dashboard

Use the published static build without a bundler:

```html
<div id="memory"></div>
<script type="module">
  import { mountWorkspace } from "/smc/assets/embed.js";
  const workspace = mountWorkspace(document.getElementById("memory"), {
    apiBase: "/api/memory",
    view: "memory"
  });
  // For token-authenticated hosts, assign workspace.token from your auth flow.
  // workspace.remove() unmounts it and stops its refresh timer.
</script>
```

With a bundler, install this directory as a local package and import
`mountWorkspace` from `@savemycontext/ui/embed`. The extension uses this same package.
The returned element exposes `token` and `load()`. Styles are isolated in its Shadow
DOM, so host CSS cannot accidentally restyle the entire interface.

The declarative contract remains available: import `workspace.js`, then mount
`<smc-workspace api-base="/api/memory" view="memory"></smc-workspace>`.
Set the token as a JavaScript property, never as an HTML attribute. Changing
`api-base` on a connected component clears its old token and data; supply a new
token explicitly. Captured text is escaped; host configuration is trusted.

## Core API only / bundled convenience UI

Set `SAVEMYCONTEXT_WORKSPACE_UI_ENABLED=false` to run the backend without static
UI routes. API, ingestion, and worker behavior are unchanged. The default remains
`true`, preserving `/workspace` and `/workspace-assets/*` for existing deployments.

`frontend/src/` is the source of truth. The Python package vendors generated assets
so installed wheels work without Node or this repository:

```sh
npm run build:backend
npm run check:backend
```

Do not edit `backend/app/workspace/web/` directly. CI checks for drift between
that distribution and this source. The backend supplies its configured API prefix
at runtime; standalone hosts supply their own `assets/config.json`.

Licensed under Apache-2.0; see [LICENSE](LICENSE). `private: true` prevents
accidental npm publication and does not restrict reuse under that license.
