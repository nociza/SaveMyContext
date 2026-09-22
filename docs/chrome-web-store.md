---
title: Chrome Web Store release
---

# Chrome Web Store releases

This is a submission kit, **not a claim of Google approval or publication**.
Account registration, identity/trader declarations, agreements and payment belong
to the publisher. Do not put private backend credentials into this repository.

## Prepared update — 0.4.3

Version 0.4.3 refreshes the popup and Settings with a shared light/dark design,
section navigation, a persistent save bar, clearer action availability and safer
busy/error/draft states. No additional browser permissions, remote code, capture
defaults, backend migrations or consent changes are introduced.

This update is packaged locally, **not submitted or published**. The existing
0.4.2 review below must not be cancelled as part of this UI update. Same-ID unpacked
installations can reload the rebuilt `extension/dist` without clearing their
settings or queued evidence. Switching to a new extension ID is not a reload;
see the install/upgrade caveats below.

Local verification: TypeScript and 145 unit tests pass; 19 browser integration
tests pass (the four standalone-workspace tests require their own disposable
server and run separately in CI). Light/dark popup and narrow/desktop Settings
screenshots were inspected. The ZIP passes its integrity check and two packaging
runs produce the same hash.

- Prepared ZIP: `savemycontext-0.4.3.zip`, 134,190 bytes.
- SHA-256: `1ed5ca1701d5eb3229747efe89fe0c386fef77b9d92a53028aad88a50a02d898`.

## Current submission record

As of September 22, 2026, Google's publisher dashboard confirms **Pending review**
for version 0.4.2. This is submitted, **not yet approved or published**. Distribution
was verified as **Unlisted** and **Free of charge**. The 482-character reviewer
instructions below were verified as persisted after reopening their page.

The listing includes the description, category (Productivity → Tools), English
language, icon, two screenshots and small promotional tile. The submitted privacy
form declares no remote executable code and six directly evidenced categories:
identifiers, authentication, communications, web history, activity and website
content. The three publisher-approved Limited Use certifications are checked.
Health, financial and location categories are not separately selected; the
privacy policy and reviewer notes explain that these can occur incidentally in
saved chat/page text, without dedicated collection features.

