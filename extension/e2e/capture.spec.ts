import { createRequire } from "node:module";
import { realpathSync } from "node:fs";
import { chromium, expect, test } from "@playwright/test";

const require = createRequire(import.meta.url);
const viteRequire = createRequire(realpathSync(require.resolve("vite/package.json")));
const bundle = await viteRequire("esbuild").build({
  stdin: {
    contents: 'export {extractPageChatContext} from "./src/content/chat-context-dump"; export {IndexedCaptureStore} from "./src/background/outbox";',
    resolveDir: process.cwd()
  }, bundle: true, write: false, format: "iife", globalName: "CaptureTest"
});

test("DOM fallback preserves turn order/formatting and IndexedDB survives reopening", async () => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  await context.route("**/*", route => route.fulfill({
    contentType: "text/html",
    body: '<main><div data-message-author-role="user">First question</div><div data-message-author-role="assistant"><pre>Reply\n    code()</pre></div><div data-message-author-role="user">Second question</div></main>'
  }));
  try {
    let page = await context.newPage();
    await page.goto("https://chatgpt.com/g/g-p-abc-my-project/c/local-fixture");
    await page.addScriptTag({ content: bundle.outputFiles[0].text });
    const snapshot = await page.evaluate(() => (window as any).CaptureTest.extractPageChatContext().snapshot);
    expect(snapshot.completeness).toBe("partial");
    expect(snapshot.externalSessionId).toBe("local-fixture");
    expect(snapshot.messages.map((m: any) => m.role)).toEqual(["user", "assistant", "user"]);
    expect(snapshot.messages[1].content).toContain("\n    code()");
    await page.evaluate(async () => {
      const store = new (window as any).CaptureTest.IndexedCaptureStore();
      await store.put({ id: "pending", backendUrl: "https://original", payload: { messages: [] }, createdAt: 1, bytes: 1 });
    });
    await page.close();
    page = await context.newPage();
    await page.goto("https://chatgpt.com/c/local-fixture");
    await page.addScriptTag({ content: bundle.outputFiles[0].text });
    const ids = await page.evaluate(async () => (await new (window as any).CaptureTest.IndexedCaptureStore().list()).map((item: any) => item.id));
    expect(ids).toEqual(["pending"]);
  } finally {
    await context.close();
    await browser.close();
  }
});
