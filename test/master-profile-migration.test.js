"use strict";
const { test } = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path"), os = require("node:os");
const { createProfileMigration, identifyMasterSource, masterProfileFromRoot } = require("../plugin/service/core/lib/koinos/profile-migration");
const { NodeManager } = require("../plugin/service/core/lib/koinos/node-manager");
const { NETWORKS } = require("../plugin/service/core/lib/koinos/constants");
const templateRoot = path.resolve(__dirname, "../plugin/service/core/koinos-node-template");
function fixture(t, { origin = "master", custom = false } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "kai-master-migration-")));
  const profile = path.join(root, origin === "headless" ? ".master-koinos-ai" : origin === "alpha" ? "Koinos AI" : origin === "core" ? "KAI Core" : "Master Koinos AI Node");
  const dataRoot = path.join(root, "plugin", "node"), core = path.join(profile, ...(origin === "headless" ? [] : ["core"]), "koinos-node");
  const source = origin === "regular-plugin" ? path.join(root, "KAI Core", "foundation-v1", "plugins-v3", "kai.koinos-node", "data", "koinos-node", "node", "mainnet")
    : custom ? path.join(root, "external-chain", "mainnet") : path.join(core, "node", "mainnet");
  const basedir = path.join(source, "basedir"), calls = [];
  const write = (file, value) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, value); };
  write(path.join(source, "config/genesis_data.json"), fs.readFileSync(path.join(templateRoot, "mainnet/genesis_data.json")));
  write(path.join(basedir, "chain/database.sst"), "verified chain data"); write(path.join(basedir, "block_store/blocks.sst"), "verified block data");
  write(path.join(basedir, "block_producer/private.key"), "old private key");
  if (custom) write(path.join(core, "settings.json"), JSON.stringify({ node: { dataDir: path.dirname(source) } }));
  let rows = ["chain", "block_store"].map((service, i) => ({ id: String(i + 1).repeat(64), project: NETWORKS.mainnet.composeProject, root: source, service,
    image: `koinos/koinos-${service.replaceAll("_", "-")}:latest`, running: true, paused: false, mounts: [{ Type: "bind", Source: basedir, Destination: "/koinos", RW: true }] }));
  const ok = stdout => ({ ok: true, stdout: stdout || "", stderr: "" });
  let pauseAfterRemove = false, service;
  const exec = async (bin, args) => {
    calls.push(args);
    if (args[0] === "context") return ok(JSON.stringify("unix:///var/run/docker.sock"));
    if (args[0] === "ps") return ok(rows.map(row => row.id.slice(0, 12)).join("\n"));
    if (args[0] === "inspect") return ok(rows.map(row => JSON.stringify(row)).join("\n"));
    if (args[0] === "update") return ok();
    if (args[0] === "stop") { rows.forEach(row => { row.running = false; }); return ok(); }
    if (args[0] === "rm") { rows = []; if (pauseAfterRemove) service.cancel(); return ok(); }
    throw Error(`Unexpected Docker command ${args.join(" ")}`);
  };
  const manager = new NodeManager({ templateRoot, dataRoot, autoRecover: false });
  const make = () => createProfileMigration({ manager }, { exec, claim: () => () => {}, masterProfiles: [profile] });
  service = make();
  t.after(async () => { await service.dispose(); manager.dispose(); fs.rmSync(root, { recursive: true, force: true }); });
  return { root, profile, core, source, basedir, dataRoot, manager, service, make, calls, write, rows: () => rows, pauseAfterRemove() { pauseAfterRemove = true; } };
}
async function finish(service) { const until = Date.now() + 5000; while (service.running && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 5)); assert.equal(service.running, false); return service.status("mainnet"); }

test("Master profile identity accepts exact desktop/headless roots and normalized Windows aliases", () => {
  for (const root of ["C:\\Users\\Mike\\AppData\\Roaming\\Master Koinos AI Node\\core\\koinos-node\\node\\mainnet", "/host_mnt/c/users/mike/appdata/roaming/master koinos ai node/core/koinos-node/node/mainnet", "/home/user/.config/Master Koinos AI Node/core/koinos-node/node/mainnet", "/home/user/.master-koinos-ai/koinos-node/node/mainnet"]) {
    assert.ok(masterProfileFromRoot(root, "mainnet"), root);
    assert.equal(masterProfileFromRoot(root, "harbinger"), null);
  }
  for (const root of ["/home/user/.config/Koinos AI/core/koinos-node/node/mainnet", "/home/user/.koinos-ai/koinos-node/node/mainnet", "/tmp/Master Koinos AI Node backup/core/koinos-node/node/mainnet", "/tmp/Master Koinos AI Node/core/other/node/mainnet", "/tmp/Master Koinos AI Node/core/koinos-node/node/mainnet/nested"]) assert.equal(masterProfileFromRoot(root, "mainnet"), null);
});

