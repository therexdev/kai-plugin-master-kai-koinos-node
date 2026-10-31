"use strict";
// Verification only: packaged JavaScript/native binaries are never executed.
const fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto"), assert = require("node:assert/strict");
const { signingPayload, verifyPackage, safeFile, BINARY, MAX_BYTES } = require("./package-format-v3");
const root = path.resolve(__dirname, ".."), source = path.join(root, "plugin");
// Do not sign or release an obsolete uncompressed runtime alongside the gzip.
require("./master-block-store-verify").verifySource(path.join(source, "service/core/node-runtime"));
const manifest = JSON.parse(fs.readFileSync(path.join(source, "manifest.json"), "utf8"));
const project = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const publisher = JSON.parse(fs.readFileSync(path.join(root, "publisher.json"), "utf8"));
const provenance = require("./package-format-v3.provenance.json");
assert.equal(crypto.createHash("sha256").update(fs.readFileSync(path.join(__dirname, "package-format-v3.js"))).digest("hex"), provenance.sha256, "Vendored verifier differs from recorded Core snapshot");
assert.equal(manifest.id, publisher.id); assert.equal(manifest.version, project.version);
const publisherKey = crypto.createPublicKey({ key: Buffer.from(publisher.publicKey, "base64"), format: "der", type: "spki" });
assert.equal(publisherKey.asymmetricKeyType, "ed25519");
assert.equal(crypto.createHash("sha256").update(publisherKey.export({ format: "der", type: "spki" })).digest("hex"), publisher.fingerprint);
const files = {};
function walk(directory, prefix = "") {
  for (const item of fs.readdirSync(directory, { withFileTypes: true })) {
    const relative = prefix + item.name;
    if (!prefix && relative === "manifest.json") continue;
    assert.ok(!item.isSymbolicLink(), `No package symlinks: ${relative}`);
    if (item.isDirectory()) { walk(path.join(directory, item.name), relative + "/"); continue; }
    assert.ok(item.isFile(), `Only regular package files: ${relative}`);
    assert.ok(safeFile(relative), `Unsupported package path: ${relative}`);
    files[relative] = fs.readFileSync(path.join(directory, item.name)).toString(BINARY.test(relative) ? "base64" : "utf8");
  }
}
walk(source);
if (process.argv.includes("--source")) {
  // A throwaway in-memory signature exercises the exact format verifier. It is
  // never saved and is not a publisher signature or a release authorization.
  const pair = crypto.generateKeyPairSync("ed25519");
  verifyPackage({ manifest, files, publicKey: pair.publicKey.export({ format: "der", type: "spki" }).toString("base64"), signature: crypto.sign(null, Buffer.from(signingPayload(manifest, files)), pair.privateKey).toString("base64") });
  console.log(`Validated source ${manifest.id}@${manifest.version}: ${Object.keys(files).length} files. Publisher release signature not checked in source-only mode.`);
} else {
  const file = path.join(root, "dist", `${project.name}-${manifest.version}.kaiplugin`);
  const stat = fs.lstatSync(file); assert.ok(stat.isFile() && !stat.isSymbolicLink() && stat.size <= MAX_BYTES, "Invalid release package");
  const verified = verifyPackage(fs.readFileSync(file, "utf8"));
  assert.deepEqual(verified.manifest, manifest, "Signed manifest differs from source");
  assert.equal(verified.fingerprint, publisher.fingerprint, "Unexpected release publisher");
  assert.equal(verified.package.publicKey, publisher.publicKey, "Unexpected publisher public key");
  assert.deepEqual(verified.package.files, files, "Signed package differs from source, assets or bundled dependencies");
  console.log(`Verified publisher signature and exact contents for ${manifest.id}@${manifest.version}: ${Object.keys(files).length} files.`);
}
