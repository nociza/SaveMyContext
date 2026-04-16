---
title: Security and Access
---

# Security and Access

SaveMyContext uses app tokens for extension and automation access. The extension never needs your admin password for normal operation.

## Auth modes

SaveMyContext has two practical auth states.

### `bootstrap_local`

This is the first-run state.

- there are no active app tokens yet
- trusted loopback requests can access protected routes without a token
- this is meant for local onboarding only

### `app_token`

This starts as soon as at least one active app token exists.

- every protected API request needs a bearer token
- this includes `127.0.0.1` and `localhost`
- remote access always requires a token

That behavior is intentional. Local token-free access exists only long enough to get the first system set up.

## Remote access rules

Remote SaveMyContext backends must use `https://`.

The extension refuses remote `http://` backends during validation.

## Token scopes

SaveMyContext uses scope-limited tokens:

- `ingest`: sync conversations and save source captures
- `read`: open dashboard data, sessions, graph data, and search results
- `admin`: manage higher-risk operations such as storage changes and token administration

The standard extension token should include:

```text
ingest + read
```

If you want to change the storage path from the extension, the token also needs `admin`.

## Creating a token

Create the initial admin user:

```bash
savemycontext init-admin --username admin
```

Create an extension token:

```bash
savemycontext token create --name chrome-extension --scope ingest --scope read
```

List active tokens:

```bash
savemycontext token list
```

Revoke a token:

```bash
savemycontext token revoke TOKEN_ID
```

## What the extension validates

Before the extension saves a backend configuration, it checks:

- product identity
- minimum supported extension version
- backend auth mode
- remote `https://` requirements
- token validity
- required scopes

This keeps misconfigured URLs and weak tokens from silently failing later during sync.

## Practical recommendations

- Use a dedicated app token for the extension.
- Do not reuse the admin account password in the extension.
- Keep remote backends behind TLS.
- Revoke old tokens when you stop using a browser profile or machine.

## Read next

- [Getting Started](getting-started.md)
- [Troubleshooting](troubleshooting.md)
