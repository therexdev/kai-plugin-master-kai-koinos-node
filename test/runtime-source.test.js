"use strict";
const { test } = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const { verifySource } = require("../scripts/master-block-store-verify");
const { SOURCE_NAMES } = require("../plugin/service/core/lib/koinos/block-store-runtime");

test("release runtime source contains only the compressed verified bundle", () => {
  assert.equal(verifySource().patch, "missing-record-v1");
});

test("source verification rejects an obsolete uncompressed runtime before reading payloads", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kai-runtime-source-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const name of [...Object.values(SOURCE_NAMES), "manifest.json", "koinos_block_store.bin"]) fs.writeFileSync(path.join(root, name), "fixture");
  assert.throws(() => verifySource(root), /Unexpected block-store runtime files/);
});
