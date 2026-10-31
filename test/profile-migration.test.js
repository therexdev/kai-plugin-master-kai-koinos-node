"use strict";
const { test } = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), fsp = require("node:fs/promises"), path = require("node:path"), os = require("node:os");
const { NodeManager } = require("../plugin/service/core/lib/koinos/node-manager");
const { createProfileMigration, MARKER } = require("../plugin/service/core/lib/koinos/profile-migration");
const { assertRestoreReady } = require("../plugin/service/core/lib/koinos/node-maintenance");
const { NETWORKS } = require("../plugin/service/core/lib/koinos/constants");
const ok = stdout => ({ ok: true, stdout: stdout || "", stderr: "" });
function inside(directory, file, paths = path) {
  // Windows Docker paths may use different drive-letter/path casing after the
  // migration resolves them. Match path components rather than raw prefixes.
  const relative = paths.relative(directory, String(file));
  return relative !== "" && relative !== ".." && !relative.startsWith(".." + paths.sep) && !paths.isAbsolute(relative);
}
function fixture(t, options = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "kai-chain-migration-"))), source = path.join(root, "old", "Master Koinos AI Node", "core", "koinos-node", "node", "mainnet"), dataRoot = path.join(root, "plugin", "node"), target = path.join(dataRoot, "mainnet"), basedir = path.join(source, "basedir");
  const templateRoot = path.resolve(__dirname, "../plugin/service/core/koinos-node-template");
  const write = (file, data) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, data); };
  write(path.join(source, "config/genesis_data.json"), fs.readFileSync(path.join(templateRoot, "mainnet/genesis_data.json")));
  write(path.join(source, "config/config.yml"), "producer: existing-wallet\n"); write(path.join(source, ".env"), "OLD_CONFIG=kept\n");
  write(path.join(basedir, "chain/0001.sst"), Buffer.alloc(options.bytes || 128, 1)); write(path.join(basedir, "chain/CURRENT"), "MANIFEST-0001"); write(path.join(basedir, "block_store/blocks.sst"), Buffer.alloc(256, 2));
  write(path.join(basedir, "block_producer/private.key"), "private producer key remains old"); write(path.join(root, "old/wallet/wallet.json"), "original encrypted wallet remains old");
  let rows = ["chain", "block_store"].map((service, index) => ({ id: String(index + 1).repeat(64), project: NETWORKS.mainnet.composeProject, root: source, service, image: "koinos/koinos-" + service.replaceAll("_", "-") + ":latest", running: true, paused: false, mounts: [{ Type: "bind", Source: basedir, Destination: "/koinos", RW: true }] }));
  const calls = []; let claimed = false, afterExec;
  const exec = async (bin, args) => {
    calls.push(args); if (afterExec) await afterExec(args);
    if (args[0] === "context") return ok(JSON.stringify(options.endpoint || "unix:///var/run/docker.sock"));
    if (args[0] === "ps") return ok(rows.map(row => row.id.slice(0, 12)).join("\n"));
    if (args[0] === "inspect") return ok(rows.map(row => JSON.stringify(row)).join("\n"));
    if (args[0] === "update") return options.failUpdate ? { ok: false, stdout: "" } : ok();
    if (args[0] === "stop") { if (!options.refuseStop) rows.forEach(row => { row.running = false; }); return ok(); }
    if (args[0] === "rm") { rows = rows.filter(row => !args.includes(row.id)); return ok(); }
    throw Error("Unexpected Docker command " + args.join(" "));
  };
  const manager = new NodeManager({ templateRoot, dataRoot, autoRecover: false, lockRoot: path.join(root, "locks") });
  const make = () => createProfileMigration({ manager }, { exec, claim: () => { if (options.locked) throw Error("Another KAI app is managing this node"); assert.equal(claimed, false); claimed = true; return () => { claimed = false; }; } });
  const service = make();
  t.after(async () => { await service.dispose(); manager.dispose(); fs.rmSync(root, { recursive: true, force: true }); });
  return { root, source, basedir, target, dataRoot, manager, service, make, calls, write, rows: () => rows, setRows(value) { rows = value; }, onExec(value) { afterExec = value; }, get claimed() { return claimed; } };
}
async function finish(service) { const deadline = Date.now() + 10000; while (service.running && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5)); assert.equal(service.running, false); return service.status("mainnet"); }
async function begin(f) { const preview = await f.service.preview("mainnet"); f.service.start("mainnet", preview.previewId); return finish(f.service); }

