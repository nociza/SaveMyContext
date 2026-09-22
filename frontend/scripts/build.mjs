import { readFile, mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const assets = ["workspace.js", "workspace.css", "embed.js", "app.js", "config.js", "config.json", "page.css"];
const sources = new Map(await Promise.all(assets.map(async name => [name, await readFile(join(root, "src", name))])));
const html = await readFile(join(root, "src/index.html"), "utf8");
const backend = process.argv.includes("--backend") || process.argv.includes("--check-backend");
const destination = backend ? join(root, "../backend/app/workspace/web") : join(root, "dist");
const files = new Map([...sources].map(([name, bytes]) => [backend ? name : `assets/${name}`, bytes]));
files.set("index.html", Buffer.from(html.replaceAll("__SMC_ASSETS__", backend ? "/workspace-assets" : "./assets")));
if (!backend) for (const name of ["LICENSE", "NOTICE"]) files.set(name, await readFile(join(root, name)));
// Keep vendored files for Python wheels: no Node or frontend checkout needed at runtime.
files.set("BUILD.txt", Buffer.from("Generated from frontend/src by frontend/scripts/build.mjs. Do not edit these copies.\n"));
if (process.argv.includes("--check-backend")) {
  for (const [name, expected] of files) {
    const actual = await readFile(join(destination, name));
    if (!actual.equals(expected)) throw new Error(`Backend UI drift: ${name}. Run npm run build:backend in frontend/.`);
  }
  console.log("Backend assets match the frontend source.");
} else {
  // Overwrite only the known build outputs; never recursively delete an arbitrary directory.
  for (const [name, bytes] of files) {
    const target = join(destination, name);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, bytes);
  }
  console.log(`Built ${files.size} files in ${destination}`);
}
