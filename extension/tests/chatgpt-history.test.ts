import { expect, it, vi } from "vitest";
import { assertChatGPTHistoryIdentity, chatGPTHistoryPages, discoverChatGPTHistory } from "../src/injected/chatgpt-history";

it("refetches a changed top conversation and skips unchanged metadata only after acknowledgement", async () => {
  const read = vi.fn().mockResolvedValue({ json: { items: [{ id: "top", update_time: 1, title: "A" }] } });
  const first = await discoverChatGPTHistory(read, "account");
  expect(first.pending).toEqual(["top"]);
  const item = first.items.get("top")!;
  const known = { [item.key]: item.fingerprint };
  expect((await discoverChatGPTHistory(read, "account", known)).pending).toEqual([]);
  expect((await discoverChatGPTHistory(read, "account", known, new Set(["top"]))).pending).toEqual(["top"]);
  read.mockResolvedValue({ json: { items: [{ id: "top", update_time: 2, title: "A" }] } });
  expect((await discoverChatGPTHistory(read, "account", known)).pending).toEqual(["top"]);
  expect((await discoverChatGPTHistory(read, "other-account", known)).pending).toEqual(["top"]);
});

it("reconciles later pages and refuses malformed or unbounded history", async () => {
  const rows = Array.from({ length: 100 }, (_, n) => ({ id: String(n), update_time: 1 }));
  const read = vi.fn().mockResolvedValueOnce({ json: { items: rows } }).mockResolvedValue({ json: { items: [{ id: "older", update_time: 2 }] } });
  expect((await discoverChatGPTHistory(read, "account")).pending).toHaveLength(101);
  expect(read.mock.calls[1][0]).toContain("offset=100");
  await expect(discoverChatGPTHistory(async () => ({ json: {} }), "a")).rejects.toThrow("items array");
  await expect(discoverChatGPTHistory(async () => ({ json: { items: [null] } }), "a")).rejects.toThrow("identity");
  await expect(discoverChatGPTHistory(async () => ({ json: { items: rows } }), "a")).rejects.toThrow("no progress");
});

it.each([0, 100, 5_000, 50_017])("streams %i conversations without a history-size ceiling or eager prefetch", async total => {
  let fetchedPages = 0;
  let consumed = 0;
  const read = async (url: string) => {
    const offset = Number(new URL(url).searchParams.get("offset"));
    expect(offset).toBe(consumed);
    fetchedPages++;
    return { json: { items: Array.from({ length: Math.max(0, Math.min(100, total - offset)) }, (_, n) => ({ id: `c${offset + n}`, update_time: 1 })) } };
  };
  for await (const page of chatGPTHistoryPages(read, "account")) {
    expect(page.items.size).toBeLessThanOrEqual(100);
    expect(page.pending).toHaveLength(page.items.size);
    consumed += page.items.size;
  }
  expect(consumed).toBe(total);
  expect(fetchedPages).toBe(Math.floor(total / 100) + 1);
});

it("replays acknowledged prefixes after interruption, including across changed offsets", async () => {
  const rows = Array.from({ length: 250 }, (_, n) => ({ id: `c${n}`, update_time: 1 }));
  const known: Record<string, string> = {};
  const read = async (url: string) => { const offset = Number(new URL(url).searchParams.get("offset")); return { json: { items: rows.slice(offset, offset + 100) } }; };
  for await (const page of chatGPTHistoryPages(read, "account")) {
    for (const item of page.items.values()) known[item.key] = item.fingerprint;
    break; // Worker/tab went away after the first page was acknowledged.
  }
  rows.unshift({ id: "new-top", update_time: 2 });
  const resumed = await discoverChatGPTHistory(read, "account", known);
  expect(resumed.pending).toHaveLength(151);
  expect(resumed.pending[0]).toBe("new-top");
  expect(resumed.pending.at(-1)).toBe("c249");
  expect((await discoverChatGPTHistory(read, "other-account", known)).pending).toHaveLength(251);
});

it("does not trust missing timestamps or unknown account scope", async () => {
  const read = async () => ({ json: { items: [{ id: "top" }] } });
  const first = await discoverChatGPTHistory(read, undefined);
  const item = first.items.get("top")!;
  expect((await discoverChatGPTHistory(read, undefined, { [item.key]: item.fingerprint })).pending).toEqual(["top"]);
});

it("follows server-capped short pages until the advertised total is reached", async () => {
  const offsets: number[] = [];
  const result = await discoverChatGPTHistory(async url => {
    const offset = Number(new URL(url).searchParams.get("offset"));
    offsets.push(offset);
    return { json: { total: 125, items: Array.from({ length: Math.min(25, 125 - offset) }, (_, n) => ({ id: `c${offset + n}`, update_time: 1 })) } };
  }, "account");
  expect(result.pending).toHaveLength(125);
  expect(offsets).toEqual([0, 25, 50, 75, 100]);
});

it("does not declare completion on an empty page before the advertised end", async () => {
  await expect(discoverChatGPTHistory(async () => ({ json: { total: 10, items: [] } }), "account")).rejects.toThrow(/incomplete|progress/);
});

it("rejects wrong-conversation details rather than checkpointing the requested ID", () => {
  expect(() => assertChatGPTHistoryIdentity({ conversation_id: "other" }, "requested")).toThrow(/identity/);
  expect(() => assertChatGPTHistoryIdentity({ conversation_id: "requested", conversationId: "other" }, "requested")).toThrow(/identity/);
  expect(() => assertChatGPTHistoryIdentity({ conversation_id: "requested" }, "requested")).not.toThrow();
  expect(() => assertChatGPTHistoryIdentity({ mapping: {} }, "requested")).not.toThrow(); // URL still supplies identity.
});

it.each([-1, 1.5, "125", NaN])("refuses an untrustworthy history total %s", async total => {
  await expect(discoverChatGPTHistory(async () => ({ json: { items: [], total } }), "account")).rejects.toThrow(/total/);
});

it("finds old-chat edits, title-only renames and archive/unarchive with an unchanged newest ID", async () => {
  const rows = Array.from({ length: 201 }, (_, n) => ({ id: `c${n}`, update_time: 1, title: `Chat ${n}` }));
  let archived = false;
  const known: Record<string, string> = {};
  const read = async (url: string) => {
    const u = new URL(url), offset = Number(u.searchParams.get("offset"));
    const source = u.searchParams.get("is_archived") === "true" ? (archived ? [rows[200]] : [])
      : rows.filter(row => !archived || row.id !== "c200");
    return { json: { items: source.slice(offset, offset + 100) } };
  };
  const scan = async () => {
    const pending: string[] = [];
    for (const archive of [false, true]) for await (const page of chatGPTHistoryPages(read, "account", known, new Set(), archive)) {
      pending.push(...page.pending);
      for (const item of page.items.values()) known[item.key] = item.fingerprint;
    }
    return pending;
  };
  expect(await scan()).toHaveLength(201);
  expect(await scan()).toEqual([]);
  rows[200]!.update_time++;
  expect(await scan()).toEqual(["c200"]);
  rows[200]!.title = "Renamed, no timestamp change";
  expect(await scan()).toEqual(["c200"]);
  archived = true;
  expect(await scan()).toEqual(["c200"]);
  expect(await scan()).toEqual([]);
  archived = false;
  expect(await scan()).toEqual(["c200"]);
});