test("migration failure injection matches normalized Windows paths without crossing directory boundaries", () => {
  const root = "D:\\Temp\\Kai-Chain-Migration\\old\\mainnet\\basedir";
  assert.equal(inside(root, "d:\\temp\\kai-chain-migration\\old\\mainnet\\basedir\\chain\\0001.sst", path.win32), true);
  assert.equal(inside(root, "d:/TEMP/KAI-CHAIN-MIGRATION/old/mainnet/basedir/chain/0001.sst", path.win32), true);
  assert.equal(inside(root, root, path.win32), false);
  assert.equal(inside(root, root + "-other\\chain\\0001.sst", path.win32), false);
  assert.equal(inside(root, "E:\\Temp\\Kai-Chain-Migration\\old\\mainnet\\basedir\\chain\\0001.sst", path.win32), false);
});

test("reviewed migration retires only the old stack and moves chain state without wallet or producer keys", async t => {
  const f = fixture(t), before = fs.statSync(path.join(f.basedir, "chain/0001.sst"));
  const preview = await f.service.preview("mainnet"); assert.equal(preview.files, 3); assert.equal(preview.available, true); assert.equal(preview.mode, "move"); assert.equal(preview.containers, undefined); assert.match(preview.walletNotice, /KOIN and VHP/);
  assert.equal(f.calls.some(args => ["update", "stop", "rm"].includes(args[0])), false);
  f.service.start("mainnet", preview.previewId); const state = await finish(f.service);
  assert.equal(state.phase, "complete", state.error); assert.equal(state.result.movedFiles, 3); assert.equal(state.result.deletedFiles, 3); assert.equal(f.claimed, false);
  const file = path.join(f.target, "basedir/chain/0001.sst"), after = fs.statSync(file); assert.equal(after.ino, before.ino); assert.equal(after.nlink, 1); assert.deepEqual(fs.readFileSync(file), Buffer.alloc(128, 1));
  assert.equal(fs.existsSync(path.join(f.basedir, "chain")), false); assert.equal(fs.existsSync(path.join(f.target, "basedir/block_producer/private.key")), false);
  assert.equal(fs.readFileSync(path.join(f.basedir, "block_producer/private.key"), "utf8"), "private producer key remains old");
  assert.equal(fs.readFileSync(path.join(f.root, "old/wallet/wallet.json"), "utf8"), "original encrypted wallet remains old");
  assert.equal(fs.readFileSync(path.join(f.source, ".env"), "utf8"), "OLD_CONFIG=kept\n");
  assert.throws(() => assertRestoreReady(f.basedir), /interrupted/); assert.doesNotThrow(() => assertRestoreReady(path.join(f.target, "basedir")));
  assert.equal(f.manager._desiredRunning, false); assert.equal(f.manager._intent.mainnet.producerAddress, null);
  assert.deepEqual(f.calls.filter(args => ["update", "stop", "rm"].includes(args[0])).map(args => args[0]), ["update", "stop", "rm"]);
  assert.ok(!f.calls.some(args => args.includes("--volumes") || args.includes("-f") || args.includes("up")));
});

function templateContainers(f, { running = false } = {}) {
  // Use every real service/image pair so optional services cannot disappear
  // from migration compatibility coverage (the old two-service fixture did).
  const compose = fs.readFileSync(path.join(f.manager.templateRoot, "docker-compose.yml"), "utf8");
  return [...compose.matchAll(/^   ([a-z][a-z0-9_]*):\r?\n      image: ([^\r\n]+)$/gm)].map(([, service, image], index) => ({
    id: (index + 1).toString(16).repeat(64), project: NETWORKS.mainnet.composeProject, root: f.source,
    service, image: image.replace(/\$\{[^:}]+:-([^}]+)\}/g, "$1"), running, paused: false,
    mounts: ["amqp", "rest"].includes(service) ? [] : [{ Type: "bind", Source: f.basedir, Destination: "/koinos", RW: true }],
  }));
}

