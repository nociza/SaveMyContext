import { dirname,resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";

import { defineConfig } from "vite";

const rootDir = dirname(fileURLToPath(import.meta.url));

export default defineConfig(({ mode }) => {
  const development = mode === "development";

  return {
    plugins: [{
      name: "distribution-notices",
      generateBundle() {
        for (const file of ["LICENSE", "NOTICE"]) this.emitFile({ type: "asset", fileName: file, source: readFileSync(resolve(rootDir, "..", file), "utf8") });
        // Only Vite's modulepreload helper ships in the extension, not its build-time dependencies.
        const viteLicense = readFileSync(resolve(rootDir, "node_modules/vite/LICENSE.md"), "utf8").split("# Licenses of bundled dependencies")[0];
        this.emitFile({ type: "asset", fileName: "THIRD_PARTY_NOTICES.txt", source: "Vite modulepreload helper\n\n" + viteLicense });
      }
    }],
    build: {
      emptyOutDir: !development,
      outDir: "dist",
      sourcemap: development,
      rollupOptions: {
        input: {
          background: resolve(rootDir, "src/background/index.ts"),
          category: resolve(rootDir, "pile.html"),
          dashboard: resolve(rootDir, "dashboard.html"),
          note: resolve(rootDir, "note.html"),
          options: resolve(rootDir, "options.html"),
          piles: resolve(rootDir, "piles.html"),
          prompts: resolve(rootDir, "prompts.html"),
          popup: resolve(rootDir, "popup.html"),
          workspace: resolve(rootDir, "workspace.html")
        },
        output: {
          assetFileNames: "assets/[name][extname]",
          chunkFileNames: "assets/[name].js",
          entryFileNames: "assets/[name].js"
        }
      }
    }
  };
});
