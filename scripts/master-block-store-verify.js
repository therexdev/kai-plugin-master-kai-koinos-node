"use strict";
const fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto");
const { verifyBundle, SOURCE_NAMES, defaultBundle } = require("../plugin/service/core/lib/koinos/block-store-runtime");
const { GO_VERSION } = require("./master-block-store-build");
function verifySource(root = defaultBundle()) {
  const expected = [...Object.values(SOURCE_NAMES), "manifest.json"].sort();
  const actual = fs.readdirSync(root).sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw Error("Unexpected block-store runtime files. Ship only the compressed runtime, wrapper, license and manifest: " + expected.join(", "));
  }
  const manifest = verifyBundle(root);
  const patch = fs.readFileSync(path.join(__dirname, "../patches/koinos-block-store/missing-record.patch"));
  if (manifest.goVersion !== GO_VERSION || manifest.patchSha256 !== crypto.createHash("sha256").update(patch).digest("hex")) {
    throw Error("Bundled block-store runtime does not match the pinned compiler and checked-in history safety patch.");
  }
  return manifest;
}
if (require.main === module) {
  const manifest = verifySource(path.resolve(process.argv[2] || defaultBundle()));
  console.log(`Verified ${manifest.version} runtime, exact file set, checksums and source patch.`);
}
module.exports = { verifySource };
