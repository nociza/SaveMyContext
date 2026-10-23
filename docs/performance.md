---
title: Extension reliability and performance
---

# Extension reliability and performance

Version 0.4.4 repairs capture and history synchronization before optimizing browser
work. Version 0.4.5 also reduces retained capture memory and releases closed search
results. The October 10, 2026 experiments reduced large-backlog queue work substantially
without removing durable acknowledgements, destination isolation, queue limits, or
browser-local encryption. These are reproducible synthetic measurements, not a claim
that every browser workload has reached its theoretical minimum.

## Functional guarantees

- ChatGPT history reconciles update fingerprints across paginated metadata lists.
  An edited conversation is not skipped merely because its ID remains newest.
  Project and ordinary-history fingerprints are acknowledged together when a chat
  appears in both lists. Missing timestamps/account scope cause a safe refetch.
- Fingerprints become reusable only after backend acknowledgement. A weekly safety
  refresh rechecks older acknowledgements; automatic visits respect the configured
  refresh interval. Explicit imports bypass that interval.
  An unfinished catch-up anchors expiry to its original start time so weekly expiry
  cannot starve its tail or revive previously expired receipts during a retry.
- History download workers await local persistence before downloading more captures.
  A failed or timed-out handoff keeps the history run retryable.
- Scheduled refresh never reloads an existing provider tab. Loading waits are bounded
  and handle tab closure and completion races.
- Unavailable queue status is not reported as an empty queue. Failed capture streams
  produce a visible warning without interrupting the provider response.
- Queue capacity and duplicate checks commit atomically across writers. Delivery
  removes a capture only after its acknowledgement callback succeeds. Policy-deferred
  captures remain local without blocking eligible captures from other accounts.
- Empty/paused queues have no delivery alarm. Pending delivery uses persisted,
  jittered exponential backoff, capped at an hour, and reconciles lost alarms when
  the service worker starts.
- Sync state is stored per conversation in IndexedDB, with small provider summaries.
  The old browser-storage map is removed only after the complete copy commits.

Automatic provider support remains ChatGPT, Gemini, and Grok. This release does not
add a Claude adapter, enable capture consent, enable external model processing, or
change server/NAS backup configuration.

## Historical conversation reconciliation (0.4.7)

- All three history adapters traverse paginated metadata instead of stopping at
  a previously newest conversation ID. Gemini/Grok persist SHA-256 receipts of
  individual metadata rows, not raw index rows or transcripts in sync summaries.
- ChatGPT fingerprints include archive scope; project-only fingerprints also
  include title and exposed archive state. Renames without timestamp changes and
  archive/unarchive transitions invalidate the relevant receipt.
- Live rename-only captures use incremental upserts. Backend tests assert that
  old messages survive, source identity stays stable, and unchanged content adds
  no AI job/revision. Provider archiving is not a deletion or SMC archive command.
- Weekly verification is based on full-history acknowledgement time, not recent
  live activity. The fixed per-import reconciliation clock survives retries.
- Metadata traffic is now proportional to the complete index on each eligible
  run; transcript traffic remains limited to changed/expired/unacknowledged
  entries. Existing refresh throttles, bounded workers, and backpressure apply.
  Missing or unchanged provider revision metadata can delay remote edit detection
  until the weekly safety recheck; this does not promise real-time synchronization.

## Large-history recovery (0.4.6)

The first-install audit found that 50 full ChatGPT list pages caused an exception
before any conversation bodies were imported. Project discovery also stopped at
100 pages / 10,000 entries. Those total-history ceilings are removed. No-progress
pages and cursor cycles still fail explicitly rather than looping or claiming success.

- Ordinary and archived ChatGPT lists, Gemini lists, and Grok lists feed page-sized
  detail batches. The next page waits for the current page's local capture receipts.
- ChatGPT and Gemini have two detail workers (previously four); Grok retains four.
  All workers stop scheduling on storage-handoff failure or provider-wide transport
  errors, and join active work before returning. Individual malformed chats do not
  block later pages. Progress writes are coalesced to at most twice per second.
- Cursor repetition is an error for both Gemini conversation lists and message pages,
  and for Grok lists; it can no longer produce a falsely complete transcript.
- Gemini no longer retains a per-conversation outcome array or uses a quadratic
  combined-index lookup. Its conversation evidence has a cumulative 8 MiB guard;
  individual provider response reads are also bounded.
- Recovery rescans mutable indexes from the head, skipping backend-acknowledged
  fingerprints. This intentionally favors correctness over persisting an offset
  that can shift after edits/deletions. Delivery is drained before starting a new
  scan. Unfinished jobs restore their alarms after worker/browser restart.
  Explicit imports/recovery bypass old ID watermarks; a recent live capture is
  not considered a full-history receipt. This prevents partial current chats from
  being skipped on first import. Legacy receipts without this marker are safely reread.
