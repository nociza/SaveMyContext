import { createRequire } from "node:module";
import { realpathSync } from "node:fs";
import { expect, test } from "@playwright/test";
const require = createRequire(import.meta.url);
const esbuild = createRequire(realpathSync(require.resolve("vite/package.json")))("esbuild");
const bundle = await esbuild.build({ stdin: { contents: 'export {SyncStateStore} from "./src/shared/sync-state-store";', resolveDir: process.cwd() }, bundle: true, write: false, format: "iife", globalName: "StateTest" });

test("sync metadata migration commits before freeing quota, preserves concurrent chats, and survives reopening", async ({ page }) => {
  await page.route("**/*", route => route.fulfill({ contentType: "text/html", body: "Synthetic sync state" }));
  await page.goto("https://fixture.example/");
  await page.evaluate(() => {
    const legacy = { "chatgpt:old": { seenMessageIds: ["old-message"], historyItemKey: "item", historyFingerprint: "fingerprint" } };
    (window as any).legacy = legacy;
    (window as any).chrome = { storage: { local: {
      get: async () => ({ "savemycontext.sync-state": (window as any).legacy }),
      remove: async () => { (window as any).legacy = undefined; },
    } } };
  });
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  const result = await page.evaluate(async () => {
    const Store = (window as any).StateTest.SyncStateStore;
    await Promise.all(Array.from({ length: 20 }, (_, i) => new Store().set(`chatgpt:${i}`, { seenMessageIds: [`m${i}`], messageFingerprints: { [`m${i}`]: "hash" } })));
    const store = new Store();
    return { count: Object.keys(await store.all()).length, old: await store.get("chatgpt:old"), summary: (await store.all("chatgpt"))["chatgpt:0"], migrated: (window as any).legacy === undefined };
  });
  expect(result.count).toBe(21);
  expect(result.old.seenMessageIds).toEqual(["old-message"]);
  expect(result.summary).toEqual({ seenMessageIds: [] });
  expect(result.migrated).toBe(true);
  await page.reload();
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  expect(await page.evaluate(async () => new (window as any).StateTest.SyncStateStore().get("chatgpt:19"))).toEqual({ seenMessageIds: ["m19"], messageFingerprints: { m19: "hash" } });
});
