import { createProviderDriftError } from "./drift";

interface HistoryItem { id: string; key: string; fingerprint: string }
type Reader = (url: string) => Promise<{ json: unknown }>;

/** Reconcile the bounded metadata index, not an ID watermark: the newest ID
 * can stay unchanged while its conversation (or another conversation) changes.
 * Fingerprints are persisted only after durable delivery by the background worker.
 */
export async function discoverChatGPTHistory(
  read: Reader, account: string | undefined, known: Record<string, string> = {},
  refresh = new Set<string>(),
): Promise<{ items: Map<string, HistoryItem>; pending: string[]; topSessionId?: string }> {
  const items = new Map<string, HistoryItem>();
  let topSessionId: string | undefined;
  for (let offset = 0; offset < 5_000; offset += 100) {
    const url = new URL("https://chatgpt.com/backend-api/conversations");
    url.search = new URLSearchParams({ offset: String(offset), limit: "100", order: "updated" }).toString();
    const { json } = await read(url.href);
    const rows = (json as { items?: unknown[] } | null)?.items;
    if (!Array.isArray(rows)) throw createProviderDriftError("chatgpt", "ChatGPT history list has no items array.");
    for (const value of rows) {
      const row = value as { id?: unknown; update_time?: unknown; title?: unknown } | null;
      if (!row || typeof row.id !== "string" || !row.id) {
        throw createProviderDriftError("chatgpt", "ChatGPT history contains an invalid conversation identity.");
      }
      topSessionId ??= row.id;
      const stamp = typeof row.update_time === "number" && Number.isFinite(row.update_time)
        ? String(row.update_time) : typeof row.update_time === "string" && row.update_time.trim() ? row.update_time : "";
      const key = JSON.stringify(["chatgpt", account, "conversation", row.id]);
      // Missing account/timestamp must cause a safe refetch, never a false skip.
      const fingerprint = account && stamp ? JSON.stringify([stamp, row.title ?? null]) : "";
      items.set(row.id, { id: row.id, key, fingerprint });
    }
    if (rows.length < 100) {
      return { items, topSessionId, pending: [...items.values()]
        .filter(item => refresh.has(item.id) || !item.fingerprint || known[item.key] !== item.fingerprint)
        .map(item => item.id) };
    }
  }
  throw new Error("ChatGPT ordinary history reached the page limit; sync remains incomplete.");
}
