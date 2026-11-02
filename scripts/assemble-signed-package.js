"use strict";
// Reassemble already signed bytes. This script cannot create a signature.
const fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto"), assert = require("node:assert/strict");
const hash = data => crypto.createHash("sha256").update(data).digest("hex");
function assemble(root = path.resolve(__dirname, "..")) {
  const project = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  const version = JSON.parse(fs.readFileSync(path.join(root, "plugin/manifest.json"), "utf8")).version;
  const asset = `${project.name}-${version}.kaiplugin`, dist = path.join(root, "dist"), metadata = path.join(dist, asset + ".parts.json");
  const detached = path.join(dist, asset + ".signature.json");
  if (fs.existsSync(detached)) return assembleSource(root, asset, detached);
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
function assembleSource(root, asset, detached) {
  const { verifyPackage, safeFile, BINARY, MAX_BYTES } = require("./package-format-v3");
  assert.ok(fs.lstatSync(detached).isFile() && !fs.lstatSync(detached).isSymbolicLink() && fs.statSync(detached).size < 4096, "Invalid signature metadata");
  const record = JSON.parse(fs.readFileSync(detached, "utf8"));
  assert.equal(Object.keys(record).sort().join(), "asset,bytes,format,publicKey,sha256,signature");
  assert.equal(record.format, 1); assert.equal(record.asset, asset);
  assert.ok(Number.isSafeInteger(record.bytes) && record.bytes > 0 && record.bytes <= MAX_BYTES);
  assert.match(record.sha256, /^[a-f0-9]{64}$/);
  const publisher = JSON.parse(fs.readFileSync(path.join(root, "publisher.json"), "utf8"));
  assert.equal(record.publicKey, publisher.publicKey, "Unexpected publisher");
  const source = path.join(root, "plugin"), files = {}; let bytes = 0;
  function walk(dir, prefix = "") {
    // Code-point ordering preserves identical bytes on every build platform.
    for (const name of fs.readdirSync(dir).sort()) {
      const file = path.join(dir, name), relative = prefix + name, stat = fs.lstatSync(file);
      assert.ok(!stat.isSymbolicLink(), "No package symlinks");
      if (stat.isDirectory()) { walk(file, relative + "/"); continue; }
      if (relative === "manifest.json") continue;
      assert.ok(stat.isFile() && safeFile(relative), "Invalid package source");
      bytes += stat.size; assert.ok(bytes <= MAX_BYTES, "Package source exceeds size limit");
      files[relative] = fs.readFileSync(file).toString(BINARY.test(relative) ? "base64" : "utf8");
    }
  }
  walk(source);
  const manifest = JSON.parse(fs.readFileSync(path.join(source, "manifest.json"), "utf8"));
  const verified = verifyPackage({ manifest, files, publicKey: record.publicKey, signature: record.signature });
  assert.equal(verified.fingerprint, publisher.fingerprint, "Unexpected publisher fingerprint");
  const data = Buffer.from(JSON.stringify(verified.package));
  assert.equal(data.length, record.bytes, "Signed asset size differs");
  assert.equal(hash(data), record.sha256, "Signed asset hash differs");
  const target = path.join(root, "dist", asset);
  if (fs.existsSync(target)) {
    const stat = fs.lstatSync(target);
    assert.ok(stat.isFile() && !stat.isSymbolicLink() && stat.size === data.length && hash(fs.readFileSync(target)) === record.sha256, "Existing output differs; refusing to replace it");
  } else fs.writeFileSync(target, data, { flag: "wx", mode: 0o644 });
  return { asset, bytes: data.length, sha256: record.sha256, assembly: "verified-source-and-publisher-signature" };
}
if (require.main === module) console.log(JSON.stringify(assemble()));
module.exports = { assemble };
