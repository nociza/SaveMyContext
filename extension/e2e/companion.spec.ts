import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createServer } from "node:http";
import { chromium, expect, test } from "@playwright/test";

test("capture companion pauses offline, retains its queue, and launches one workspace without credentials", async ({}, testInfo) => {
  const profile = await mkdtemp(join(tmpdir(), "smc-companion-fixture-"));
  const dist = resolve("dist");
  const server = createServer((_request, response) => {
    response.writeHead(200, { "Content-Type": "text/html" });
    response.end("<h1>Workspace fixture</h1>");
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Fixture server did not start");
  const workspaceDestination = `http://127.0.0.1:${address.port}/memory`;
  const context = await chromium.launchPersistentContext(profile, {
    channel: "chromium", headless: true,
    args: [`--disable-extensions-except=${dist}`, `--load-extension=${dist}`]
  });
  try {
    const worker = context.serviceWorkers()[0] || await context.waitForEvent("serviceworker");
    const origin = `chrome-extension://${new URL(worker.url()).host}`;
    const popup = await context.newPage();
    await popup.goto(`${origin}/popup.html`);
    await expect(popup.locator("#pause")).toBeEnabled();
    // Refuse accidental whole-corpus or model-worker requests from the new popup.
    await worker.evaluate(() => {
      const originalFetch = globalThis.fetch;
      (globalThis as any).companionRequests = [];
      globalThis.fetch = async (...args) => {
        (globalThis as any).companionRequests.push(String(args[0]));
        return originalFetch(...args);
      };
    });
    const defaults = await popup.evaluate(() => chrome.runtime.sendMessage({ type: "GET_SETTINGS" }));
    expect(defaults.autoSyncHistory).toBe(false);
    await popup.locator("#pause").click();
    await expect(popup.locator("#pause")).toHaveText("Resume capture");
    await popup.reload();
    await expect(popup.locator("#capture-state")).toHaveText("Capture paused");
    const rejected = await popup.evaluate(() => chrome.runtime.sendMessage({
      type: "SAVE_SOURCE_CAPTURE", payload: { text: "must not save while paused" }
    }));
    expect(rejected).toEqual({ ok: false, error: "Capture paused" });
    await popup.evaluate(async () => {
      // Seed only synthetic queued evidence on an isolated extension origin.
      await new Promise<void>((resolve, reject) => {
        const request = indexedDB.open("smc-capture-outbox", 1);
        request.onupgradeneeded = () => request.result.createObjectStore("captures", { keyPath: "id" });
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          const db = request.result;
          const tx = db.transaction("captures", "readwrite");
          tx.objectStore("captures").put({ id: "retained", backendUrl: "https://previous.example", payload: {}, createdAt: 1, bytes: 1 });
          tx.oncomplete = () => { db.close(); resolve(); };
          tx.onerror = () => { db.close(); reject(tx.error); };
        };
      });
    });
    await popup.reload();
    await expect(popup.locator("#pending")).toHaveText("1 waiting to send");
    await popup.screenshot({ path: testInfo.outputPath("companion-paused.png") });
    await popup.locator("#pause").click();
    await expect(popup.locator("#pause")).toHaveText("Pause capture");
    await expect(popup.locator("#pending")).toHaveText("1 waiting to send");
    const requested = await worker.evaluate(() => (globalThis as any).companionRequests as string[]);
    expect(requested.some(url => /\/sessions|\/graph|\/processing|\/piles/.test(url))).toBe(false);

    // Old bookmarks still work; the workspace is the only full UI.
    const legacy = await context.newPage();
    await legacy.goto(`${origin}/pile.html?pile=todo`);
    await expect(legacy).toHaveURL(`${origin}/workspace.html?view=tasks`);
    await legacy.close();

    await popup.evaluate(async (workspaceDestination) => {
      const settings = await chrome.runtime.sendMessage({ type: "GET_SETTINGS" });
      await chrome.storage.local.set({
        "savemycontext.settings.cache": { ...settings, backendToken: undefined, workspaceUrl: workspaceDestination },
        "savemycontext.settings.secrets": { backendToken: "private-test-token" }
      });
    }, workspaceDestination);
    await popup.reload();
    await expect(popup.locator("#open-dashboard")).toBeEnabled();
    const opened = context.waitForEvent("page");
    await popup.locator("#open-dashboard").click();
    const workspace = await opened;
    await expect(workspace).toHaveURL(workspaceDestination);
    await expect(workspace.getByRole("heading", { name: "Workspace fixture" })).toBeVisible();
    expect(workspace.url()).not.toContain("private-test-token");
  } finally {
    await context.close();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await rm(profile, { recursive: true, force: true });
  }
});
