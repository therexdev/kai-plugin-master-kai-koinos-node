"use strict";
const { test } = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path"), crypto = require("node:crypto"), zlib = require("node:zlib");
const { NodeManager, buildEnv } = require("../plugin/service/core/lib/koinos/node-manager");
const { NETWORKS } = require("../plugin/service/core/lib/koinos/constants");
const runtime = require("../plugin/service/core/lib/koinos/block-store-runtime");
const templateRoot = path.resolve(__dirname, "../plugin/service/core/koinos-node-template");

function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "kai-master-runtime-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const bundle = path.join(root, "bundle"); fs.mkdirSync(bundle);
  const files = runtime.FILES.map(name => {
    const binary = name === "koinos_block_store", bytes = binary ? Buffer.alloc(runtime.RUNTIME_BYTES, 0x61) : Buffer.from(`fixture-${name}`);
    fs.writeFileSync(path.join(bundle, runtime.SOURCE_NAMES[name]), binary ? zlib.gzipSync(bytes) : bytes);
    return { name, sha256: crypto.createHash("sha256").update(bytes).digest("hex") };
  });
  fs.writeFileSync(path.join(bundle, "manifest.json"), JSON.stringify({ schemaVersion: 1, patch: runtime.PATCH, version: runtime.VERSION, upstreamCommit: runtime.UPSTREAM, platform: "linux/amd64", files }));
  return { root, bundle };
}

test("optional indexes stay off by default and enable only the requested Compose profiles", () => {
  const profiles = (producing, history, api) => buildEnv(NETWORKS.mainnet, "C:/node/basedir", producing, false, history, api).split("\n").find(line => line.startsWith("COMPOSE_PROFILES="));
  assert.equal(profiles(false, false, false), "COMPOSE_PROFILES=jsonrpc");
  assert.equal(profiles(true, true, false), "COMPOSE_PROFILES=jsonrpc,block_producer,account_history");
  assert.equal(profiles(true, false, true), "COMPOSE_PROFILES=jsonrpc,block_producer,account_history,transaction_store,contract_meta_store");
});

test("patching preserves every other Compose service and supports Windows line endings", () => {
  const source = fs.readFileSync(path.join(templateRoot, "docker-compose.yml"), "utf8").replace(/\r\n?/g, "\n");
  const patched = runtime.patchedCompose(source);
  assert.equal(runtime.patchedCompose(source.replace(/\n/g, "\r\n")), patched);
  const stripPatch = value => value.replace('      entrypoint: ["/bin/sh", "/kai-block-store/start.sh"]\n      labels:\n         io.koinosai.block-store.patch: missing-record-v1\n', "").replace('         - "./block-store-runtime:/kai-block-store:ro"\n', "");
  assert.equal(stripPatch(patched), source);
  assert.throws(() => runtime.patchedCompose(source.replace("   block_store:", "   other:")), /Unexpected block-store/);
});

test("repeated mainnet preparation stages writable verified runtime without changing chain or wallet data", t => {
  const { root, bundle } = fixture(t);
  for (const name of [...Object.values(runtime.SOURCE_NAMES), "manifest.json"]) fs.chmodSync(path.join(bundle, name), 0o400);
  const manager = new NodeManager({ templateRoot, dataRoot: path.join(root, "data"), runtimeBundle: bundle, apiServices: true, platform: "win32" });
  t.after(() => manager.dispose());
  const d = manager.ensureFiles("mainnet", null);
  const retained = ["basedir/chain/database.sst", "basedir/block_producer/private.key", "wallet/wallet.json"];
  for (const name of retained) { const file = path.join(d.root, name); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, `keep:${name}`); }
  const staged = path.join(d.root, "block-store-runtime");
  for (const name of [...runtime.FILES, "manifest.json"]) fs.chmodSync(path.join(staged, name), 0o400);
  manager.ensureFiles("mainnet", null);
  assert.equal(runtime.verifyBundle(staged, { layout: "staged" }).patch, runtime.PATCH);
  assert.deepEqual(fs.readFileSync(path.join(staged, "manifest.json")), fs.readFileSync(path.join(bundle, "manifest.json")));
  for (const name of [...runtime.FILES, "manifest.json"]) { assert.ok(fs.statSync(path.join(staged, name)).mode & 0o200); assert.equal(fs.statSync(path.join(bundle, runtime.SOURCE_NAMES[name] || name)).mode & 0o200, 0); }
  for (const name of retained) assert.equal(fs.readFileSync(path.join(d.root, name), "utf8"), `keep:${name}`);
  assert.match(fs.readFileSync(path.join(d.root, "docker-compose.yml"), "utf8"), /missing-record-v1/);
  assert.match(fs.readFileSync(path.join(d.root, ".env"), "utf8"), /COMPOSE_PROFILES=jsonrpc,account_history,transaction_store,contract_meta_store/);
  assert.match(fs.readFileSync(path.join(d.config, "config.yml"), "utf8"), /verify-blocks: true/);
  manager.ensureFiles("harbinger", null);
  assert.doesNotMatch(fs.readFileSync(path.join(manager.dirs("harbinger").root, "docker-compose.yml"), "utf8"), /kai-block-store/);
});

