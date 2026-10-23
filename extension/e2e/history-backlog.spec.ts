import { createRequire } from "node:module";
import { readFileSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test, type Page } from "@playwright/test";

const require = createRequire(import.meta.url);
const esbuild = createRequire(realpathSync(require.resolve("vite/package.json")))("esbuild");
const bundle = await esbuild.build({ stdin: {
  contents: readFileSync("src/injected/index.ts", "utf8") + '\nexport {handleControlPayload, attachBridgePort, runChatGPTHistorySync};',
  resolveDir: resolve("src/injected"), loader: "ts"
}, bundle: true, write: false, format: "iife", globalName: "HistoryTest" });

async function installFixture(page: Page, total: number, rejectAfter: number, brokenId = -1, archivedTotal = 0) {
  await page.evaluate(({ total, rejectAfter, brokenId, archivedTotal }) => {
    const w = window as any;
    const state = w.historyFixture = { accepted: 0, details: 0, pages: [] as number[],
      archivedPages: [] as number[], pageAtCaptureCount: [] as number[], statuses: [] as any[], known: JSON.parse(localStorage.getItem("synthetic-receipts") ?? "{}") };
    w.fetch = async (input: string) => {
      const url = new URL(input, location.href);
      if (url.pathname === "/api/auth/session") return Response.json({ user: { id: "synthetic-account" } });
      if (url.pathname.endsWith("/sidebar")) return Response.json({ items: [], cursor: null });
      if (url.pathname === "/backend-api/conversations") {
        const offset = Number(url.searchParams.get("offset"));
        if (url.searchParams.get("is_archived") === "true") {
          state.archivedPages.push(offset);
          return Response.json({ items: Array.from({ length: Math.max(0, Math.min(100, archivedTotal - offset)) }, (_, n) => ({ id: `chat${900000 + offset + n}`, update_time: 1 })) });
        }
        state.pages.push(offset); state.pageAtCaptureCount.push(state.accepted);
        return Response.json({ items: Array.from({ length: Math.max(0, Math.min(100, total - offset)) }, (_, n) => ({ id: `chat${offset + n}`, update_time: 1 })) });
      }
      const id = Number(url.pathname.split("/").at(-1)?.replace("chat", ""));
      state.details++;
      if (brokenId === -2 && id >= 3) throw new TypeError("Synthetic offline network");
      return Response.json(id === brokenId ? { unexpected: true } : { conversation_id: brokenId === -3 && id === 3 ? "wrong-conversation" : `chat${id}`, messages: [{ id: `m${id}`, author: { role: "user" }, content: { parts: ["Synthetic history only"] } }] });
    };
    w.startFixture = () => {
      const channel = new MessageChannel();
      channel.port1.onmessage = event => {
        if (event.data.type === "HISTORY_SYNC_STATUS") state.statuses.push(event.data.payload);
        if (event.data.type !== "NETWORK_CAPTURE") return;
        const capture = event.data.payload;
        const ok = state.accepted < rejectAfter;
        if (ok) { state.accepted++; Object.assign(state.known, capture.historyFingerprints); }
        channel.port1.postMessage({ type: "CAPTURE_RECEIPT", requestId: capture.requestId, ok });
      };
      channel.port1.start();
      w.HistoryTest.attachBridgePort(channel.port2);
      w.HistoryTest.handleControlPayload({ type: "SET_CAPTURE_ENABLED", enabled: true });
    };
  }, { total, rejectAfter, brokenId, archivedTotal });
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  await page.evaluate(() => (window as any).startFixture());
}

async function runFixture(page: Page) {
  await page.evaluate(async () => {
    const w = window as any;
    await w.HistoryTest.runChatGPTHistorySync({ type: "START_HISTORY_SYNC", historyFingerprints: { ...w.historyFixture.known } });
    // Terminal status travels over the real MessageChannel after the runner returns.
    await new Promise(resolve => setTimeout(resolve, 0));
    localStorage.setItem("synthetic-receipts", JSON.stringify(w.historyFixture.known));
  });
  return page.evaluate(() => {
    const s = (window as any).historyFixture;
    return { accepted: s.accepted, details: s.details, pages: s.pages, archivedPages: s.archivedPages, pageAtCaptureCount: s.pageAtCaptureCount,
      last: s.statuses.at(-1), acknowledged: Object.keys(s.known).length };
  });
}