- Chrome item ID: `nmenckaggbchlanbhgbnlgodepgkeoaj`.
- Package source: `623cd834b8990a0449f4b5c119f77a17030a6539`.
- ZIP: `savemycontext-0.4.2.zip`, 127,403 bytes.
- SHA-256: `1f983a971fa7bc10329eedf82829ee109d22b6980abec1553f2afe606b71a562`.
- [Release CI](https://github.com/nociza/SaveMyContext/actions/runs/35696490004):
  all jobs passed, including browser end-to-end and shared-workspace tests.

Keep this existing item; do not upload a duplicate or cancel its review merely
to recheck status. Wait for Google's review result before claiming availability.
Any additional account agreement or identity declaration requires the publisher's
review.

## Listing fields

- Name: **SaveMyContext**
- Summary (manifest): Capture AI conversations into your private workspace. Durable delivery, explicit history import, and ChatGPT Projects support.
- Category: Productivity (choose the closest available category in the dashboard).
- Language: English.
- Visibility: **Unlisted**. This still requires policy review.
- Homepage: `https://github.com/nociza/SaveMyContext`
- Support: `https://github.com/nociza/SaveMyContext/issues`
- Privacy: `https://github.com/nociza/SaveMyContext/blob/main/docs/privacy.md`
- License: Apache-2.0.
- Minimum browser: Chrome 116 (uses AbortSignal.any for cancellable history reads).

### Detailed description

SaveMyContext saves AI conversations into a searchable workspace you control.

**A self-hosted SaveMyContext backend is required.** This extension does not
include a hosted account or access to the developer's private server. Setup
instructions are available on the project homepage. The backend works locally
without an AI API key; remote backends require HTTPS and an application token.

• Capture supported conversations from ChatGPT, Gemini and Grok after opting in.
• Preserve ChatGPT Project context when available.
• Explicitly import older conversation history using your signed-in provider tab.
• Retain undelivered conversations in an encrypted local queue and retry delivery.
• Pause capture, choose provider/account filters, and discard unsent captures.
• Open the bundled workspace or your own compatible dashboard.
• Optionally save a web page or selected text and search your workspace.

Capture is off until you review the destination and agree. History import and
optional page features are off by default. Content goes to the backend you
configure, not a central SaveMyContext analytics service. Your backend operator
controls retention and any optional external AI processing. Read the privacy
policy before enabling capture. Device encryption is recommended; local queue
encryption does not protect a compromised browser or backend.

This is an early beta. Provider website changes may interrupt capture. Review
the popup's delivery status and keep independent copies of important work.
SaveMyContext is independent of Google, OpenAI and xAI. Screenshots use an
illustrative empty local setup, not real accounts or private conversations.

### Single purpose

Capture and retrieve the user's chosen AI conversations and web context in their
own SaveMyContext workspace.

## Permission justifications

| Permission | Existing feature |
| --- | --- |
| `storage` | Local consent/settings, local application token, delivery receipts and optional synced preferences. Conversation backlog uses extension-origin IndexedDB. |
| `scripting` | Register opt-in page surfaces and open user-invoked capture/search interfaces. No downloaded executable code. |
| `activeTab` | Inspect/capture/search the active page following a user gesture without blanket access. |
| `alarms` | Retry durable delivery and, only if enabled, schedule provider history refresh. |
| ChatGPT / legacy ChatGPT / Gemini / Grok hosts | Read supported conversation traffic and explicitly requested history in signed-in tabs, and provide search/capture controls there. |
| `http://127.0.0.1/*`, `http://localhost/*` | Connect to the user's local self-hosted backend. Remote plaintext backend connections are rejected. |
| Optional `https://*/*`, `http://*/*` | Request the exact origin when the user connects an arbitrary backend. Broad page access is granted only if the user enables all-page capture/search surfaces. These are optional, not install-time all-site access. |

`tabs` and `clipboardWrite` were removed because the retained features do not
require those broader permissions. No remote extension code is used: all JS/CSS
is in the ZIP; backend responses are data. An external workspace is a separately
opened website, not injected executable extension code.

## Privacy dashboard disclosures

Do not select “does not collect user data”: Google includes local handling and
user-configured transfers. Disclose **personally identifiable information**
(account identifiers/labels), **authentication information** (backend token and
provider-session authentication used for explicit history), **personal
communications**, **website content**, and **web history** (source/page URLs, not
general browsing-history tracking). Where applicable, disclose **user activity**
for context used by opt-in page suggestions. Conversations and deliberately saved
pages can include health, financial, location or other sensitive information;
review the exact dashboard definitions and disclose those content categories
conservatively rather than asserting they are impossible to receive.

No sale, advertising, unrelated profiling, creditworthiness/lending use, or
maintainer-operated tracking. Third-party AI is a backend operator opt-in, not a
prerequisite. Certifications must match the policy and the actual deployed setup.

## Reproducible release

```sh
cd extension
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm package:store
pnpm exec playwright test
pnpm store:assets
python3 -m zipfile -t release/savemycontext-0.4.3.zip
```

For the prepared update, use **only** `extension/release/savemycontext-0.4.3.zip`, not a repository archive.
The package has a root manifest, sorted entries, fixed timestamps, license/notices
and a SHA-256 sidecar. Repeating packaging on the same build must give the same hash.
The CI checks this. The packaging allowlist rejects source maps, tools, secrets
and unexpected build files. Record the commit and archive hash with the submission.

Graphics generated from an isolated Chromium profile:

- Icon: `extension/public/icons/icon-128.png`.
- Screenshots: `extension/release/store-assets/01-capture-companion.png` and
  `02-privacy-controls.png` (1280×800).
- Small promotional image: `small-promo-440x280.png`.

Inspect the rendered images before submitting. No real account or private data
should appear. These generated assets are kept out of source control; their
reproducible generator is checked in.

## Reviewer instructions

The dashboard's Additional instructions field permits only 500 characters. Use
this short note (482 characters), which links to the full procedure below:

> Self-hosted; no maintainer credentials or AI key needed. Full setup/tests: https://github.com/nociza/SaveMyContext/blob/main/docs/chrome-web-store.md#reviewer-instructions . Fresh backend/: uv sync --frozen; uv run uvicorn app.main:app --host 127.0.0.1 --port 18888. Configure extension to this local URL; enable capture in popup. Use own test provider account. Chats/pages may contain health, financial or location text; no dedicated collection of these. Details in privacy policy.

This extension requires a user-operated backend, not a paid account. No project
account or maintainer credentials are necessary for local testing:

1. Install Python 3.12+ and uv. Clone the public repository at the release commit.
2. In `backend/`, run `uv sync --frozen`, then
   `uv run uvicorn app.main:app --host 127.0.0.1 --port 18888`.
   Use a fresh checkout/data directory so loopback-only first-run bootstrap is
   available. Do not expose the service to the internet. No API key is required.
3. Open `http://127.0.0.1:18888/workspace`. In extension Settings, save that backend
   URL (leave the token blank only in this fresh local bootstrap setup).
4. Open the extension popup, read the disclosure, and choose **Agree and enable
   capture**. Before this action, capture/import/delivery are disabled.
5. In a provider tab signed into your own test account, open a disposable ChatGPT,
   Gemini or Grok conversation. Send a harmless message; check the popup and
   workspace for delivery. On an already-open tab, reload after enabling capture.
   Provider login is managed by the provider; never provide its password to SMC.
6. From that tab choose **Import history**, read the confirmation, and confirm only
   for a test account. ChatGPT Projects are handled when the account has a project.
7. Pause; new conversations should not be saved. Stop the local backend, resume,
   and capture a disposable conversation: it should queue and later deliver after
   the backend returns. Discard queued captures requires confirmation.
8. Without a provider account, basic UI, connection, explicit page capture and
   workspace search can still be tested; the repository's isolated Playwright
   fixtures additionally exercise all supported providers and Projects.

If the review team needs an accessible hosted demonstration instead of local
setup, create a **separate disposable, access-controlled test backend** and provide
limited credentials privately through the store dashboard. Never use personal
infrastructure, real evidence, or a production/admin token. Such a hosted demo is
not included or automatically deployed by this release.

## Install/upgrade caveats

The store extension normally has a different ID from an unpacked installation.
Settings, queue and consent do not migrate between IDs automatically. Drain or
deliberately export/retain the old installation before removing it; configure and
consent in the new one. Never run both capturing the same account unintentionally.
This release encrypts an existing same-ID queue lazily on access without dropping
records, and requires renewed local consent even on same-ID upgrades.

## Submission checklist

- [ ] Publisher signed in; registration/2-step verification/trader declaration complete.
- [x] Tests pass; ZIP/hash and images inspected; public privacy URL accessible.
- [x] Review privacy fields against the current dashboard definitions.
- [x] Enter listing, permission justifications and reviewer instructions.
- [x] Select Unlisted, submit for review, record the item ID and status.
- [ ] Do not call it published until the dashboard confirms publication.
