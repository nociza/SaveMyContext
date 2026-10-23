import { createRequire } from "node:module";
import { realpathSync } from "node:fs";
import { expect, test } from "@playwright/test";
const require = createRequire(import.meta.url);
const esbuild = createRequire(realpathSync(require.resolve("vite/package.json")))("esbuild");
const bundle = await esbuild.build({ stdin: {
  contents: 'export {runGrokHistorySync} from "./src/injected/grok-history"; export {setHistoryCaptureEnabled} from "./src/injected/capture-permission";',
  resolveDir: process.cwd()
}, bundle: true, write: false, format: "iife", globalName: "PaginationTest" });

for (const mode of ["empty-cursors", "invalid-id", "invalid-cursor", "path-injection"] as const) {
  test(`Grok ${mode} remains incomplete rather than skipping history or looping forever`, async ({ page }) => {
    await page.route("**/*", route => route.fulfill({ contentType: "text/html", body: "Synthetic pagination" }));
    await page.goto("https://grok.com/");
    await page.evaluate(mode => {
      const w = window as any;
      w.requests = 0;
      window.fetch = async () => {
        w.requests++;
        if (w.requests > 5) throw new Error("Test guard: unbounded pagination");
        return Response.json({
          conversations: mode === "invalid-id" ? [null] : mode === "path-injection" ? [{ conversationId: "../../other?query" }] : [],
          nextPageToken: mode === "invalid-cursor" ? { unexpected: true } : `cursor-${w.requests}`,
        });
      };
    }, mode);
    await page.addScriptTag({ content: bundle.outputFiles[0].text });
    const result = await page.evaluate(async () => {
      const w = window as any, updates: any[] = [], captures: any[] = [];
      w.PaginationTest.setHistoryCaptureEnabled(true);
      await w.PaginationTest.runGrokHistorySync(undefined, {
        runId: "synthetic-run", postStatus: (update: any) => updates.push(update), postCapture: (capture: any) => captures.push(capture),
      });
      return { last: updates.at(-1), requests: w.requests, captures: captures.length };
    });
    expect(result.last.phase).toBe("failed");
    expect(result.requests).toBe(mode === "empty-cursors" ? 3 : 1);
    expect(result.last.message).not.toContain("Test guard");
    expect(result.captures).toBe(0);
  });
}