test("missing or modified runtime refuses mainnet preparation instead of silently using unpatched code", t => {
  const { root, bundle } = fixture(t);
  const manager = new NodeManager({ templateRoot, dataRoot: path.join(root, "data"), runtimeBundle: path.join(root, "missing") });
  t.after(() => manager.dispose());
  assert.throws(() => manager.ensureFiles("mainnet", null), /ENOENT/);
  manager.runtimeBundle = bundle;
  fs.writeFileSync(path.join(bundle, runtime.SOURCE_NAMES.koinos_block_store), zlib.gzipSync(Buffer.alloc(runtime.RUNTIME_BYTES, 0x62)));
  assert.throws(() => manager.ensureFiles("mainnet", null), /checksum failed/);
  assert.equal(fs.existsSync(path.join(manager.dirs("mainnet").root, "docker-compose.yml")), false);
});

test("packaged filenames are explicit and cannot fall back to unverified original filenames", t => {
  const { root, bundle } = fixture(t), nodeRoot = path.join(root, "node");
  assert.equal(runtime.verifyBundle(bundle).version, runtime.VERSION);
  assert.throws(() => runtime.verifyBundle(bundle, { layout: "auto" }), /Invalid.*layout/);
  runtime.stageRuntime(bundle, nodeRoot);
  const staged = path.join(nodeRoot, "block-store-runtime");
  assert.equal(runtime.verifyBundle(staged, { layout: "staged" }).version, runtime.VERSION);
  assert.throws(() => runtime.verifyBundle(staged), /ENOENT/);
  for (const name of runtime.FILES) {
    const source = fs.readFileSync(path.join(bundle, runtime.SOURCE_NAMES[name]));
    assert.deepEqual(name === "koinos_block_store" ? zlib.gunzipSync(source) : source, fs.readFileSync(path.join(staged, name)));
  }
  fs.renameSync(path.join(bundle, runtime.SOURCE_NAMES.koinos_block_store), path.join(bundle, "koinos_block_store"));
  assert.throws(() => runtime.stageRuntime(bundle, nodeRoot), /ENOENT/);
});

test("compressed runtime rejects invalid streams and size overruns before staging any files", t => {
  const { root, bundle } = fixture(t), nodeRoot = path.join(root, "node");
  const binary = path.join(bundle, runtime.SOURCE_NAMES.koinos_block_store);
  for (const invalid of [Buffer.from("not gzip"), zlib.gzipSync(Buffer.alloc(runtime.RUNTIME_BYTES + 1))]) {
    fs.writeFileSync(binary, invalid);
    assert.throws(() => runtime.stageRuntime(bundle, nodeRoot), /Invalid compressed block-store runtime/);
    assert.equal(fs.existsSync(nodeRoot), false);
  }
  fs.writeFileSync(binary, zlib.gzipSync(Buffer.alloc(runtime.RUNTIME_BYTES - 1)));
  assert.throws(() => runtime.stageRuntime(bundle, nodeRoot), /Invalid block-store runtime size/);
  fs.writeFileSync(binary, Buffer.alloc(runtime.MAX_COMPRESSED_BYTES + 1));
  assert.throws(() => runtime.stageRuntime(bundle, nodeRoot), /Invalid block-store runtime file/);
  assert.equal(fs.existsSync(nodeRoot), false);
});