- The transcript working set is bounded by page/worker/response limits, **not total
  history size**. Identity deduplication sets, small receipt summaries, and ChatGPT's
  project membership/context index still scale with conversation/project count.
  This is not constant total RAM, nor does it stream a single unlimited-size chat.

Synthetic regression coverage includes 50,017 ordinary chats, exact full-page endings,
10,100 project conversations over 101 pages, changed account scope, mutable offsets,
repeated cursors, and multi-week receipt retention. A real Chromium MessageChannel
fixture interrupts a 5,207-chat first import after 137 accepted captures, reloads,
imports the remaining 5,070, then verifies a zero-detail-download reconciliation.
It also checks a malformed middle chat and an empty active list with 105 archived
chats over two pages, and stops early during an offline fetch rather than attempting
the rest of the backlog. These browser fixtures use simulated storage receipts; the
separate extension/API integration tests cover actual IndexedDB and SQLite delivery.

Archive-list behavior is based on an independent implementation's
[documented active/archived endpoint traversal](https://github.com/skillsynchq/txcript/blob/main/docs/formats/chatgpt.md),
not a public OpenAI compatibility guarantee. Production provider changes still require
live compatibility checks. No personal account history was imported for these tests.

## Experimental method

The queue baseline uses the pre-optimization implementation (the queue code from
`4ab9da3`). Correctness fixes preceded queue optimization. Each scenario runs in a
new Chromium context containing only synthetic records, with network interception.
The machine was an Apple M1 Max running arm64 macOS, Node 24.6.0, and Chromium
147.0.7727.15. Browser versions and machine details are emitted by the harness.

Each queue scenario measures seven counts, then one new enqueue and four duplicate
retries, then delivery of ten records with a synthetic failure at the next record.
Assertions verify counts and preservation of the undelivered records. No network or
model latency is included in delivery measurements. Heap measurements are Chromium
JavaScript heap after the count samples, not total browser RSS or peak allocation.

For the approximately 117 MiB fixture with 999 records:

| Measurement | Baseline | Optimized observations |
| --- | ---: | ---: |
| Median queue count | 258.6 ms | 1.0–1.3 ms |
| First new enqueue | 256.6 ms | 1.6–2.2 ms |
| Median enqueue including duplicate retries | 253.2 ms | 0.5–0.7 ms |
| First ten deliveries | 263.6 ms | 22.4–28.0 ms |
| JavaScript heap after counting | 119.65 MiB | 1.26–1.28 MiB |

The observations are individual runs, not confidence intervals. Timer resolution,
browser startup, disk caches, and OS scheduling affect sub-millisecond comparisons.
The first operation on a brand-new database includes initialization; the first
operation on an old queue also includes migration. Neither should be confused with
steady-state results.

## Optimization experiments

1. Native IndexedDB count eliminated full-queue decryption for status reads. Kept.
2. Atomic small metadata records and totals eliminated full-queue scans for enqueue;
   streaming delivery stopped materializing every plaintext payload. Kept after
   encrypted/legacy migration, concurrent capacity, retry, and missing-key tests.
3. Reusing the IndexedDB connection reduced repeated setup without caching payloads.
   Kept; version changes and forced closure invalidate the connection.
4. Reading at most 16 ciphertext records and 256 KiB per batch amortized database
   IPC. A single oversized record is read alone. Two alternating confirmation pairs
   measured 29.6/31.3 ms for single-record reads versus 28.0/24.7 ms for batching on
   the largest fixture; smaller fixtures also improved. Kept.
5. The paused fetch hook now returns the native promise immediately. On 10,000
   synthetic dispatches, median time fell from 11.5 to 0.5 ms. For enabled capture
   inspecting unrelated requests, it fell from 30.6 to 17.2 ms. These measure hook
   dispatch, not ChatGPT server response time.
6. Disabled suggestion polling was removed. Across 12 synthetic provider tabs over
   11 seconds, callbacks fell from 24 to zero; backend requests were zero in both
   cases. Renderer task time was 36.3 versus 16.9 ms in that sample, but this short
   run is not a battery-life benchmark.

Unbounded payload prefetch, dropping capture evidence, disabling durability, and
removing queue encryption were excluded: they would weaken the functional/privacy
contract rather than optimize the same task. More aggressive tuning should require
repeatable end-to-end gains, not just a faster isolated timer.

The [raw queue measurements](performance/2026-10-10-queue.json) include intermediate
experiments and alternating confirmation runs. They contain no real conversation data.

## Capture memory

Version 0.4.5 carries provider response text without also carrying a parsed copy of
the same JSON through messaging, storage, and upload. Exact response text is retained;
Gemini and Grok history payloads still include their provider evidence. Legacy
JSON-bearing captures remain readable. Complete JSON documents are parsed once,
with line framing reserved for SSE, NDJSON, and batchexecute responses.

The hashing buffer becomes eligible for collection before encryption starts. Closed
quick-search panels release result objects and DOM nodes, cancel pending debounce
work, and invalidate late results. Hidden suggestions also invalidate pending lookups.
Hover and keyboard selection update existing cards instead of reallocating snippets
and replacing their buttons during interaction.

For four simultaneous synthetic responses of approximately 6 MiB each:

| Measurement | Version 0.4.4 | Version 0.4.5 |
| --- | ---: | ---: |
| Retained JS heap after capture | about 49 MiB | about 25 MiB |
| Retained JS heap after parsing | about 73 MiB | about 49 MiB |
| Serialized capture messages | about 48 MiB | about 24 MiB |

Heap checkpoints explicitly collect garbage. They measure live retained data, not
all temporary allocations. Sampled peaks include JS heap and backing storage; they
remain variable, especially during encryption and delivery. Large captures can still
temporarily use hundreds of MiB. These retained-memory reductions are not a promise
of a corresponding reduction in total browser RAM or a hard peak-memory limit.

The optimized stress run performs 20 capture/parse/persist/drain cycles at each of
two sizes (2 and 6 MiB per response): 160 conversations, with message counts and
evidence preservation checked throughout. After warm-up, the post-drain JS heap
plus backing storage settles around 1.5 MiB rather than growing with each cycle.
This is a short churn test, not a multi-day leak certification.

The memory harness uses a temporary disk-backed Chromium profile for IndexedDB.
Off-the-record storage can remain in RAM and distort storage-churn measurements.
Traffic is intercepted; no real chat history or backend is used. Provider hooks,
parser, hashing, encryption, and queue operations run in a combined renderer fixture,
not the installed extension's separate page/content/service-worker processes.
Process RSS is reported separately and can double-count shared pages.

The 12-tab idle comparison adds approximately 0.83 MiB of JS heap/backing storage
per tab for the scripts, essentially unchanged by this release. It excludes the
extension service worker and real provider application overhead. The focus of these
changes is active capture and stale-result retention, not an asserted idle-RAM gain.

[Raw memory measurements](performance/2026-10-10-memory.json) record individual
cycles, per-stage peaks, idle comparisons, and browser-process RSS.

## Reproduction

Run from `extension/` with dependencies and Playwright Chromium installed:

```sh
pnpm typecheck
pnpm test
pnpm build
pnpm check:bundle
node scripts/benchmark-capture.mjs --revision=4ab9da3
node scripts/benchmark-capture.mjs
node scripts/benchmark-capture.mjs --single-read
node scripts/benchmark-browser.mjs --revision=4ab9da3
node scripts/benchmark-browser.mjs
node scripts/benchmark-memory.mjs --revision=fe3812e --rounds=20
node scripts/benchmark-memory.mjs --rounds=20
```

Do not run other benchmark or test suites concurrently with timing measurements.
Repeat fresh contexts and alternate variants to check for cache or scheduling bias.

The 0.4.4 functional gate passed TypeScript checks, 155 extension unit tests, 292
backend tests, and all 29 browser/workspace integration tests. Version 0.4.5 passes
161 extension unit tests and 32 browser/workspace tests, including parser-equivalence,
exact-text bridge, and UI-retention regressions. The 0.4.6 suite expands this to 173
extension unit tests and 36 browser/workspace tests; backend coverage remains 292 tests.
Workspace tests must
use an explicitly supplied disposable server; they create test captures and tasks.
The integration suite includes a remote edit to the same newest ChatGPT conversation,
overlapping project/ordinary history, unchanged-history skipping, offline retention,
queue migration, API persistence, and native fetch-promise behavior.

## Upgrade and recovery

Reload the unpacked extension after updating its files; a browser can otherwise keep
an old service worker while opening newer popup assets. Do not refresh a provider tab
while composing a message or receiving an answer. Its existing content script may
need a later manual page reload. Capture consent remains an explicit user choice.

The capture database upgrades to schema 3. Close old extension pages if the upgrade
reports a blocked connection. Do not clear IndexedDB, reset its encryption key, or
delete browser storage to fix that message. Migration retains existing ciphertext
and keys; missing keys or unreadable records fail visibly without deletion.

Do not downgrade to 0.4.3 after migration: it cannot open the newer queue schema.
Prefer a forward repair. A rollback needs a complete pre-upgrade browser-profile
backup, including its queue and key, plus preservation of any newer unsent captures.

These tests do not certify current provider API compatibility against every live
account, installed-profile recovery, fleet resource utilization, or multi-day battery
behavior. Keep those deployment/soak checks separate from synthetic test results.
