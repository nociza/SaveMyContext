import { createRequire } from "node:module";
import { realpathSync } from "node:fs";
// Use the already-pinned Vite build toolchain; no extra runtime dependency.
const require = createRequire(import.meta.url);
const viteRequire = createRequire(realpathSync(require.resolve("vite/package.json")));
await viteRequire("esbuild").build({
  entryPoints: ["scripts/preview-captures.ts"],
  outfile: "dist/tools/preview-captures.mjs",
  bundle: true, platform: "node", format: "esm", target: "node22"
});
