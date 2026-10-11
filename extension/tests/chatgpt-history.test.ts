import { expect, it, vi } from "vitest";
import { discoverChatGPTHistory } from "../src/injected/chatgpt-history";

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
  await expect(discoverChatGPTHistory(async () => ({ json: { items: rows } }), "a")).rejects.toThrow("page limit");
});

it("does not trust missing timestamps or unknown account scope", async () => {
  const read = async () => ({ json: { items: [{ id: "top" }] } });
  const first = await discoverChatGPTHistory(read, undefined);
  const item = first.items.get("top")!;
  expect((await discoverChatGPTHistory(read, undefined, { [item.key]: item.fingerprint })).pending).toEqual(["top"]);
});
