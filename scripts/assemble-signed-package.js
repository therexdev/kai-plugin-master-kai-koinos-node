"use strict";
// Reassemble already signed bytes. This script cannot create a signature.
const fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto"), assert = require("node:assert/strict");
const hash = data => crypto.createHash("sha256").update(data).digest("hex");
function assemble(root = path.resolve(__dirname, "..")) {
  const project = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  const version = JSON.parse(fs.readFileSync(path.join(root, "plugin/manifest.json"), "utf8")).version;
  const asset = `${project.name}-${version}.kaiplugin`, dist = path.join(root, "dist"), metadata = path.join(dist, asset + ".parts.json");
  if (!fs.existsSync(metadata)) return { skipped: true, asset };
  assert.ok(fs.lstatSync(metadata).isFile() && !fs.lstatSync(metadata).isSymbolicLink(), "Invalid parts metadata");
  const manifest = JSON.parse(fs.readFileSync(metadata, "utf8"));
  assert.equal(manifest.format, 1); assert.equal(manifest.asset, asset);
  assert.ok(Number.isSafeInteger(manifest.bytes) && manifest.bytes > 0 && manifest.bytes <= 512 * 1024 * 1024, "Invalid asset size");
  assert.match(manifest.sha256, /^[a-f0-9]{64}$/);
  assert.ok(Array.isArray(manifest.parts) && manifest.parts.length > 0 && manifest.parts.length <= 128, "Invalid parts list");
  const parts = []; let bytes = 0;
  for (const [index, part] of manifest.parts.entries()) {
    assert.equal(part.file, asset + ".part" + String(index + 1).padStart(3, "0"), "Unexpected part path or order");
    assert.ok(Number.isSafeInteger(part.bytes) && part.bytes > 0 && part.bytes <= 8 * 1024 * 1024, "Invalid part size");
    assert.match(part.sha256, /^[a-f0-9]{64}$/);
    const file = path.join(dist, part.file), stat = fs.lstatSync(file);
    assert.ok(stat.isFile() && !stat.isSymbolicLink() && stat.size === part.bytes, "Invalid part file");
    const data = fs.readFileSync(file); assert.equal(hash(data), part.sha256, "Signed asset part hash differs");
    bytes += data.length; assert.ok(bytes <= manifest.bytes, "Parts exceed asset size"); parts.push(data);
  }
  assert.equal(bytes, manifest.bytes, "Incomplete signed asset");
  const data = Buffer.concat(parts); assert.equal(hash(data), manifest.sha256, "Signed asset hash differs");
  const target = path.join(dist, asset);
  if (fs.existsSync(target)) {
    const stat = fs.lstatSync(target); assert.ok(stat.isFile() && !stat.isSymbolicLink(), "Invalid output file");
    assert.ok(stat.size === data.length && hash(fs.readFileSync(target)) === manifest.sha256, "Existing output differs; refusing to replace it");
  } else {
    // Exclusive output creation avoids replacing any concurrently supplied asset.
    fs.writeFileSync(target, data, { flag: "wx", mode: 0o644 });
  }
  return { asset, bytes, sha256: manifest.sha256, parts: parts.length };
}
if (require.main === module) console.log(JSON.stringify(assemble()));
module.exports = { assemble };
