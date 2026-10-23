import { createProviderDriftError } from "./drift";

export interface HistoryItem { id: string; key: string; fingerprint: string }
type Reader = (url: string) => Promise<{ json: unknown }>;

export interface HistoryPage {
  items: Map<string, HistoryItem>;
  pending: string[];
  topSessionId?: string;
}

/** Reconcile the bounded metadata index, not an ID watermark: the newest ID
 * can stay unchanged while its conversation (or another conversation) changes.
 * Fingerprints are persisted only after durable delivery by the background worker.
 */
export async function* chatGPTHistoryPages(
  read: Reader, account: string | undefined, known: Record<string, string> = {},
  refresh = new Set<string>(),
  archived = false,
): AsyncGenerator<HistoryPage> {
  // Retain identities, never the entire metadata/transcript index. Offset APIs
  // can overlap when chats are updated during a scan. A later run starts at the
  // head again, using durable fingerprints rather than a brittle saved offset.
  const seen = new Set<string>();
  let topSessionId: string | undefined;
  let stalledPages = 0;
  for (let offset = 0; ; offset += 100) {
    const items = new Map<string, HistoryItem>();
    const url = new URL("https://chatgpt.com/backend-api/conversations");
    url.search = new URLSearchParams({ offset: String(offset), limit: "100", order: "updated", is_archived: String(archived) }).toString();
    const { json } = await read(url.href);
    const rows = (json as { items?: unknown[] } | null)?.items;
    if (!Array.isArray(rows)) throw createProviderDriftError("chatgpt", "ChatGPT history list has no items array.");
    for (const value of rows) {
      const row = value as { id?: unknown; update_time?: unknown; title?: unknown } | null;
      if (!row || typeof row.id !== "string" || !/^[a-zA-Z0-9_-]{1,255}$/.test(row.id)) {
        throw createProviderDriftError("chatgpt", "ChatGPT history contains an invalid conversation identity.");
      }
      topSessionId ??= row.id;
      if (seen.has(row.id)) continue;
      seen.add(row.id);
      const stamp = typeof row.update_time === "number" && Number.isFinite(row.update_time)
        ? String(row.update_time) : typeof row.update_time === "string" && row.update_time.trim() ? row.update_time : "";
      const key = JSON.stringify(["chatgpt", account, "conversation", row.id]);
      // Missing account/timestamp must cause a safe refetch, never a false skip.
      const fingerprint = account && stamp ? JSON.stringify([stamp, row.title ?? null]) : "";
      items.set(row.id, { id: row.id, key, fingerprint });
    }
    // Some offset endpoints ignore the offset after a schema change. Do not
    // spin forever, but tolerate a small overlap caused by concurrent edits.
    stalledPages = items.size ? 0 : stalledPages + 1;
    if (rows.length >= 100 && stalledPages >= 3) {
      throw new Error("ChatGPT history pagination made no progress; sync remains incomplete.");
    }
    yield { items, topSessionId, pending: [...items.values()]
        .filter(item => refresh.has(item.id) || !item.fingerprint || known[item.key] !== item.fingerprint)
        .map(item => item.id) };
    if (rows.length < 100) return;
  }
}

/** Small-fixture compatibility helper; production consumes pages directly. */
export async function discoverChatGPTHistory(
  read: Reader, account: string | undefined, known: Record<string, string> = {}, refresh = new Set<string>(),
): Promise<HistoryPage> {
  const result: HistoryPage = { items: new Map(), pending: [] };
  for await (const page of chatGPTHistoryPages(read, account, known, refresh)) {
    result.topSessionId ??= page.topSessionId;
    for (const [id, item] of page.items) result.items.set(id, item);
    result.pending.push(...page.pending);
  }
  return result;
}
