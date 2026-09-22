import assert from "node:assert/strict";
import { cp, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import test from "node:test";

test("frontend builds independently with only Node, without Python, backend, or extension files", async () => {
  const root = fileURLToPath(new URL("../", import.meta.url));
  const copy = await mkdtemp(join(tmpdir(), "smc-standalone-build-"));
  try {
    for (const name of ["src", "scripts", "package.json"]) await cp(join(root, name), join(copy, name), { recursive: true });
    execFileSync(process.execPath, ["scripts/build.mjs"], { cwd: copy });
    const html = await readFile(join(copy, "dist/index.html"), "utf8");
    assert.match(html, /\.\/assets\/app.js/);
    assert.doesNotMatch(html, /backend|chrome-extension|dash\.berkeleycs/);
    const component = await readFile(join(copy, "dist/assets/workspace.js"), "utf8");
    assert.doesNotMatch(component, /^import\s/m, "Legacy two-file dashboard embeds must not acquire an undeclared JS dependency");
    for (const name of ["app.js", "embed.js", "workspace.js", "workspace.css", "config.json", "config.js"]) {
      assert.ok((await stat(join(copy, "dist/assets", name))).size > 0);
    }
  } finally { await rm(copy, { recursive: true, force: true }); }
});
