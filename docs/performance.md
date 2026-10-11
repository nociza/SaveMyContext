---
title: Extension reliability and performance
---

# Extension reliability and performance

Version 0.4.4 repairs capture and history synchronization before optimizing browser
work. The October 10, 2026 experiments reduced large-backlog queue work substantially
without removing durable acknowledgements, destination isolation, queue limits, or
browser-local encryption. These are reproducible synthetic measurements, not a claim
that every browser workload has reached its theoretical minimum.

## Functional guarantees

- ChatGPT history reconciles update fingerprints across the bounded metadata list.
  An edited conversation is not skipped merely because its ID remains newest.
  Project and ordinary-history fingerprints are acknowledged together when a chat
  appears in both lists. Missing timestamps/account scope cause a safe refetch.
- Fingerprints become reusable only after backend acknowledgement. A weekly safety
  refresh rechecks older acknowledgements; automatic visits respect the configured
  refresh interval. Explicit imports bypass that interval.
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
```

Do not run other benchmark or test suites concurrently with timing measurements.
Repeat fresh contexts and alternate variants to check for cache or scheduling bias.

The final functional gate passed TypeScript checks, 155 extension unit tests, 292
backend tests, and all 29 browser/workspace integration tests. Workspace tests must
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
