---
title: Standalone and Embedded Interface
---

# Standalone and Embedded Interface

The interface is a separate `frontend/` package. It does not require the maintainer's
dashboard, a browser extension, or Python to build. The same component serves all
three interfaces; the core API remains the sole database owner.

## Build and host independently

```sh
cd frontend
npm test
npm run build
```

Node 22+ is sufficient. Serve `dist/` on a static web host; subdirectory hosting
is supported. Configure `dist/assets/config.json` with an API address:

```json
{ "apiBase": "https://api.example.com/api/v1/workspace", "view": "memory" }
```

Same-origin reverse proxies can keep the default `/api/v1/workspace`. Separate
origins require an exact backend allowlist, for example
`SAVEMYCONTEXT_CORS_ORIGINS='["https://ui.example.com"]'`. Use HTTPS in production;
HTTP is accepted only for loopback development. Do not store credentials in public
configuration or URLs. The standalone login keeps a scoped token only in tab memory.

Set `SAVEMYCONTEXT_WORKSPACE_UI_ENABLED=false` for a headless core API. Leave it
enabled for the convenient bundled `/workspace`; no Node installation is needed
to run a Python wheel. That distribution is generated from the frontend source.

## Embed into your own interface

```js
import { mountWorkspace } from "/smc/assets/embed.js";
const view = mountWorkspace(document.getElementById("memory"), {
  apiBase: "/api/memory",
  view: "memory"
});
// Set view.token through your existing authentication flow if needed.
// view.remove() unmounts the component and stops polling.
```

Bundlers can import `@savemycontext/ui/embed` after installing the local frontend
package. Existing `smc-workspace` elements and the two-file `workspace.js` /
`workspace.css` embed contract remain supported. CSS is Shadow-DOM isolated.
Changing a mounted component's API address clears the previous token and displayed
data; the host must explicitly provide credentials for the new destination.

See the [frontend package guide](https://github.com/nociza/SaveMyContext/tree/main/frontend)
for the complete embedding and generated-asset workflow.