test("the full stopped legacy template including official p2p is recognized and migrates", async t => {
  const f = fixture(t), rows = templateContainers(f);
  assert.equal(rows.length, 12); assert.equal(rows.find(row => row.service === "p2p").image, "koinos/koinos-p2p:latest");
  assert.ok(rows.every(row => row.running === false)); f.setRows(rows);
  const preview = await f.service.preview("mainnet"); assert.equal(preview.available, true); assert.equal(preview.network, "mainnet");
  assert.ok(!f.calls.some(args => ["update", "stop", "rm"].includes(args[0])));
  f.service.start("mainnet", preview.previewId); const state = await finish(f.service);
  assert.equal(state.phase, "complete", state.error); assert.equal(state.result.movedFiles, 3);
  for (const command of ["update", "stop", "rm"]) {
    const args = f.calls.find(args => args[0] === command); assert.ok(args); assert.equal(args.filter(value => /^[a-f0-9]{64}$/.test(value)).length, rows.length);
    assert.ok(rows.every(row => args.includes(row.id)));
  }
  assert.equal(fs.existsSync(path.join(f.basedir, "chain")), false);
  assert.equal(fs.readFileSync(path.join(f.basedir, "block_producer/private.key"), "utf8"), "private producer key remains old");
});

test("full stopped Windows legacy stacks migrate with equivalent genesis serialization", async t => {
  const reverseKeys = value => Array.isArray(value) ? value.map(reverseKeys) : value && typeof value === "object" ? Object.fromEntries(Object.keys(value).reverse().map(key => [key, reverseKeys(value[key])])) : value;
  for (const kind of ["Windows CRLF", "UTF-8 BOM with CRLF", "compact JSON", "reordered object keys"]) await t.test(kind, async t => {
    const f = fixture(t), file = path.join(f.source, "config/genesis_data.json"), original = fs.readFileSync(file, "utf8");
    const changed = kind === "Windows CRLF" ? original.replace(/\n/g, "\r\n") : kind === "UTF-8 BOM with CRLF" ? "\ufeff" + original.replace(/\n/g, "\r\n") : JSON.stringify(kind === "reordered object keys" ? reverseKeys(JSON.parse(original)) : JSON.parse(original));
    f.write(file, changed); const rows = templateContainers(f); assert.equal(rows.length, 12); assert.ok(rows.every(row => !row.running)); f.setRows(rows);
    const preview = await f.service.preview("mainnet"); assert.equal(preview.available, true); assert.equal(preview.network, "mainnet");
    assert.ok(!f.calls.some(args => ["update", "stop", "rm"].includes(args[0])));
    f.service.start("mainnet", preview.previewId); const state = await finish(f.service); assert.equal(state.phase, "complete", state.error);
    assert.equal(state.result.movedFiles, 3); assert.equal(fs.existsSync(path.join(f.basedir, "chain")), false);
    assert.equal(fs.readFileSync(file, "utf8"), changed, "Migration must not rewrite the old genesis");
    assert.equal(fs.readFileSync(path.join(f.basedir, "block_producer/private.key"), "utf8"), "private producer key remains old");
    assert.equal(fs.readFileSync(path.join(f.root, "old/wallet/wallet.json"), "utf8"), "original encrypted wallet remains old");
    assert.equal(fs.existsSync(path.join(f.target, "basedir/block_producer/private.key")), false);
    assert.equal(f.calls.find(args => args[0] === "rm").filter(id => /^[a-f0-9]{64}$/.test(id)).length, 12);
  });
});