test("first install imports 5,207 chats page by page and resumes acknowledged work after reload/backpressure", async ({ page }) => {
  await page.route("**/*", route => route.fulfill({ contentType: "text/html", body: "Isolated backlog fixture" }));
  await page.goto("https://chatgpt.com/c/synthetic-history");
  await installFixture(page, 5207, 137);
  const interrupted = await runFixture(page);
  expect(interrupted.last.phase).toBe("failed");
  expect(interrupted.accepted).toBe(137);
  expect(interrupted.details).toBeLessThanOrEqual(139); // Two active workers, no more scheduling.
  expect(interrupted.pages).toEqual([0, 100]);
  expect(interrupted.pageAtCaptureCount).toEqual([0, 100]);
  await page.reload();
  await installFixture(page, 5207, 6000);
  const resumed = await runFixture(page);
  expect(resumed.last.phase).toBe("completed");
  expect(resumed.last.retryableFailureCount).toBe(0);
  expect(resumed.last.totalCount).toBe(5207);
  expect(resumed.details).toBe(5207 - 137);
  expect(resumed.acknowledged).toBe(5207);
  expect(resumed.pages.at(-1)).toBe(5200);
  await page.reload();
  await installFixture(page, 5207, 6000);
  const reconciled = await runFixture(page);
  expect(reconciled.details).toBe(0);
  expect(reconciled.last.skippedCount).toBe(5207);
});

test("one malformed chat remains retryable while later pages continue importing", async ({ page }) => {
  await page.route("**/*", route => route.fulfill({ contentType: "text/html", body: "Isolated malformed fixture" }));
  await page.goto("https://chatgpt.com/c/synthetic-malformed");
  await installFixture(page, 250, 1000, 3);
  const result = await runFixture(page);
  expect(result.accepted).toBe(249);
  expect(result.last.retryableFailureCount).toBe(1);
  expect(result.pages).toEqual([0, 100, 200]);
});

test("an empty active sidebar still imports every page of archived history", async ({ page }) => {
  await page.route("**/*", route => route.fulfill({ contentType: "text/html", body: "Isolated archive fixture" }));
  await page.goto("https://chatgpt.com/c/synthetic-archive");
  await installFixture(page, 0, 1000, -1, 105);
  const result = await runFixture(page);
  expect(result.last.phase).toBe("completed");
  expect(result.last.retryableFailureCount).toBe(0);
  expect(result.accepted).toBe(105);
  expect(result.archivedPages).toEqual([0, 100]);
});

test("a network outage halts new downloads instead of walking the entire backlog", async ({ page }) => {
  await page.route("**/*", route => route.fulfill({ contentType: "text/html", body: "Isolated offline fixture" }));
  await page.goto("https://chatgpt.com/c/synthetic-offline");
  await installFixture(page, 5207, 6000, -2);
  const result = await runFixture(page);
  expect(result.last.phase).toBe("failed");
  expect(Date.parse(result.last.retryAfter)).toBeGreaterThan(Date.now());
  expect(result.details).toBeLessThanOrEqual(5);
  expect(result.pages).toEqual([0]);
});

test("wrong-conversation response is not acknowledged while later pages still import", async ({ page }) => {
  await page.route("**/*", route => route.fulfill({ contentType: "text/html", body: "Synthetic identity mismatch" }));
  await page.goto("https://chatgpt.com/");
  await installFixture(page, 250, 1000, -3);
  const result = await runFixture(page);
  expect(result.accepted).toBe(249);
  expect(result.last.retryableFailureCount).toBe(1);
  expect(result.pages).toEqual([0, 100, 200]);
  expect(await page.evaluate(() => Object.keys((window as any).historyFixture.known).some(key => JSON.parse(key).at(-1) === "chat3"))).toBe(false);
});