test("runtime transport compression has deterministic headers and preserves executable bytes", () => {
  const { compressBinary } = require("../scripts/master-block-store-build");
  const bytes = Buffer.alloc(runtime.RUNTIME_BYTES, 0x61), a = compressBinary(bytes), b = compressBinary(bytes);
  assert.deepEqual(a, b);
  assert.equal(a.readUInt32LE(4), 0);
  assert.equal(a[9], 255);
  assert.deepEqual(zlib.gunzipSync(a, { maxOutputLength: runtime.RUNTIME_BYTES }), bytes);
  assert.throws(() => compressBinary(Buffer.from("wrong size")), /size differs/);
});

test("runtime staging refuses linked destinations without changing their targets", t => {
  const { root, bundle } = fixture(t), nodeRoot = path.join(root, "node"), outside = path.join(root, "outside");
  fs.mkdirSync(nodeRoot); fs.mkdirSync(outside); fs.writeFileSync(path.join(outside, "keep"), "preserve");
  fs.symlinkSync(outside, path.join(nodeRoot, "block-store-runtime"), "junction");
  assert.throws(() => runtime.stageRuntime(bundle, nodeRoot), /unsafe parent/);
  assert.deepEqual(fs.readdirSync(outside), ["keep"]);
  fs.unlinkSync(path.join(nodeRoot, "block-store-runtime")); fs.mkdirSync(path.join(nodeRoot, "block-store-runtime"));
  const original = path.join(outside, "executable"); fs.writeFileSync(original, "preserve");
  fs.linkSync(original, path.join(nodeRoot, "block-store-runtime", "koinos_block_store"));
  assert.throws(() => runtime.stageRuntime(bundle, nodeRoot), /linked or invalid/);
  assert.equal(fs.readFileSync(original, "utf8"), "preserve");
});

test("Master runtime keeps the existing ownership, migration and operation-lifetime gates", async t => {
  const { root, bundle } = fixture(t), manager = new NodeManager({ templateRoot, dataRoot: path.join(root, "data"), runtimeBundle: bundle });
  t.after(() => manager.dispose());
  manager._profileMigrationActive = true;
  await assert.rejects(manager._assertControl("mainnet"), /migration/);
  manager._profileMigrationActive = false; manager._disposed = true;
  await assert.rejects(manager._assertControl("mainnet"), /closed/);
  manager._disposed = false;
  let invoked = false;
  manager.composeCmd = async () => ({ bin: "docker", pre: ["compose"] });
  manager._assertControl = async () => {};
  manager.assertOperation = () => { throw Error("Plugin operation cancelled"); };
  manager._exec = async () => { invoked = true; };
  await assert.rejects(manager._compose("mainnet", ["up", "-d"]), /cancelled/);
  assert.equal(invoked, false);
});

test("history check is read-only, requires the safety patch, and cannot certify complete history", async () => {
  const { checkHistory } = require("../plugin/service/core/lib/koinos/history-check");
  const calls = [], commands = [];
  const nodeMgr = { _compose: async (...args) => { commands.push(args); return { ok: true, stdout: `Koinos Block Store v1.1.0 (${runtime.VERSION})` }; }, logs: async () => "Sync progress - Height: 2346000" };
  const call = async (method, params) => {
    calls.push({ method, params });
    if (method === "chain.get_chain_id") return { chain_id: "EiBZK_GGVP0H_fXVAM3j6EAuz3-B-l3ejxRSewi7qIBfSA==" };
    if (method === "chain.get_head_info") return { head_topology: { height: "39544000", id: "head" }, last_irreversible_block: "39543940", head_block_time: Date.now() };
    const height = params.ancestor_start_height;
    return { block_items: [{ block_height: height, block_id: `block${height}`, block: { id: `block${height}`, header: { height } }, receipt: { id: `block${height}` } }] };
  };
  const result = await checkHistory({ nodeMgr, call });
  assert.equal(result.samplesAvailable, true); assert.equal(result.complete, false); assert.ok(result.samples.length <= 8);
  assert.deepEqual(commands[0][1], ["exec", "-T", "block_store", "/tmp/kai_koinos_block_store", "--version"]);
  const before = calls.length; nodeMgr._compose = async () => ({ ok: false, stdout: "unpatched" });
  await assert.rejects(checkHistory({ nodeMgr, call }), /patch is not running/); assert.equal(calls.length, before);
});