test("different network or genesis content is refused for the full stopped stack", async t => {
  for (const kind of ["Harbinger", "changed value", "changed type", "changed array order"]) await t.test(kind, async t => {
    const f = fixture(t), file = path.join(f.source, "config/genesis_data.json"), data = JSON.parse(fs.readFileSync(file, "utf8"));
    if (kind === "Harbinger") f.write(file, fs.readFileSync(path.join(f.manager.templateRoot, "harbinger/genesis_data.json")));
    else { if (kind === "changed value") data.entries[0].value += "A"; if (kind === "changed type") data.entries[0].space.system = String(data.entries[0].space.system); if (kind === "changed array order") data.entries.reverse(); f.write(file, JSON.stringify(data)); }
    const unchanged = fs.readFileSync(file); f.setRows(templateContainers(f));
    await assert.rejects(f.service.preview("mainnet"), /does not match the selected Mainnet network.*preserved/);
    assert.ok(!f.calls.some(args => ["update", "stop", "rm"].includes(args[0]))); assert.ok(fs.existsSync(path.join(f.basedir, "chain/0001.sst"))); assert.deepEqual(fs.readFileSync(file), unchanged);
  });
});

test("invalid genesis gives accurate validation errors without stopping or changing a node", async t => {
  const invalid = [
    ["malformed", "wrong network", /could not be validated: Genesis JSON is malformed/],
    ["duplicate keys", '{"entries":[],"entries":[]}', /duplicate object key/],
    ["invalid UTF-8", Buffer.from([0xff]), /valid UTF-8/],
    ["oversized", Buffer.alloc(8 * 1024 * 1024 + 1), /8 MiB supported size limit/],
    ["excessive values", '{"a":[' + "0,".repeat(200000) + '0]}', /too many values/],
  ];
  for (const [kind, content, message] of invalid) await t.test(kind, async t => {
    const f = fixture(t), file = path.join(f.source, "config/genesis_data.json"); f.write(file, content); f.setRows(templateContainers(f));
    await assert.rejects(f.service.preview("mainnet"), error => { assert.match(error.message, message); assert.doesNotMatch(error.message, /does not match/); return true; });
    assert.ok(!f.calls.some(args => ["update", "stop", "rm"].includes(args[0]))); assert.ok(fs.existsSync(path.join(f.basedir, "chain/0001.sst"))); assert.deepEqual(fs.readFileSync(file), Buffer.from(content));
  });
});

test("missing, linked and unreadable genesis files are identified before any Docker mutation", async t => {
  for (const kind of ["missing", "linked", "unreadable"]) await t.test(kind, async t => {
    const f = fixture(t), file = path.join(f.source, "config/genesis_data.json"); f.setRows(templateContainers(f)); let denied = false;
    if (kind === "missing") fs.unlinkSync(file);
    if (kind === "linked") fs.linkSync(file, path.join(f.source, "genesis-backup.json"));
    if (kind === "unreadable") { const open = fs.openSync; fs.openSync = (name, ...args) => { if (path.relative(file, String(name)) === "") { denied = true; throw Object.assign(Error("Denied"), { code: "EACCES" }); } return open(name, ...args); }; t.after(() => { fs.openSync = open; }); }
    await assert.rejects(f.service.preview("mainnet"), kind === "missing" ? /missing, linked or unsafe path/ : kind === "linked" ? /linked or is not a regular file/ : /could not be read/);
    if (kind === "unreadable") assert.equal(denied, true, "Read-denial injection must exercise the file open");
    assert.ok(!f.calls.some(args => ["update", "stop", "rm"].includes(args[0]))); assert.ok(fs.existsSync(path.join(f.basedir, "chain/0001.sst")));
  });
});

