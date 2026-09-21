/** Offline JSONL parser replay. Never contacts a provider or writes an archive. */
import { createInterface } from "node:readline";
import { providerRegistry } from "../src/providers/registry";
import type { CapturedNetworkEvent, NormalizedSessionSnapshot } from "../src/shared/types";

for await (const line of createInterface({ input: process.stdin })) {
  const row = JSON.parse(line) as { id: string; captures: CapturedNetworkEvent[] };
  const snapshots: NormalizedSessionSnapshot[] = [];
  let errors = 0;
  for (const event of row.captures) {
    try {
      const snapshot = providerRegistry.find((parser) => parser.matches(event))?.parse(event);
      if (snapshot) snapshots.push(snapshot);
    } catch { errors += 1; }
  }
  const latest = snapshots.sort((a, b) => a.capturedAt.localeCompare(b.capturedAt)).at(-1);
  process.stdout.write(JSON.stringify({ id: row.id, snapshot: latest ?? null, errors }) + "\n");
}
