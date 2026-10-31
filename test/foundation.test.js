"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const { create } = require("../plugin/service");
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kai-node-foundation-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const settings = new Map();
  return { root, api: { version: 1, plugin: { id: "kai.koinos-node", version: "0.3.0", dataDir: root }, signal: new AbortController().signal, settings: { get: (k, fallback) => settings.has(k) ? settings.get(k) : fallback, set: (k, v) => settings.set(k, v) }, desktop: { hostWindowId: () => 1, confirm: async () => true } }, electron: { BrowserWindow: { fromId: () => ({ id: 1 }) }, dialog: { showMessageBox: async () => ({ response: 0 }) }, app: { getLocale: () => "en" } } };
}
test("service creates a fresh Node wallet using no Core wallet or private feature object", async t => {
  const f = fixture(t), service = create(f.api, { electron: f.electron });
  try {
    assert.equal((await service.call("node.read", { channel: "wallet:status" })).exists, false);
    const result = await service.call("node.wallet", { channel: "wallet:create", payload: { password: "synthetic-node-password" } });
    assert.equal(result.nativeShown, true); assert.equal(result.wif, undefined);
    const wallet = await service.call("node.read", { channel: "wallet:status" });
    assert.equal(wallet.exists, true); assert.equal(wallet.unlocked, true);
    assert.ok(fs.existsSync(path.join(f.root, "wallet/wallet.json")));
    await service.call("node.wallet", { channel: "wallet:lock" });
    await assert.rejects(service.call("node.wallet", { channel: "wallet:unlock", payload: { password: "wrong-password" } }), /Incorrect password/);
    await service.call("node.wallet", { channel: "wallet:unlock", payload: { password: "synthetic-node-password" } });
    assert.equal((await service.call("node.read", { channel: "wallet:status" })).address, wallet.address);
    const info = await service.call("node.read", { channel: "app:info" });
    assert.equal(info.version, "0.3.0");
    const lang = await service.call("node.language", { language: "es" }); assert.equal(lang.language, "es");
    await service.call("node.wallet", { channel: "wallet:remove", payload: { password: "synthetic-node-password", confirm: "REMOVE" } });
    const removed = await service.call("node.read", { channel: "wallet:status" }); assert.equal(removed.exists, false); assert.equal(removed.address, null); assert.equal(removed.ethAddress, null);
  } finally { await service.dispose({ reason: "quit" }); }
});
test("unreadable wallet is preserved and cannot silently become a new wallet", t => {
  const f = fixture(t); fs.mkdirSync(path.join(f.root, "wallet")); const file = path.join(f.root, "wallet/wallet.json"); fs.writeFileSync(file, "broken-wallet");
  assert.throws(() => create(f.api, { electron: f.electron }), /unreadable/); assert.equal(fs.readFileSync(file, "utf8"), "broken-wallet");
});
test("service revocation prevents subsequent Node calls", async t => {
  const f = fixture(t), controller = new AbortController(); f.api.signal = controller.signal;
  const service = create(f.api, { electron: f.electron }); controller.abort(Error("Disabled"));
  assert.throws(() => service.call("node.read", { channel: "wallet:status" }), /Disabled/); await service.dispose();
});
test("failed native shutdown remains retryable through the public service entry", async t => {
  const f = fixture(t); let stops = 0, locked = 0;
  const service = create(f.api, { electron: f.electron, wallet: { lock() { locked++; } }, createNode: () => ({ call() {}, async dispose() { if (++stops === 1) throw Error("Docker did not stop"); } }) });
  await assert.rejects(service.dispose({ reason: "disable" }), /Docker did not stop/);
  assert.throws(() => service.call("node.read", {}), /closing/);
  await service.dispose({ reason: "disable" }); assert.equal(stops, 2); assert.equal(locked, 1);
});
test("trusted OS ancestor aliases are canonicalized before wallet checks", async t => {
  const f = fixture(t), real = path.join(f.root, "real"), alias = path.join(f.root, "alias"); fs.mkdirSync(real); fs.mkdirSync(path.join(real, "data"));
  fs.symlinkSync(real, alias, process.platform === "win32" ? "junction" : "dir"); f.api.plugin.dataDir = path.join(alias, "data");
  const service = create(f.api, { electron: f.electron });
  try { assert.equal((await service.call("node.read", { channel: "wallet:status" })).exists, false); } finally { await service.dispose(); }
});
test("the profile leaf and wallet directory cannot be redirected by symlinks", t => {
  const f = fixture(t), real = path.join(f.root, "real"), alias = path.join(f.root, "alias"); fs.mkdirSync(real);
  fs.symlinkSync(real, alias, process.platform === "win32" ? "junction" : "dir"); f.api.plugin.dataDir = alias;
  assert.throws(() => create(f.api, { electron: f.electron }), /real directory/);
  f.api.plugin.dataDir = f.root; fs.symlinkSync(real, path.join(f.root, "wallet"), process.platform === "win32" ? "junction" : "dir");
  assert.throws(() => create(f.api, { electron: f.electron }), /unsafe/);
});