test("genesis changes during reading or after review preserve the stopped source stack", async t => {
  await t.test("changed during read", async t => {
    const f = fixture(t), file = path.join(f.source, "config/genesis_data.json"), read = fs.readSync; f.setRows(templateContainers(f)); let changed = false;
    fs.readSync = (fd, ...args) => { const count = read(fd, ...args); if (!changed) { changed = true; fs.appendFileSync(file, " "); } return count; };
    t.after(() => { fs.readSync = read; });
    await assert.rejects(f.service.preview("mainnet"), /changed while being read/); assert.equal(changed, true);
    assert.ok(!f.calls.some(args => ["update", "stop", "rm"].includes(args[0]))); assert.ok(fs.existsSync(path.join(f.basedir, "chain/0001.sst")));
  });
  await t.test("wrong network after review", async t => {
    const f = fixture(t); f.setRows(templateContainers(f)); const preview = await f.service.preview("mainnet");
    f.write(path.join(f.source, "config/genesis_data.json"), fs.readFileSync(path.join(f.manager.templateRoot, "harbinger/genesis_data.json")));
    f.service.start("mainnet", preview.previewId); const state = await finish(f.service); assert.equal(state.phase, "failed"); assert.match(state.error, /selected Mainnet network/);
    assert.ok(!f.calls.some(args => ["update", "stop", "rm"].includes(args[0]))); assert.ok(fs.existsSync(path.join(f.basedir, "chain/0001.sst")));
  });
});

test("official service images support Docker Hub qualification, versions, and immutable digests", async t => {
  const f = fixture(t), rows = templateContainers(f, { running: true });
  for (const row of rows) {
    const repository = row.image.split(":")[0];
    row.image = row.service === "amqp" ? "docker.io/library/rabbitmq:3-management" : `docker.io/${repository}:v2.0.0@sha256:${"a".repeat(64)}`;
  }
  f.setRows(rows); assert.equal((await f.service.preview("mainnet")).available, true);
  rows.find(row => row.service === "p2p").image = "koinos/koinos-p2p@sha256:" + "b".repeat(64);
  rows.find(row => row.service === "amqp").image = "library/rabbitmq:3-management";
  assert.equal((await f.service.preview("mainnet")).available, true);
  assert.ok(!f.calls.some(args => ["update", "stop", "rm"].includes(args[0])));
});

test("unknown image repositories, wrong service images, and look-alike tags remain rejected", async t => {
  for (const image of ["koinos/koinos-other:latest", "koinos/koinos-chain:latest", "example/koinos-p2p:latest", "registry.example/koinos/koinos-p2p:latest", "koinos/koinos-p2p-extra:latest", "koinos/koinos-p2p:latest/extra", "koinos/koinos-p2p@sha256:bad", "rabbitmq:3-management"]) await t.test(image, async t => {
    const f = fixture(t), rows = templateContainers(f); rows.find(row => row.service === "p2p").image = image; f.setRows(rows);
    await assert.rejects(f.service.preview("mainnet"), /not a recognized Koinos AI node/);
    assert.ok(!f.calls.some(args => ["update", "stop", "rm"].includes(args[0]))); assert.ok(fs.existsSync(path.join(f.basedir, "chain/0001.sst")));
  });
  const f = fixture(t), rows = templateContainers(f); rows.find(row => row.service === "p2p").service = "p2p2"; f.setRows(rows);
  await assert.rejects(f.service.preview("mainnet"), /not a recognized Koinos AI node/); assert.ok(!f.calls.some(args => ["update", "stop", "rm"].includes(args[0])));
});

test("a live old-app lock refuses container changes and source deletion", async t => {
  const f = fixture(t, { locked: true }), state = await begin(f); assert.equal(state.phase, "failed"); assert.match(state.error, /Another KAI app/); assert.equal(state.resumable, false);
  assert.ok(!f.calls.some(args => ["update", "stop", "rm"].includes(args[0]))); assert.ok(fs.existsSync(path.join(f.basedir, "chain/0001.sst")));
});

test("remote Docker contexts, mismatched genesis, unrelated writers, and occupied destinations are refused", async t => {
  for (const kind of ["remote", "genesis", "writer", "occupied"]) await t.test(kind, async t => {
    const f = fixture(t, kind === "remote" ? { endpoint: "ssh://remote.example" } : {});
    if (kind === "genesis") f.write(path.join(f.source, "config/genesis_data.json"), "wrong network");
    if (kind === "writer") f.setRows([...f.rows(), { id: "f".repeat(64), project: "unrelated", running: false, mounts: [{ Type: "bind", Source: path.dirname(f.basedir), Destination: "/data", RW: true }] }]);
    if (kind === "occupied") f.write(path.join(f.target, "basedir/chain/existing"), "keep");
    await assert.rejects(f.service.preview("mainnet"), /local Docker|malformed|Another Docker|already has chain/);
    assert.ok(!f.calls.some(args => ["update", "stop", "rm"].includes(args[0]))); assert.ok(fs.existsSync(path.join(f.basedir, "chain/0001.sst")));
  });
});

