---
title: Service Options
description: Choose between a hosted SaveMyContext backend and a self-hosted backend.
---

# Service Options

SaveMyContext is designed around one extension API and two deployment paths: a hosted backend for users who want a managed service, and a self-hosted backend for users who want to run the service themselves.

## Hosted Backend

The hosted path is for users who want SaveMyContext to provide and operate the backend.

This path should handle:

- account creation and sign-in
- paid plan management
- hosted database and storage
- production monitoring and backups
- connection strings or tokens that the extension can use directly
- operational limits that protect the service from abuse

The extension should not need a separate hosted implementation. It should connect to the hosted backend through the same public SaveMyContext API contract that self-hosted users use.

## Self-Hosted Backend

The self-hosted path is available today through the `savemycontext` package.

```bash
uv tool install savemycontext
smc install
```

For a backend that other devices can reach:

```bash
smc install --remote
```

Remote mode prints a connection string that starts with `smc_conn_1_`. Paste that string into the extension settings to enroll the browser profile.

## Shared Product Contract

The hosted service and the self-hosted package should share the same core implementation wherever possible:

- ingestion routes
- token scopes
- connection bundle redemption
- pile classification
- processing pipeline behavior
- search, graph, dashboard, and vault output contracts
- extension compatibility checks

Hosted-only code should stay focused on account management, billing, deployment, tenancy, observability, and infrastructure. Product behavior should live in the open backend first so the hosted service and self-hosted users do not drift.

## What To Read Next

- [Getting Started](getting-started.md)
- [Remote Access](remote-access.md)
- [Security and Access](security-and-access.md)
- [Vault and Storage](vault-and-storage.md)