test("Master and headless Master chains are identified, reviewed and transferred without producer keys", async t => {
  for (const origin of ["master", "headless"]) await t.test(origin, async t => {
    const f = fixture(t, { origin }), preview = await f.service.preview("mainnet");
    assert.equal(preview.source.app, "Master Koinos AI Node"); assert.equal(preview.source.storage, "default");
    f.service.start("mainnet", preview.previewId); const result = await finish(f.service);
    assert.equal(result.phase, "complete", result.error);
    assert.equal(fs.readFileSync(path.join(f.manager.dirs("mainnet").basedir, "chain/database.sst"), "utf8"), "verified chain data");
    assert.equal(fs.existsSync(path.join(f.basedir, "chain/database.sst")), false);
    assert.equal(fs.readFileSync(path.join(f.basedir, "block_producer/private.key"), "utf8"), "old private key");
    assert.equal(fs.existsSync(path.join(f.manager.dirs("mainnet").basedir, "block_producer/private.key")), false);
  });
});

test("Alpha, Core and the ordinary Node plugin cannot be stopped or migrated by the Master plugin", async t => {
  for (const origin of ["alpha", "core", "regular-plugin"]) await t.test(origin, async t => {
    const f = fixture(t, { origin });
    await assert.rejects(f.service.preview("mainnet"), /Only a verified Master Koinos AI Node/);
    assert.equal(f.calls.some(args => ["update", "stop", "rm"].includes(args[0])), false);
    assert.equal(fs.readFileSync(path.join(f.basedir, "chain/database.sst"), "utf8"), "verified chain data");
  });
});

test("a custom chain folder requires its exact association in the Master profile settings", async t => {
  const f = fixture(t, { custom: true }), preview = await f.service.preview("mainnet");
  assert.equal(preview.source.storage, "configured"); assert.equal(preview.source.profile, f.profile);
  f.write(path.join(f.core, "settings.json"), JSON.stringify({ node: { dataDir: path.join(f.root, "other") } }));
  assert.throws(() => identifyMasterSource(f.source, "mainnet", [f.profile]), /Only a verified Master/);
  f.service.start("mainnet", preview.previewId); const result = await finish(f.service);
  assert.equal(result.phase, "failed"); assert.equal(f.calls.some(args => ["update", "stop", "rm"].includes(args[0])), false);
});

test("Master Compose labels cannot authorize transferring an unrelated chain mount", async t => {
  const f = fixture(t), other = path.join(f.root, "other-chain"); fs.mkdirSync(other);
  for (const row of f.rows()) row.mounts[0].Source = other;
  await assert.rejects(f.service.preview("mainnet"), /chain mount does not belong/);
  assert.equal(f.calls.some(args => ["update", "stop", "rm"].includes(args[0])), false);
  assert.equal(fs.readFileSync(path.join(f.basedir, "chain/database.sst"), "utf8"), "verified chain data");
});

test("a linked custom-source settings file is refused rather than read through", async t => {
  const f = fixture(t, { custom: true }), settings = path.join(f.core, "settings.json");
  fs.linkSync(settings, path.join(f.root, "settings-link"));
  await assert.rejects(f.service.preview("mainnet"), /unsafe/);
  assert.equal(f.calls.some(args => ["update", "stop", "rm"].includes(args[0])), false);
});

test("paused migration revalidates the saved source as Master before resuming", async t => {
  const f = fixture(t); f.pauseAfterRemove();
  const preview = await f.service.preview("mainnet"); f.service.start("mainnet", preview.previewId);
  const result = await finish(f.service); assert.equal(result.phase, "cancelled", result.error);
  const file = path.join(f.dataRoot, ".profile-migrations/mainnet.json"), saved = JSON.parse(fs.readFileSync(file, "utf8"));
  saved.source.root = path.join(f.root, "Koinos AI", "core", "koinos-node", "node", "mainnet");
  fs.writeFileSync(file, JSON.stringify(saved));
  const resumed = f.make(); await assert.rejects(resumed.preview("mainnet"), /reviewed Master|Only a verified Master/); await resumed.dispose();
  assert.equal(fs.readFileSync(path.join(f.basedir, "chain/database.sst"), "utf8"), "verified chain data");
});