test("stale reviewed containers and unclean shutdown cannot begin transfer", async t => {
  const f = fixture(t), preview = await f.service.preview("mainnet"); f.rows()[0].id = "a".repeat(64); f.service.start("mainnet", preview.previewId); const state = await finish(f.service); assert.equal(state.phase, "failed"); assert.match(state.error, /changed since review/); assert.ok(fs.existsSync(path.join(f.basedir, "chain/0001.sst")));
  const g = fixture(t, { refuseStop: true }), stopped = await begin(g); assert.equal(stopped.phase, "failed"); assert.match(stopped.error, /still running/); assert.ok(!g.calls.some(args => args[0] === "rm"));
});

test("linked source files and directories are never transferred", async t => {
  const f = fixture(t); fs.linkSync(path.join(f.basedir, "chain/0001.sst"), path.join(f.basedir, "chain/linked.sst"));
  await assert.rejects(f.service.preview("mainnet"), /linked or special/); assert.ok(fs.existsSync(path.join(f.basedir, "chain/0001.sst")));
});

test("cross-device copy verifies each destination and deletes each original after publication", async t => {
  const f = fixture(t), original = fsp.link; let injected = 0;
  fsp.link = async (source, target) => { if (inside(f.basedir, source)) { injected++; throw Object.assign(Error("different filesystem"), { code: "EXDEV" }); } return original(source, target); };
  t.after(() => { fsp.link = original; });
  const before = fs.statSync(path.join(f.basedir, "chain/0001.sst")), state = await begin(f); assert.equal(state.phase, "complete", state.error);
  assert.equal(injected, 3, "Every chain file must exercise the cross-device copy branch");
  const after = fs.statSync(path.join(f.target, "basedir/chain/0001.sst")); assert.notEqual(after.ino, before.ino); assert.equal(after.nlink, 1); assert.equal(fs.existsSync(path.join(f.basedir, "chain")), false);
});

test("pause retains completed files and durable markers, then another service instance resumes", async t => {
  const f = fixture(t); let paused = false;
  f.onExec(args => { if (!paused && args[0] === "ps" && f.service.status("mainnet").progress.completedFiles > 0) { paused = true; f.service.cancel(); } });
  let state = await begin(f); assert.equal(state.phase, "cancelled", state.error); assert.equal(state.resumable, true); assert.ok(state.progress.completedFiles > 0); assert.ok(state.progress.completedFiles < 3);
  assert.throws(() => assertRestoreReady(f.basedir)); assert.throws(() => assertRestoreReady(path.join(f.target, "basedir")));
  f.onExec(null); const resumed = f.make(); t.after(() => resumed.dispose()); const preview = await resumed.preview("mainnet"); assert.equal(preview.resumable, true);
  resumed.start("mainnet", preview.previewId); state = await finish(resumed); assert.equal(state.phase, "complete", state.error); assert.equal(state.result.movedFiles, 3); assert.equal(fs.existsSync(path.join(f.basedir, "chain")), false);
});

test("a writer appearing after stop blocks cleanup and preserves the source", async t => {
  const f = fixture(t); let injected = false;
  f.onExec(args => { if (!injected && args[0] === "ps" && fs.existsSync(path.join(f.target, "basedir/chain/0001.sst"))) { injected = true; f.setRows([{ id: "a".repeat(64), project: "unrelated", running: true, mounts: [{ Type: "bind", Source: f.basedir, Destination: "/data", RW: true }] }]); } });
  const state = await begin(f); assert.equal(state.phase, "failed"); assert.match(state.error, /Another Docker/); assert.ok(fs.existsSync(path.join(f.basedir, "chain/0001.sst"))); assert.equal(state.resumable, true);
});

