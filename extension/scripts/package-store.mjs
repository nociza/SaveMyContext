import { readdir, readFile, mkdir, writeFile } from "node:fs/promises";
import { resolve, relative, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { deflateRawSync } from "node:zlib";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dist = resolve(root, "dist");
const manifest = JSON.parse(await readFile(resolve(dist, "manifest.json"), "utf8"));
const pkg = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
if (manifest.manifest_version !== 3 || manifest.version !== pkg.version) throw Error("Release version mismatch");
if (!/^\d+\.\d+\.\d+$/.test(pkg.version)) throw Error("Invalid release version");
if (manifest.key || manifest.update_url) throw Error("Store build must not contain a development key/update URL");
for (const file of ["LICENSE", "NOTICE", "THIRD_PARTY_NOTICES.txt"]) await readFile(resolve(dist, file));

async function filesIn(directory) {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isSymbolicLink()) throw Error("Symlinks are not allowed in store packages");
    if (entry.isDirectory()) result.push(...await filesIn(path));
    else if (entry.isFile()) result.push(relative(dist, path).replaceAll("\\", "/"));
  }
  return result.sort();
}

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

// Standard ZIP with fixed timestamps, sorted entries and no platform metadata.
// No shell globs, recursive workspace archive, or additional packaging dependency.
const chunks = [], directory = [], files = await filesIn(dist);
let offset = 0, bytesTotal = 0;
for (const file of files) {
  if (!/^(assets\/[a-zA-Z0-9_.-]+\.(js|css)|icons\/[a-zA-Z0-9_.-]+\.(png|svg)|[a-z-]+\.html|manifest\.json|LICENSE|NOTICE|THIRD_PARTY_NOTICES\.txt)$/.test(file)) throw Error(`Unexpected release file: ${file}`);
  const data = await readFile(resolve(dist, file));
  bytesTotal += data.length;
  if (file.endsWith(".js") && /\beval\s*\(|new\s+Function\s*\(|importScripts\s*\(/.test(data.toString())) throw Error(`Dynamic code execution in ${file}`);
  const compressed = deflateRawSync(data, { level: 9 });
  const name = Buffer.from(file), checksum = crc32(data);
  const header = Buffer.alloc(30);
  header.writeUInt32LE(0x04034b50, 0); header.writeUInt16LE(20, 4);
  header.writeUInt16LE(0x800, 6); header.writeUInt16LE(8, 8); header.writeUInt16LE(33, 12);
  header.writeUInt32LE(checksum, 14); header.writeUInt32LE(compressed.length, 18);
  header.writeUInt32LE(data.length, 22); header.writeUInt16LE(name.length, 26);
  chunks.push(header, name, compressed);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6);
  header.copy(central, 8, 6, 28); central.writeUInt32LE(offset, 42);
  directory.push(central, name);
  offset += header.length + name.length + compressed.length;
}
if (bytesTotal > 512 * 1024) throw Error("Release exceeds the extension size budget");
const central = Buffer.concat(directory), end = Buffer.alloc(22);
end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10);
end.writeUInt32LE(central.length, 12); end.writeUInt32LE(offset, 16);
const archive = Buffer.concat([...chunks, central, end]);
const hash = createHash("sha256").update(archive).digest("hex");
const destination = resolve(root, "release"), name = `savemycontext-${pkg.version}.zip`;
await mkdir(destination, { recursive: true });
await writeFile(resolve(destination, name), archive);
await writeFile(resolve(destination, `${name}.sha256`), `${hash}  ${name}\n`);
console.log(`${name}: ${files.length} files, ${archive.length} bytes, sha256 ${hash}`);
