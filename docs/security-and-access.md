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
smc init-admin --username admin
```

Create an extension token:

```bash
smc token create --name chrome-extension --scope ingest --scope read
```

List active tokens:

```bash
smc token list
```

Revoke a token:

```bash
smc token revoke TOKEN_ID
```

## Connection bundles

For CLI-managed remote access, SaveMyContext can mint enrollment bundles instead of asking you to copy raw app tokens around.

Available security levels:

- `shared`: one reusable string that can enroll multiple devices
- `per_device`: one single-use string per device
- `per_device_code`: one single-use string plus a separate verification code

Examples:

```bash
smc share
smc invite --device laptop
smc invite --security per_device_code --device work-laptop
```

Which one to choose:

- `shared`: easiest when all the devices are yours and you just want one reusable string
- `per_device`: better when you want each device to have its own one-time enrollment
- `per_device_code`: best when you want a one-time string plus an extra approval step

By default, the CLI uses a managed local owner account for issued device tokens. Pass `--username` if you want bundles tied to a specific existing user instead.

Each successful enrollment still becomes a normal scoped app token on the backend. Revoking the grant stops new enrollments; revoking the issued token cuts off that enrolled device.

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
- [Remote Access](remote-access.md)
- [Troubleshooting](troubleshooting.md)