test("completed journal safely removes its own finalization marker after interruption", async t => {
  const f = fixture(t), state = await begin(f); assert.equal(state.phase, "complete", state.error);
  fs.copyFileSync(path.join(f.basedir, MARKER), path.join(f.target, "basedir", MARKER));
  const recovered = f.make(); t.after(() => recovered.dispose()); assert.equal(recovered.status("mainnet").phase, "complete"); assert.equal(fs.existsSync(path.join(f.target, "basedir", MARKER)), false);
});

test("start requires a private reviewed ID and blocks conflicting plugin operations", async t => {
  const f = fixture(t); assert.throws(() => f.service.start("mainnet", "invented"), /Review/); const preview = await f.service.preview("mainnet"); f.manager._op = { running: true }; assert.throws(() => f.service.start("mainnet", preview.previewId), /current node operation/); f.manager._op = null;
  f.service.start("mainnet", preview.previewId); await assert.rejects(f.manager._assertControl("mainnet"), /migration/); await finish(f.service);
});

test("pause immediately after container retirement can resume from its preparation journal", async t => {
  const f = fixture(t); let paused = false;
  f.onExec(args => { if (!paused && args[0] === "ps" && f.calls.some(call => call[0] === "rm")) { paused = true; f.service.cancel(); } });
  let state = await begin(f); assert.equal(state.phase, "cancelled"); assert.equal(state.resumable, true); assert.equal(state.progress.completedFiles, 0); assert.equal(f.rows().length, 0);
  f.onExec(null); const resumed = f.make(); t.after(() => resumed.dispose()); const preview = await resumed.preview("mainnet"); assert.equal(preview.resumable, true);
  resumed.start("mainnet", preview.previewId); state = await finish(resumed); assert.equal(state.phase, "complete", state.error); assert.equal(state.result.movedFiles, 3);
});

test("failed cross-device source cleanup resumes the verified pending destination", async t => {
  const f = fixture(t), link = fsp.link, unlink = fs.unlinkSync; let injected = 0;
  fsp.link = async (source, target) => { if (inside(f.basedir, source)) { injected++; throw Object.assign(Error("cross-device"), { code: "EXDEV" }); } return link(source, target); };
  let blocked = false;
  fs.unlinkSync = file => { if (!blocked && inside(f.basedir, file) && path.basename(String(file)) === "0001.sst") { blocked = true; throw Object.assign(Error("Synthetic cleanup lock"), { code: "EACCES" }); } return unlink(file); };
  t.after(() => { fsp.link = link; fs.unlinkSync = unlink; });
  let state = await begin(f); assert.equal(state.phase, "failed"); assert.ok(fs.existsSync(path.join(f.basedir, "chain/0001.sst"))); assert.ok(fs.existsSync(path.join(f.target, "basedir/chain/0001.sst")));
  assert.ok(injected > 0, "Cross-device copy failure must be injected"); assert.equal(blocked, true, "Source cleanup failure must be injected");
  assert.notEqual(fs.statSync(path.join(f.basedir, "chain/0001.sst")).ino, fs.statSync(path.join(f.target, "basedir/chain/0001.sst")).ino);
  const preview = await f.service.preview("mainnet"); f.service.start("mainnet", preview.previewId); state = await finish(f.service); assert.equal(state.phase, "complete", state.error);
});

