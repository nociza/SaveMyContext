// Synthetic profiles only. JS heap is not RSS; sampled peaks are lower bounds.
// --revision=<commit> loads the complete source graph without changing the worktree.
import { createRequire } from "node:module";
import { readFileSync, realpathSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { resolve, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { cpus, tmpdir } from "node:os";
const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const require = createRequire(root + "/package.json");
const { chromium } = require("@playwright/test");
const esbuild = createRequire(realpathSync(require.resolve("vite/package.json")))("esbuild");
const revision = process.argv.find(arg => arg.startsWith("--revision="))?.slice(11);
const rounds = Number(process.argv.find(arg => arg.startsWith("--rounds="))?.slice(9) ?? 3);
if (!Number.isInteger(rounds) || rounds < 1 || rounds > 100) throw Error("--rounds must be 1–100");
const source = path => revision ? execFileSync("git", ["show", `${revision}:extension/${relative(root, path)}`], { cwd: root, encoding: "utf8" }) : readFileSync(path, "utf8");
const plugins = revision ? [{ name: "revision", setup(build) {
  build.onLoad({ filter: /\.ts$/ }, args => args.path.startsWith(root + "/src/") ? { contents: source(args.path), loader: "ts" } : undefined);
} }] : [];
const build = async (contents, resolveDir = root, globalName = "MemoryBench") => (await esbuild.build({ stdin: { contents, resolveDir, loader: "ts" }, bundle: true, write: false, format: "iife", globalName, plugins })).outputFiles[0].text;
const hook = await build(source(root + "/src/injected/index.ts") + '\nexport {handleControlPayload, attachBridgePort};', root + "/src/injected", "HookBench");
const content = await build(source(root + "/src/content/index.ts"), root + "/src/content", "ContentBench");
const pipeline = await build('export {ChatGPTScraper} from "./src/providers/chatgpt"; export {buildIngestPayload} from "./src/background/diff"; export {IndexedCaptureStore, enqueueCapture, drainCaptures} from "./src/background/outbox";');
// Off-the-record contexts keep storage in RAM and distort large IndexedDB
// churn. Use a disposable disk-backed profile for the persistence workload.
const profile = await mkdtemp(resolve(tmpdir(), "smc-memory-"));
const persistent = await chromium.launchPersistentContext(profile, { headless: true });
await persistent.route("**/*", route => route.fulfill({ contentType: "text/html", body: "<main>Synthetic memory fixture</main>" }));
for (const page of persistent.pages()) await page.close();
const browser = persistent.browser();
const browserCdp = await browser.newBrowserCDPSession();
const mib = n => +(n / 1048576).toFixed(3);
const rss = async () => {
  const { processInfo } = await browserCdp.send("SystemInfo.getProcessInfo");
  const ids = processInfo.map(p => p.id).filter(n => Number.isSafeInteger(n) && n > 0);
  try {
    // Only PIDs reported by this disposable browser, never the user's browser.
    const rows = execFileSync("ps", ["-o", "pid=,rss=", "-p", ids.join(",")], { encoding: "utf8" }).trim().split("\n").map(line => line.trim().split(/\s+/).map(Number));
    return { processRssSumMiB: +(rows.reduce((sum, [, kb]) => sum + kb, 0) / 1024).toFixed(2), processes: rows.length,
      rssByProcess: rows.map(([id, kb]) => ({ type: processInfo.find(p => p.id === id)?.type, miB: +(kb / 1024).toFixed(2) })) };
  } catch { return { processRssSumMiB: null }; }
};
const context = async () => {
  const ctx = await browser.newContext();
  await ctx.route("**/*", route => route.fulfill({ contentType: "text/html", body: "<main>Synthetic memory fixture</main>" }));
  return ctx;
};
console.log(JSON.stringify({ kind: "environment", revision: revision ?? "working-tree", browser: browser.version(), node: process.version, cpu: cpus()[0]?.model,
  notes: "Main-world fixture combines extension worlds in one renderer; no real backend. RSS sums include shared pages more than once. Peaks sampled at ~10ms; not a hard RAM cap or multi-day leak test." }));
try {
  // Controlled per-tab script overhead, separate from capture fixtures.
  for (const enabled of process.argv.includes("--skip-idle") ? [] : [false, true]) {
    const ctx = await context(), clients = [];
    for (let i = 0; i < 12; i++) {
      const page = await ctx.newPage();
      await page.goto(`https://chatgpt.com/c/idle-${i}`);
      if (enabled) {
        await page.evaluate(() => {
          window.chrome = { runtime: { onMessage: { addListener() {} }, sendMessage: async m => m.type === "GET_SETTINGS"
            ? { captureConsentGranted: false, capturePaused: true, enabledProviders: { chatgpt: true }, contextSuggestionsEnabled: false, pageSurfaceScope: "ai_providers" } : { ok: true } }, storage: { onChanged: { addListener() {} } } };
        });
        await page.addScriptTag({ content: hook });
        await page.addScriptTag({ content });
        await page.waitForFunction(() => document.documentElement.getAttribute("data-savemycontext-main-world-ready") === "1");
      }
      clients.push(await ctx.newCDPSession(page));
    }
    for (const client of clients) await client.send("HeapProfiler.collectGarbage");
    const heaps = await Promise.all(clients.map(c => c.send("Runtime.getHeapUsage")));
    console.log(JSON.stringify({ kind: "idle-scripts", scriptsEnabled: enabled, tabs: 12, heapMiB: mib(heaps.reduce((n, h) => n + h.usedSize + (h.backingStorageSize ?? 0), 0)), ...await rss() }));
    await ctx.close();
  }
  for (const responseMiB of [2, 6]) {
    const ctx = persistent, page = await ctx.newPage();
    await page.goto("https://chatgpt.com/c/import-fixture");
    await page.evaluate(responseMiB => {
      window.captures = [];
      // No permanent reference to a giant fixture string in the measurement.
      window.fetch = async input => new Response(JSON.stringify({ conversation_id: String(input).split("/").at(-1), title: "Synthetic", messages: Array.from({ length: 32 }, (_, i) => ({ id: `m-${i}`, author: { role: i % 2 ? "assistant" : "user" }, content: { content_type: "text", parts: [String(i).padStart(3, "0") + "x".repeat(responseMiB * 1048576 / 32 - 3)] } })) }), { headers: { "content-type": "application/json" } });
    }, responseMiB);
    await page.addScriptTag({ content: hook });
    await page.addScriptTag({ content: pipeline });
    await page.evaluate(() => {
      const channel = new MessageChannel();
      channel.port1.onmessage = event => { if (event.data.type === "NETWORK_CAPTURE") window.captures.push(event.data.payload); };
      channel.port1.start();
      window.benchPort = channel.port1;
      HookBench.attachBridgePort(channel.port2);
      HookBench.handleControlPayload({ type: "SET_CAPTURE_ENABLED", enabled: true });
      window.store = new MemoryBench.IndexedCaptureStore();
    });
    const client = await ctx.newCDPSession(page);
    const checkpoint = async () => { await client.send("HeapProfiler.collectGarbage"); const h = await client.send("Runtime.getHeapUsage"); return { jsMiB: mib(h.usedSize), backingMiB: mib(h.backingStorageSize ?? 0) }; };
    const idle = await checkpoint();
    for (let round = 0; round < rounds; round++) {
      let running = true, peak = 0, stage = "capture";
      const stagePeaks = {};
      const sample = (async () => { while (running) {
        const h = await client.send("Runtime.getHeapUsage"), bytes = h.usedSize + (h.backingStorageSize ?? 0);
        peak = Math.max(peak, bytes); stagePeaks[stage] = Math.max(stagePeaks[stage] ?? 0, bytes);
        await new Promise(resolve => setTimeout(resolve, 10));
      } })();
      const start = performance.now();
      const checkpoints = {};
      try {
        await page.evaluate(async round => {
          await Promise.all(Array.from({ length: 4 }, (_, i) => fetch(`/backend-api/conversation/r${round}-${i}`).then(r => r.text()).then(() => undefined)));
        }, round);
        await page.waitForFunction(() => window.captures.length === 4);
        checkpoints.captured = await checkpoint();
        stage = "parse";
        const wireBytes = await page.evaluate(async () => {
          window.payloads = [];
          let wireBytes = 0;
          for (const event of window.captures) {
            wireBytes += new TextEncoder().encode(JSON.stringify(event)).byteLength;
            const snapshot = new MemoryBench.ChatGPTScraper().parse(event);
            if (snapshot?.messages.length !== 32) throw Error("Capture parser lost messages");
            const payload = await MemoryBench.buildIngestPayload(snapshot, event, { seenMessageIds: [] });
            if (!payload) throw Error("Missing capture payload");
            window.payloads.push(payload);
          }
          return wireBytes;
        });
        checkpoints.parsed = await checkpoint();
        stage = "persist";
        await page.evaluate(async () => {
          for (const payload of window.payloads) await MemoryBench.enqueueCapture(window.store, "https://memory.invalid", payload);
          window.payloads = []; window.captures = [];
          if (await window.store.count() !== 4) throw Error("Persistence count mismatch");
        });
        checkpoints.persisted = await checkpoint();
        stage = "drain";
        await page.evaluate(async () => {
          const delivered = await MemoryBench.drainCaptures(window.store, "https://memory.invalid", async ({ payload }) => {
            if (payload.messages.length !== 32 || !payload.raw_capture.response.text) throw Error("Evidence lost");
          });
          if (delivered !== 4 || await window.store.count() !== 0) throw Error("Delivery mismatch");
        });
        checkpoints.afterDrain = await checkpoint();
        running = false; await sample;
        console.log(JSON.stringify({ kind: "capture-memory", responseMiB, concurrentResponses: 4, round, idle, checkpoints, wireMiB: mib(wireBytes), sampledPeakMiB: mib(peak), stagePeakMiB: Object.fromEntries(Object.entries(stagePeaks).map(([k,v]) => [k,mib(v)])), elapsedMs: Math.round(performance.now() - start), ...await rss() }));
      } finally { running = false; await sample; }
    }
    await page.close();
  }
} finally { await persistent.close(); await rm(profile, { recursive: true, force: true }); }
