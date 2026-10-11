// Deterministic browser-side microbenchmarks, not a battery-life or RSS claim.
// --revision=<git commit> loads that revision's complete TS dependency graph.
import { createRequire } from "node:module";
import { readFileSync, realpathSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { resolve, relative } from "node:path";
import { fileURLToPath } from "node:url";
const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const require = createRequire(root + "/package.json");
const { chromium } = require("@playwright/test");
const esbuild = createRequire(realpathSync(require.resolve("vite/package.json")))("esbuild");
const revision = process.argv.find(arg => arg.startsWith("--revision="))?.slice(11);
const source = path => revision ? execFileSync("git", ["show", `${revision}:extension/${relative(root, path)}`], { cwd: root, encoding: "utf8" }) : readFileSync(path, "utf8");
const plugins = revision ? [{ name: "revision", setup(build) {
  build.onLoad({ filter: /\.ts$/ }, args => args.path.startsWith(root + "/src/") ? { contents: source(args.path), loader: "ts" } : undefined);
} }] : [];
const build = (contents, resolveDir) => esbuild.build({ stdin: { contents, resolveDir, loader: "ts" }, bundle: true, write: false, format: "iife", globalName: "BrowserBench", plugins });
const hook = await build(source(root + "/src/injected/index.ts") + '\nexport {handleControlPayload};', root + "/src/injected");
const suggestions = await build('export {createContextSuggestionController} from "./src/content/context-suggestions";', root);
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext();
await context.route("**/*", route => route.fulfill({ contentType: "text/html", body: "<main>Synthetic provider</main>" }));
try {
  const page = await context.newPage();
  await page.goto("https://chatgpt.com/c/synthetic");
  await page.evaluate(() => {
    const response = Promise.resolve(new Response("{}"));
    window.fetch = () => response;
  });
  await page.addScriptTag({ content: hook.outputFiles[0].text });
  for (const enabled of [false, true]) {
    const samples = await page.evaluate(async enabled => {
      BrowserBench.handleControlPayload({ type: "SET_CAPTURE_ENABLED", enabled });
      const samples = [];
      for (let round = 0; round < 7; round++) {
        const start = performance.now();
        for (let n = 0; n < 10_000; n++) await fetch("https://chatgpt.com/backend-api/me");
        samples.push(performance.now() - start);
      }
      return samples;
    }, enabled);
    console.log(JSON.stringify({ kind: "fetch-dispatch", revision: revision ?? "working-tree", enabled, callsPerSample: 10000, samples, medianMs: [...samples].sort((a,b) => a-b)[3] }));
  }
  await page.close();
  const pages = [];
  for (let n = 0; n < 12; n++) {
    const tab = await context.newPage();
    await tab.goto("https://chatgpt.com/c/synthetic-" + n);
    await tab.evaluate(() => {
      window.benchTicks = 0; window.benchRequests = 0;
      const native = window.setInterval;
      window.setInterval = (fn, ms, ...args) => native(() => { window.benchTicks++; fn(...args); }, ms);
      window.chrome = { storage: { onChanged: { addListener() {} } } };
    });
    await tab.addScriptTag({ content: suggestions.outputFiles[0].text });
    await tab.evaluate(() => BrowserBench.createContextSuggestionController(async message => {
      if (message.type !== "GET_SETTINGS") window.benchRequests++;
      return { captureConsentGranted: true, capturePaused: false, contextSuggestionsEnabled: false, contextSuggestionsFloatingButtonEnabled: true, pageSurfaceScope: "ai_providers" };
    }));
    pages.push(tab);
  }
  const clients = await Promise.all(pages.map(tab => context.newCDPSession(tab)));
  for (const client of clients) await client.send("Performance.enable");
  const cpu = async () => (await Promise.all(clients.map(async client => (await client.send("Performance.getMetrics")).metrics.find(metric => metric.name === "TaskDuration").value))).reduce((a,b) => a+b, 0);
  const before = await cpu();
  await new Promise(resolve => setTimeout(resolve, 11_000));
  const after = await cpu();
  const idle = await Promise.all(pages.map(tab => tab.evaluate(() => ({ ticks: window.benchTicks, requests: window.benchRequests }))));
  console.log(JSON.stringify({ kind: "disabled-suggestions-idle", revision: revision ?? "working-tree", tabs: pages.length, seconds: 11,
    timerCallbacks: idle.reduce((n,s) => n+s.ticks, 0), backendRequests: idle.reduce((n,s) => n+s.requests, 0), rendererTaskMs: (after-before)*1000 }));
} finally { await context.close(); await browser.close(); }
