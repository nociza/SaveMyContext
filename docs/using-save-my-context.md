---
title: Using SaveMyContext
---

# Using SaveMyContext

The extension is a capture companion, not a second knowledge-management application.

## Popup

The compact popup follows your system's light/dark appearance. The capture card
explains the current state and any setup needed; disabled actions include a reason
below them. Only one action can run at a time, including during background status
updates. Errors stay visible so you can retry; cancelling an import or queue
discard does not change your data.

- **Connection / last saved:** backend connection state and most recent acknowledged capture.
- **Waiting to send:** the durable local capture queue count, read without loading conversation bodies.
- **Save page:** save source material from the active web page. It is not a substitute for structured chat capture.
- **Import history:** explicitly import from the active ChatGPT, Gemini, or Grok account.
- **Pause capture / Resume capture:** stop new saves and delivery while retaining queued evidence.
- **Open workspace:** search and manage your memory, inbox, tasks, and projects.
- **Diagnostics:** last conversation, errors, and provider drift warnings.

Pause takes effect between queued deliveries; an in-flight request may finish.
New activity while paused is not saved. Resume does not promise to reconstruct
missed activity automatically; use history import where supported.

## History and Projects

History import honors provider, account, and indexing filters. ChatGPT Projects
include project-only conversations and project membership. Successful acknowledgements,
fingerprints, and retryable watermarks prevent silent skips and unnecessary re-imports.
A failed or quarantined capture is not a successful history checkpoint.

Large imports are incremental: ordinary/archived ChatGPT, Gemini, and Grok lists
are consumed page by page. ChatGPT's independent Projects index includes chats
missing from the sidebar. There is no 5,000-chat or 10,000-project-chat ceiling.
Progress totals grow as more pages are discovered; they are not a known account total.

An explicitly started import remains pending until it completes. Every 15 minutes,
unfinished work can retry in an **already-open** provider tab, even when automatic
history import is off. This continuation never opens/reloads tabs, turns on capture,
or bypasses Pause/provider/account filters. Browser restart restores the retry job;
the provider must still be signed in. A full/offline queue drains before new downloads.
Completed conversation fingerprints survive interruptions, including multi-week gaps.
Explicit imports audit the whole index; saving a recent live message does not count
as importing that conversation's older turns. Older extension receipts may be reread once.
Provider rate-limit deadlines delay retries, including explicit retry clicks.

### Returning to, renaming, or archiving an old chat

Version 0.4.7 reconciles metadata across the whole paginated index for ChatGPT,
Gemini, and Grok, even when the newest conversation ID is unchanged. A changed
entry downloads only that conversation; unchanged entries reuse durable receipts.
New turns and edits update the existing conversation. A title-only rename updates
its title without duplicating messages or creating another AI-processing job.
Live captures also preserve renames when they contain a title and transcript.
Rename/archive actions that do not expose a transcript are reconciled on the next
history run, not necessarily immediately when clicked.

ChatGPT scans active and archived lists and detects both archive and unarchive
transitions, including unchanged timestamps. Archiving at the provider does **not**
delete saved history, archive the SMC source, or alter your tasks/publishing drafts.
Missing list entries are never treated as deletion commands. Gemini/Grok changes
can only be detected for entries their list endpoints expose; separate archived
history traversal is currently implemented only for ChatGPT.

Some provider metadata does not reliably describe transcript edits. Full-history
receipts expire after seven days and are rechecked on the next eligible run; live
captures do not extend that deadline. This is not a guarantee of immediate remote
edit detection. The expiry clock is fixed at the start of an import so interruptions
neither restart the already-accepted prefix nor revive stale receipts. Upgrading
an older ID-only cache may require a one-time reimport.

Version 0.4.8 also isolates receipts by backend URL and rejects messages from
superseded imports. Receipts from older versions without a provable destination
are rechecked once; saved evidence is not deleted. Moving a chat out of a project
triggers a detail recheck even without a timestamp change. Provider pagination
that stalls or contradicts its advertised total stays visibly incomplete.

Deleted/temporary chats, unavailable accounts, attachment binaries, and provider data
not exposed by the authenticated endpoints cannot be recovered by pagination. Claude
does not yet have an automatic full-history adapter. Individual captures are limited
to 8 MiB of provider evidence (also cumulative across Gemini message pages); oversized
or malformed conversations remain visibly incomplete, never silently truncated.
Saving history is separate from AI processing: configured budgets/consent still apply,
and a source above the summarizer budget is marked `needs_budget`, not fully summarized.

Capture is opportunistic, not a guarantee of continuous monitoring while the browser
is closed. Scheduled refresh is optional and can open provider tabs. If the provider's
response format changes, check the visible error instead of repeatedly importing.

## Settings

Use the section navigation to jump between Connection, Providers & accounts, Page
tools, Automation, Capture rules, and Activity. On narrow screens the navigation
scrolls horizontally. The save bar stays available as you scroll; edits are
explicitly saved, never auto-applied. Background sync updates do not replace
unsaved edits, and leaving with a draft prompts before discarding it.

Legacy discard routing is collapsed by default. It is a compatibility option,
not a privacy filter. The Activity section only highlights errors when one exists.
Account lists appear when account filtering is enabled. For a connection bundle,
expand **Use a connection string instead**; its credential-bearing value is masked.

Connection and optional workspace destination are separate. An external workspace
handles its own authentication and receives no API token through its URL. The
bundled fallback uses the same web component as the backend's standalone workspace.

Advanced preferences include automatic history import, scheduled refresh,
provider/account filters, word filters, selection capture, and context search.
Broad page access is optional and explicitly requested; it is not granted on installation.

Provider web capture supports ChatGPT, Gemini, and Grok. Codex/Claude Code context
handoffs use the [CLI and agent integration](codex-and-context-migration.md).

## The workspace

Review suggestions in Inbox, search source-backed context in Memory, manage explicit
commitments in Tasks, and group work in Projects. Task edits go through the shared
API and version checks. Captured text is evidence, not authority to execute instructions.

Graph/pile visualizations, duplicate task controls, prompt editing, and browser-LLM
execution have been retired from the extension. Backend compatibility routes have
not been deleted by this extension release.