test("cross-device crash after publication recognizes only its own extra staging link", async t => {
  const f = fixture(t), link = fsp.link, unlink = fs.unlinkSync; let injected = 0;
  fsp.link = async (source, target) => { if (inside(f.basedir, source)) { injected++; throw Object.assign(Error("cross-device"), { code: "EXDEV" }); } return link(source, target); };
  let blocked = false;
  fs.unlinkSync = file => { if (!blocked && String(file).includes(".kai-chain-") && String(file).endsWith(".tmp")) { blocked = true; throw Object.assign(Error("Synthetic crash after publication"), { code: "EACCES" }); } return unlink(file); };
  t.after(() => { fsp.link = link; fs.unlinkSync = unlink; });
  let state = await begin(f); assert.equal(state.phase, "failed"); const record = JSON.parse(fs.readFileSync(path.join(f.dataRoot,".profile-migrations/mainnet.json"),"utf8")); const targetFile = path.join(f.target, "basedir", record.current.relative); assert.equal(fs.statSync(targetFile).nlink, 2); assert.ok(fs.existsSync(path.join(f.basedir, record.current.relative)));
  assert.ok(injected > 0, "Cross-device copy failure must be injected"); assert.equal(blocked, true, "Staging cleanup failure must be injected");
  assert.notEqual(fs.statSync(path.join(f.basedir, record.current.relative)).ino, fs.statSync(targetFile).ino);
  const resumed = f.make(); t.after(() => resumed.dispose()); const preview = await resumed.preview("mainnet"); resumed.start("mainnet", preview.previewId); state = await finish(resumed); assert.equal(state.phase, "complete", state.error); assert.equal(fs.statSync(targetFile).nlink, 1);
});

test("network changes without a journal reset the displayed migration state", async t => {
  const f = fixture(t); assert.equal((await begin(f)).phase, "complete"); assert.equal(f.service.status("harbinger").phase, "idle");
});

test("target changes during the final Docker check preserve the original cross-device source", async t => {
  const f = fixture(t), link = fsp.link; let injected = 0, originalBytes;
  fsp.link = async (source, target) => { if (inside(f.basedir, source)) { injected++; throw Object.assign(Error("cross-device"), { code: "EXDEV" }); } return link(source, target); };
  t.after(() => { fsp.link = link; });
  let changed;
  f.onExec(args => {
    if (changed || args[0] !== "ps") return;
    const file = path.join(f.dataRoot, ".profile-migrations/mainnet.json"); if (!fs.existsSync(file)) return;
    const current = JSON.parse(fs.readFileSync(file, "utf8")).current; if (!current) return;
    const destination = path.join(f.target, "basedir", current.relative); if (!fs.existsSync(destination)) return;
    originalBytes = fs.readFileSync(path.join(f.basedir, current.relative));
    assert.notEqual(fs.statSync(path.join(f.basedir, current.relative)).ino, fs.statSync(destination).ino);
    fs.writeFileSync(destination, Buffer.alloc(current.bytes, 8)); changed = current.relative;
  });
  const state = await begin(f); assert.equal(state.phase, "failed"); assert.match(state.error, /destination changed/); assert.ok(changed); assert.ok(fs.existsSync(path.join(f.basedir, changed))); assert.equal(state.resumable, true);
  assert.ok(injected > 0, "Cross-device copy failure must be injected");
  assert.deepEqual(fs.readFileSync(path.join(f.basedir, changed)), originalBytes, "Destination mutation must leave the original source bytes unchanged");
});

test("preparing journal is exposed as a resumable paused operation after restart", async t => {
  const f = fixture(t); let pause = false;
  f.onExec(args => { if (!pause && args[0] === "ps" && f.calls.some(call => call[0] === "rm")) { pause = true; f.service.cancel(); } });
  const state = await begin(f); assert.equal(state.phase, "cancelled");
  const file = path.join(f.dataRoot,".profile-migrations/mainnet.json"), record = JSON.parse(fs.readFileSync(file,"utf8")); record.phase = "preparing"; fs.writeFileSync(file,JSON.stringify(record));
  const restarted = f.make(); t.after(() => restarted.dispose()); assert.equal(restarted.status("mainnet").phase,"cancelled"); assert.equal(restarted.status("mainnet").resumable,true); assert.equal((await restarted.preview("mainnet")).resumable,true);
});

test("a completed migration remains readable after the old profile is removed", async t => {
  const f = fixture(t); assert.equal((await begin(f)).phase,"complete"); fs.rmSync(path.join(f.root,"old"),{recursive:true,force:true}); const restarted=f.make(); t.after(()=>restarted.dispose()); assert.equal(restarted.status("mainnet").phase,"complete");
});
