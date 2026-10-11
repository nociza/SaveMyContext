import { createRequire } from "node:module";
import { realpathSync } from "node:fs";
import { expect, test } from "@playwright/test";
const require = createRequire(import.meta.url);
const esbuild = createRequire(realpathSync(require.resolve("vite/package.json")))("esbuild");
const bundle = await esbuild.build({ stdin: { contents: 'export {createQuickSearchPalette} from "./src/content/quick-search"; export {createContextSuggestionController} from "./src/content/context-suggestions";', resolveDir: process.cwd() }, bundle: true, write: false, format: "iife", globalName: "MemoryUI" });

test("closing quick search releases result DOM and prevents late responses from retaining it", async ({ page }) => {
  await page.route("**/*", route => route.fulfill({ contentType: "text/html", body: '<textarea id="prompt-textarea"></textarea>' }));
  await page.goto("https://chatgpt.com/c/retention");
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  await page.locator("#prompt-textarea").focus();
  await page.evaluate(() => {
    const w = window as any;
    w.searchRequests = [];
    w.palette = w.MemoryUI.createQuickSearchPalette(() => new Promise(resolve => w.searchRequests.push(resolve)));
    w.palette.toggle();
  });
  const host = page.locator("#savemycontext-quick-search-host");
  await host.locator("input").fill("synthetic");
  await expect.poll(() => page.evaluate(() => (window as any).searchRequests.length)).toBe(1);
  await page.evaluate(() => (window as any).palette.toggle());
  await page.evaluate(() => (window as any).searchRequests.shift()({ ok: true, results: [{ id: "r", title: "Retained result", snippet: "x".repeat(1048576), kind: "session" }] }));
  await expect(host.locator(".results")).toBeEmpty();
  await page.evaluate(() => (window as any).palette.toggle());
  await expect.poll(() => page.evaluate(() => (window as any).searchRequests.length)).toBe(1);
  await page.evaluate(() => (window as any).searchRequests.shift()({ ok: true, results: [{ id: "r", title: "Fresh result", snippet: "Refetched", kind: "session" }] }));
  await expect(host.locator(".result-title")).toHaveText("Fresh result");
  await host.locator(".result").evaluate(node => { (window as any).originalCard = node; });
  await host.locator(".result").hover();
  expect(await host.locator(".result").evaluate(node => node === (window as any).originalCard)).toBe(true);
  await host.getByRole("button", { name: "Insert" }).click();
  await expect(page.locator("#prompt-textarea")).toHaveValue(/Refetched/);
  await expect(host.locator(".results")).toBeEmpty();
  await expect(host).toBeHidden();
});

test("disabling suggestions invalidates a pending context lookup before it can search", async ({ page }) => {
  await page.route("**/*", route => route.fulfill({ contentType: "text/html", body: '<textarea id="prompt-textarea">Explain the synthetic project</textarea>' }));
  await page.goto("https://chatgpt.com/c/retention");
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  await page.evaluate(() => {
    const w = window as any;
    w.enabled = true; w.changeListeners = []; w.searchCalls = 0;
    w.chrome = { storage: { onChanged: { addListener(fn: unknown) { w.changeListeners.push(fn); } } } };
    w.controller = w.MemoryUI.createContextSuggestionController(async (m: any) => {
      if (m.type === "GET_SETTINGS") return { captureConsentGranted: true, capturePaused: false, contextSuggestionsEnabled: w.enabled, contextSuggestionsFloatingButtonEnabled: true, pageSurfaceScope: "ai_providers" };
      if (m.type === "GET_ACTIVE_CHAT_CONTEXT") return new Promise(resolve => { w.resolveContext = resolve; });
      w.searchCalls++; return { ok: true, results: [] };
    });
  });
  await expect.poll(() => page.evaluate(() => Boolean((window as any).resolveContext))).toBe(true);
  await page.evaluate(async () => {
    const w = window as any;
    w.enabled = false;
    w.changeListeners.forEach((fn: any) => fn({ "savemycontext.settings.cache": {} }, "local"));
    await new Promise(resolve => setTimeout(resolve, 0));
    w.resolveContext({ ok: true, snapshot: { title: "Synthetic", messages: [] } });
    await new Promise(resolve => setTimeout(resolve, 0));
  });
  expect(await page.evaluate(() => (window as any).searchCalls)).toBe(0);
});
