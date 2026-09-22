---
title: Privacy Policy
---

# SaveMyContext privacy policy

Effective September 21, 2026. Applies to the SaveMyContext browser extension 0.4.2
and the self-hosted software maintained at [nociza/SaveMyContext](https://github.com/nociza/SaveMyContext).

## What this product does

SaveMyContext captures selected AI conversations and explicitly saved web content
into a workspace backend you choose. It is a self-hosted client, not a hosted
storage subscription. Installing the extension does not give you access to the
maintainer's private infrastructure. The project does not operate a central
conversation-collection or analytics service.

## Information handled

After you enable capture, the extension reads supported conversation responses on
ChatGPT, Gemini, and Grok. Captures can contain message text (including code and
anything sensitive you put in a chat), conversation titles, timestamps, URLs,
message/conversation identifiers, account identifiers or labels (sometimes an
email address), and ChatGPT Project identifiers, titles, instructions and file
references when supplied by the provider. Captures may include structured request
and response bodies needed to reconstruct conversation history. This is not a
general browser-history collector. It does not intentionally collect payment
details, passwords, or health information as separate features; such information
can nevertheless be present in conversations or pages you choose to save.

Explicit history import reads older conversations using your existing signed-in
provider session. The provider's session tokens may be used within its own page
to request your conversations; SaveMyContext does not require your provider
password or export provider authentication cookies to the workspace. The separate
SaveMyContext application token you supply authenticates requests to your backend.

Optional page/selection capture saves selected text or readable page content,
the page title and URL. Optional contextual suggestions use current-page context
to search your backend. They are disabled by default. Ordinary websites require
an explicit action or optional host-access grant. Quick search sends your query
to your backend and can insert a selected result into the active page when asked.

## Consent and controls

Capture starts disabled. The popup describes collection and shows the destination
before you choose **Agree and enable capture**. Consent is stored locally in that
browser profile and bound to the backend address. Changing the backend requires
consent again. Provider and account filters are available in Settings; the default
after consent includes all signed-in accounts on the enabled supported providers.
Automatic history import and scheduled history refresh are off by default.

Pause stops new capture and subsequent delivery. Requests already in flight may
finish; pausing is not a deletion or recall of data already delivered. History
readers stop outstanding requests when the pause reaches the provider tab.

## Storage, transfer, and recipients

- Conversation backlog lives in extension-origin IndexedDB, encrypted with
  AES-256-GCM. Its non-exportable Web Crypto key is kept in the same browser
  profile. This is local storage protection, **not** end-to-end encryption or
  protection against someone controlling your browser/device. Enable OS disk
  encryption and protect your browser profile. Older plaintext queue records are
  migrated without discarding them; this does not securely erase old disk blocks.
- Application tokens, consent, sync receipts/watermarks and diagnostics are stored
  locally. Tokens are not placed in Chrome Sync or workspace URLs. Some metadata
  (such as conversation identifiers and error messages) is not application-encrypted.
- Preferences, including backend/workspace URLs, provider/account filters and
  indexing rules, use Chrome storage sync when enabled in your browser. Your
  browser vendor's sync service may therefore receive those preferences. Do not
  put secrets into URLs or filter text. Chat bodies and backend tokens are not synced.
- Captures and searches are sent to the backend you configure. Remote connections
  require HTTPS; loopback connections on the same computer may use HTTP. A different
  destination never receives the previous destination's queued captures automatically.
- The self-hosted backend stores conversations, derived records and history in its
  database and, if enabled, local exports/search projections or archives. The backend
  administrator controls access, storage encryption, retention, logs, and backups.
  A normal SQLite database is not encrypted by this application. Use encrypted
  storage for databases, exports and logs, and encrypted backups, before storing
  sensitive material. Anyone who operates your backend may have access to its data.
- Optional external interpretation/generation is disabled by default in the
  backend. If its operator enables it, selected excerpts/prompts may be sent to
  configured AI services (for example OpenRouter and its chosen model provider).
  Check your backend operator's configuration and those services' policies before
  enabling capture. The extension does not promise that a third-party backend
  retains the default configuration.

The project does not sell captured data, use it for advertising, or send it to the
maintainer for model training. No remote executable extension code is downloaded.
If you open project documentation, GitHub support, or a separately configured
workspace website, that site handles ordinary web requests under its own policies.

## Retention and deletion

Successfully acknowledged conversation captures are removed from the local queue.
Undelivered captures remain until acknowledged or explicitly discarded. The queue
is capped at 1,000 entries / 128 MiB of estimated plaintext size; it stops accepting
new entries rather than silently evicting older evidence. It does not expire data
automatically. Popup → **Diagnostics & local data → Discard queued captures** pauses
capture and removes all unsent entries after confirmation. This is irreversible.

Uninstalling the extension removes its browser-local storage; it does not delete
data already sent to a backend or copies of synced preferences on other devices.
Backend data, generated files, search projections and backups have separately
configured retention. Contact your backend operator for complete deletion across
those stores. Archiving or dismissing a workspace item is not secure erasure of
its source evidence. The project maintainer cannot delete a self-hosted database
they do not control. Revoke backend tokens when retiring an installation.

## Limited Use and support

SaveMyContext's use of information received through the extension adheres to the
Chrome Web Store User Data Policy, including its Limited Use requirements. Data
is used to provide the user-facing capture, search and workspace features, not
advertising or unrelated profiling. The project does not permit unrelated human
review of captured content. Do not post private chats, tokens, or database files
in public support requests.

For privacy questions, [open a support issue without personal content](https://github.com/nociza/SaveMyContext/issues).
For concerns about a particular backend, contact its operator. Material changes
to collection or use will be documented here and disclosed in the product before
new consent is sought where needed.
