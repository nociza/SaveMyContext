---
title: Deployment Options
---

# Deployment Options

The supported product is the self-hosted core plus its capture extension and
shared workspace. There is no operating managed hosting service.

Start locally using [Getting Started](getting-started.md), or run the same API
on a private server. Use HTTPS, scoped per-client credentials, encrypted backups,
and a restore test before storing important data remotely.

An existing private dashboard can host the shared workspace behind its own
authentication boundary. Set the extension's optional Workspace URL to that page.
The API and UI addresses need not be the same, and the extension never places API
credentials in dashboard links.

Keep deployment-specific hosts, tunnels, secrets, backup destinations, and release
automation in your own deployment repository. A public installation must not need
the maintainer's lab infrastructure.

Legacy hosted-control-plane experiments are not part of the supported onboarding
path. This release does not provision paid accounts, cloud infrastructure, or billing.
