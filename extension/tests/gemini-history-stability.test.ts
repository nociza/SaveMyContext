import { expect, it, vi } from "vitest";

it("does not manufacture changing message timestamps when Gemini supplies none", async () => {
  vi.stubGlobal("window", { fetch: globalThis.fetch });
  vi.useFakeTimers();
  try {
    const { buildGeminiSyntheticMessages } = await import("../src/injected/gemini-history");
    const blocks = [{ userText: "A question", assistantText: "An answer" }];
    vi.setSystemTime(new Date("2026-01-01"));
    const first = buildGeminiSyntheticMessages("u0__chat", blocks);
    vi.setSystemTime(new Date("2026-02-01"));
    expect(buildGeminiSyntheticMessages("u0__chat", blocks)).toEqual(first);
    expect(first.every(message => message.occurredAt === undefined)).toBe(true);
    expect(buildGeminiSyntheticMessages("u0__chat", [{ ...blocks[0], occurredAt: "2026-01-01T00:00:00.000Z" }])[1].occurredAt).toBe("2026-01-01T00:00:00.001Z");
  } finally { vi.useRealTimers(); vi.unstubAllGlobals(); }
});
