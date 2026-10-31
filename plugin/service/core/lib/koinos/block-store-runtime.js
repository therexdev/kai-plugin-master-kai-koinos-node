"use strict";
const fs = require("fs"), path = require("path"), crypto = require("crypto"), zlib = require("zlib");
const PATCH = "missing-record-v1";
const VERSION = `2bb94558-kai-${PATCH}`;
const UPSTREAM = "2bb94558df61c71eb241002635444cdddce0843c";
const FILES = Object.freeze(["koinos_block_store", "start.sh", "LICENSE.md"]);
// Signed plugin packages require recognized file extensions. These names affect
// transport only: the upstream manifest and staged Docker names stay unchanged.
const SOURCE_NAMES = Object.freeze({ "koinos_block_store": "koinos_block_store.gz.bin", "start.sh": "start.sh.txt", "LICENSE.md": "LICENSE.md" });
const RUNTIME_BYTES = 14901408;
const MAX_COMPRESSED_BYTES = 8 * 1024 * 1024;
const { writeGeneratedFile, ensureGeneratedDirectory } = require("./generated-config");

// Runtime assets belong to this plugin's signed immutable code closure.
function defaultBundle() { return path.resolve(__dirname, "../../node-runtime"); }
function checkedFile(root, name, maxBytes) {
  const file = path.join(root, name), stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size <= 0 || stat.size > maxBytes) throw new Error(`Invalid block-store runtime file: ${name}. Reinstall Master KAI Koinos Node.`);
  return file;
}
function loadBundle(root, { required = true, layout = "packaged" } = {}) {
  if (layout !== "packaged" && layout !== "staged") throw new Error("Invalid block-store runtime layout");
  if (!required && !fs.existsSync(path.join(root, "manifest.json"))) return null;
  const manifestBytes = fs.readFileSync(checkedFile(root, "manifest.json", 1024 * 1024));
  const manifest = JSON.parse(manifestBytes.toString("utf8"));
  if (manifest.schemaVersion !== 1 || manifest.patch !== PATCH || manifest.version !== VERSION ||
      manifest.upstreamCommit !== UPSTREAM || manifest.platform !== "linux/amd64" ||
      !Array.isArray(manifest.files) || manifest.files.length !== FILES.length || new Set(manifest.files.map(file => file.name)).size !== FILES.length) throw new Error("Invalid block-store runtime manifest. Reinstall Master KAI Koinos Node.");
  const files = new Map([["manifest.json", manifestBytes]]);
  for (const name of FILES) {
    const record = manifest.files.find(file => file.name === name);
    const sourceName = layout === "packaged" ? SOURCE_NAMES[name] : name;
    const binary = name === "koinos_block_store", compressed = binary && layout === "packaged";
    let bytes = fs.readFileSync(checkedFile(root, sourceName, compressed ? MAX_COMPRESSED_BYTES : binary ? RUNTIME_BYTES : 1024 * 1024));
    if (compressed) {
      try { bytes = zlib.gunzipSync(bytes, { maxOutputLength: RUNTIME_BYTES }); }
      catch { throw new Error("Invalid compressed block-store runtime. Reinstall Master KAI Koinos Node."); }
    }
    if (binary && bytes.length !== RUNTIME_BYTES) throw new Error("Invalid block-store runtime size. Reinstall Master KAI Koinos Node.");
    const hash = crypto.createHash("sha256").update(bytes).digest("hex");
    if (!record || record.sha256 !== hash) throw new Error(`Block-store runtime checksum failed: ${name}. Reinstall Master KAI Koinos Node.`);
    files.set(name, bytes);
  }
  return { manifest, files };
}
function verifyBundle(root, options) {
  return loadBundle(root, options)?.manifest || null;
}
function stageRuntime(root, nodeRoot, { required = true } = {}) {
  const bundle = loadBundle(root, { required });
  if (!bundle) return false; // Source checkout: build the runtime before using the patched service.
  const target = path.join(nodeRoot, "block-store-runtime");
  ensureGeneratedDirectory(target);
  for (const [name, bytes] of bundle.files) writeGeneratedFile(bytes, path.join(target, name));
  verifyBundle(target, { layout: "staged" });
  return true;
}
function patchedCompose(source) {
  // Windows checkouts can package CRLF templates. Normalize before matching
  // service boundaries; line endings do not change the Compose configuration.
  source = String(source).replace(/\r\n?/g, "\n");
  const original = "   block_store:\n      image: koinos/koinos-block-store:${BLOCK_STORE_TAG:-latest}\n";
  if (!source.includes(original)) throw new Error("Unexpected block-store Compose template");
  const start = source.indexOf(original), end = source.indexOf("\n   p2p:", start);
  if (end < 0) throw new Error("Missing Compose service boundary");
  let service = source.slice(start, end).replace(original, original +
    `      entrypoint: ["/bin/sh", "/kai-block-store/start.sh"]\n      labels:\n         io.koinosai.block-store.patch: ${PATCH}\n`);
  service = service.replace("      volumes:\n", "      volumes:\n         - \"./block-store-runtime:/kai-block-store:ro\"\n");
  return source.slice(0, start) + service + source.slice(end);
}
module.exports = { PATCH, VERSION, UPSTREAM, FILES, SOURCE_NAMES, RUNTIME_BYTES, MAX_COMPRESSED_BYTES, defaultBundle, verifyBundle, stageRuntime, patchedCompose };
