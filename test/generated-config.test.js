"use strict";
const { test } = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path"), os = require("node:os");
const { NodeManager } = require("../plugin/service/core/lib/koinos/node-manager");
const { copyGeneratedFile, ensureGeneratedDirectory } = require("../plugin/service/core/lib/koinos/generated-config");
function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "kai-public-config-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
const readonly = file => !(fs.statSync(file).mode & 0o200);

test("immutable package copies reproduce the original Windows overwrite failure", t => {
  const root = fixture(t), source = path.join(root, "immutable.pb"), destination = path.join(root, "old-copy.pb");
  fs.writeFileSync(source, Buffer.from([0, 255, 42, 0, 9])); fs.chmodSync(source, 0o400);
  fs.copyFileSync(source, destination);
  assert.equal(readonly(source), true); assert.equal(readonly(destination), true, "copyFile inherits the package's readonly mode");
  if (process.platform === "win32") assert.throws(() => fs.copyFileSync(source, destination), error => ["EPERM", "EACCES"].includes(error.code));
  copyGeneratedFile(source, destination); copyGeneratedFile(source, destination);
  assert.deepEqual(fs.readFileSync(destination), fs.readFileSync(source)); assert.equal(readonly(destination), false); assert.equal(readonly(source), true);
  assert.equal(fs.statSync(destination).mode & 0o444, 0o444, "Public config remains readable by Docker service UIDs");
});

test("repeated node setup repairs all old readonly templates and macOS mirrors without touching chain or keys", t => {
  const root = fixture(t), templateRoot = path.join(root, "installed-code"), dataRoot = path.join(root, "node");
  fs.cpSync(path.resolve(__dirname, "../plugin/service/core/koinos-node-template"), templateRoot, { recursive: true });
  const sources = ["common/koinos_descriptors.pb", "common/rabbitmq.conf", "mainnet/genesis_data.json"];
  const snapshots = new Map(sources.map(name => { const file = path.join(templateRoot, name), bytes = fs.readFileSync(file); fs.chmodSync(file, 0o400); return [name, bytes]; }));
  const manager = new NodeManager({ templateRoot, dataRoot, platform: "darwin", autoRecover: false }); t.after(() => manager.dispose());
  const d = manager.ensureFiles("mainnet", null);
  const generated = ["config/koinos_descriptors.pb", "config/rabbitmq.conf", "config/genesis_data.json", "basedir/config.yml", "basedir/chain/genesis_data.json", "basedir/jsonrpc/descriptors/koinos_descriptors.pb"];
  const expected = new Map(generated.map(name => { const file = path.join(d.root, name), bytes = fs.readFileSync(file); assert.equal(readonly(file), false); fs.chmodSync(file, 0o400); return [name, bytes]; }));
  const retained = ["basedir/chain/database.sst", "basedir/block_producer/private.key", "config/custom.yml", "wallet/wallet.json", ".profile-migrations/mainnet.json"];
  for (const name of retained) { const file = path.join(d.root, name); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, "keep: " + name); }
  manager.ensureFiles("mainnet", null); manager.ensureFiles("mainnet", null);
  for (const [name, bytes] of expected) { const file = path.join(d.root, name); assert.deepEqual(fs.readFileSync(file), bytes); assert.equal(readonly(file), false); assert.equal(fs.statSync(file).mode & 0o444, 0o444); }
  for (const [name, bytes] of snapshots) { const file = path.join(templateRoot, name); assert.deepEqual(fs.readFileSync(file), bytes); assert.equal(readonly(file), true); }
  for (const name of retained) assert.equal(fs.readFileSync(path.join(d.root, name), "utf8"), "keep: " + name);
});

test("a failed config replacement retains the old bytes and readonly mode", t => {
  const root = fixture(t), source = path.join(root, "source"), target = path.join(root, "target");
  fs.writeFileSync(source, "new bytes"); fs.writeFileSync(target, "old bytes"); fs.chmodSync(target, 0o400);
  const rename = fs.renameSync; let injected = false;
  fs.renameSync = (from, to) => { if (path.relative(target, String(to)) === "") { injected = true; throw Object.assign(Error("File locked"), { code: "EPERM" }); } return rename(from, to); };
  try { assert.throws(() => copyGeneratedFile(source, target), /File locked/); } finally { fs.renameSync = rename; }
  assert.equal(injected, true); assert.equal(fs.readFileSync(target, "utf8"), "old bytes"); assert.equal(readonly(target), true);
  assert.deepEqual(fs.readdirSync(root).sort(), ["source", "target"]);
  assert.throws(() => copyGeneratedFile(path.join(root, "missing"), target), /ENOENT/); assert.equal(fs.readFileSync(target, "utf8"), "old bytes"); assert.equal(readonly(target), true);
});

test("config repair refuses linked files and linked parent directories without chmod or traversal", t => {
  const root = fixture(t), source = path.join(root, "source"), outside = path.join(root, "outside"), linked = path.join(root, "linked");
  fs.writeFileSync(source, "new"); fs.writeFileSync(outside, "keep"); fs.chmodSync(outside, 0o400); fs.linkSync(outside, linked);
  assert.throws(() => copyGeneratedFile(source, linked), /linked or invalid/); assert.equal(fs.readFileSync(outside, "utf8"), "keep"); assert.equal(readonly(outside), true);
  const folder = path.join(root, "outside-folder"), alias = path.join(root, "alias"); fs.mkdirSync(folder); fs.symlinkSync(folder, alias, "junction");
  assert.throws(() => ensureGeneratedDirectory(path.join(alias, "new-folder")), /unsafe parent/); assert.equal(fs.existsSync(path.join(folder, "new-folder")), false);
  assert.throws(() => copyGeneratedFile(source, path.join(alias, "new-file")), /unsafe parent/); assert.equal(fs.existsSync(path.join(folder, "new-file")), false);
});
