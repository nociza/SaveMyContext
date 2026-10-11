// Disposable synthetic data only. No user profile, credentials or network.
// Keep the fixture identical across experiments; report distributions, not best runs.
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve, relative } from "node:path";
import { cpus, platform, arch } from "node:os";
const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const require = createRequire(root + "/package.json");
const { chromium } = require("@playwright/test");
const esbuild = createRequire(realpathSync(require.resolve("vite/package.json")))("esbuild");
const revision = process.argv.find(arg => arg.startsWith("--revision="))?.slice(11);
const plugins = revision ? [{ name: "revision", setup(build) {
  build.onLoad({ filter: /\.ts$/ }, args => args.path.startsWith(root + "/src/") ? {
    contents: execFileSync("git", ["show", `${revision}:extension/${relative(root, args.path)}`], { cwd: root, encoding: "utf8" }), loader: "ts"
  } : undefined);
} }] : [];
const bundle = await esbuild.build({
  stdin: { contents: 'export {IndexedCaptureStore, enqueueCapture, drainCaptures} from "./src/background/outbox";', resolveDir: root },
  bundle: true, write: false, format: "iife", globalName: "QueueBench", plugins
});
const browser = await chromium.launch({ headless: true });
const readBatchLimit = process.argv.includes("--single-read") ? 1 : 16;
console.log(JSON.stringify({ kind: "environment", revision: revision ?? "working-tree", readBatchLimit, browser: browser.version(), node: process.version, cpu: cpus()[0]?.model, platform: platform(), arch: arch() }));
try {
  for (const [count, payloadBytes] of [[0,0], [100,8192], [999,8192], [500,131072], [999,122880]]) {
    const context = await browser.newContext();
    await context.route("**/*", route => route.fulfill({ contentType: "text/html", body: "Synthetic queue benchmark" }));
    const page = await context.newPage();
    await page.goto("https://benchmark.invalid/");
    await page.addScriptTag({ content: bundle.outputFiles[0].text });
    const cdp = await context.newCDPSession(page);
    await cdp.send("Performance.enable");
    await page.evaluate(async ({ count, payloadBytes, readBatchLimit }) => {
      const store = window.benchStore = new QueueBench.IndexedCaptureStore(readBatchLimit);
      for (let i = 0; i < count; i++) {
        await store.put({ id: "synthetic-" + i, backendUrl: "https://benchmark.invalid",
          payload: { messages: [], raw_capture: {}, padding: "x".repeat(payloadBytes) },
          createdAt: i, bytes: payloadBytes });
      }
    }, { count, payloadBytes, readBatchLimit });
    await cdp.send("HeapProfiler.collectGarbage");
    const before = (await cdp.send("Runtime.getHeapUsage")).usedSize;
    const counts = await page.evaluate(async () => {
      const samples = [];
      for (let i = 0; i < 7; i++) {
        const start = performance.now();
        const count = await window.benchStore.count();
        samples.push({ count, ms: performance.now() - start });
      }
      return samples;
    });
    if (counts.some(sample => sample.count !== count)) throw Error("Incorrect queue count");
    const heapAfterCount = (await cdp.send("Runtime.getHeapUsage")).usedSize;
    const enqueue = await page.evaluate(async () => {
      const samples = [];
      for (let i = 0; i < 5; i++) {
        const start = performance.now();
        await QueueBench.enqueueCapture(window.benchStore, "https://benchmark.invalid", { messages: [], raw_capture: {}, padding: "new-item" });
        samples.push(performance.now() - start);
      }
      return samples;
    });
    const drain = await page.evaluate(async () => {
      let delivered = 0;
      const start = performance.now();
      await QueueBench.drainCaptures(window.benchStore, "https://benchmark.invalid", async () => {
        if (delivered >= 10) throw Error("synthetic batch boundary");
        delivered++;
      }).catch(error => { if (error.message !== "synthetic batch boundary") throw error; });
      return { ms: performance.now() - start, delivered, remaining: await window.benchStore.count() };
    });
    if (drain.remaining !== count + 1 - drain.delivered) throw Error("Lost capture during drain");
    const summary = samples => {
      const values = [...samples].sort((a,b) => a-b);
      return { medianMs: +values[Math.floor(values.length/2)].toFixed(3), maxMs: +values.at(-1).toFixed(3), samples: samples.map(n => +n.toFixed(3)) };
    };
    console.log(JSON.stringify({ kind: "queue", count, nominalMiB: count*payloadBytes/1048576,
      countTiming: summary(counts.map(s => s.ms)), enqueueTiming: summary(enqueue), drain,
      heapBeforeMiB: +(before/1048576).toFixed(2), heapAfterCountMiB: +(heapAfterCount/1048576).toFixed(2) }));
    await context.close();
  }
} finally { await browser.close(); }
