import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";

async function inventory(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await inventory(path));
    else files.push({ path, bytes: (await stat(path)).size });
  }
  return files;
}

// The companion must stay small. Deliberate increases require a reviewed budget change.
const files = await inventory("dist");
const total = files.reduce((sum, file) => sum + file.bytes, 0);
if (total > 512 * 1024) throw new Error(`Extension exceeds its 512 KiB budget: ${total} bytes`);
if (files.some(file => /\.(map|woff2?|ttf)$/.test(file.path))) {
  throw new Error("Production extension must not bundle source maps or web fonts");
}
console.log(`Extension bundle: ${total.toLocaleString()} bytes / 524,288-byte budget`);
