"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), os = require("node:os"), path = require("node:path"), http = require("node:http");
const full = require("./node-service-fixture");
const { createKoinosNode } = require("../plugin/service/core/lib/koinos-node");
const { Signer } = require("../plugin/service/node_modules/koilib");

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kai-master-integration-"));
  const address = Signer.fromSeed("master plugin isolated public fixture only").address;
  let services, approved = true, held = false, signatures = 0;
  const reviews = [], wallet = { address, status: () => ({ exists: true, address: wallet.address, unlocked: true }),
    get signer() { return { signHash: async () => { signatures++; return "fixture signature"; } }; },
    signerFor(password) { if (password !== "fixture proof") throw Error("Incorrect password"); return this.signer; } };
  let spendTail = Promise.resolve();
  const service = full.create({ dataDir: dir, wallet, settings: { get: () => null }, electron: {},
    confirm: async (title, detail) => { reviews.push({ title, detail }); return approved; },
    withWalletSpend(run) { const next = spendTail.catch(() => {}).then(async () => { held = true; try { return await run(); } finally { held = false; } }); spendTail = next; return next; },
  }, { createEngine: options => createKoinosNode({ ...options, configureServices(value) {
    options.configureServices(value); services = value;
    value.nodeMgr.supervise = () => {};
    value.nodeMgr.status = async () => ({ docker: { ok: true }, isRunning: false });
    value.masterApi.fetchImpl = async () => { throw Error("Synthetic offline local node"); };
  } }) });
  service.startBackground();
  return { dir, wallet, service, services, reviews, get held() { return held; }, get signatures() { return signatures; },
    setApproved(v) { approved = v; }, async close() { await service.dispose(); fs.rmSync(dir, { recursive: true, force: true }); } };
}
const config = { enabled: true, sharePct: { ai: 0, producing: 0, both: 0 }, reburnPct: 50, recipients: [], password: "fixture proof" };

test("Master features start disabled and retain the plugin's own data and wallet", async () => {
  const f = fixture(); try {
    const info = await f.service.call("node.read", { channel: "app:info" });
    assert.equal(info.settings.distribution.enabled, false); assert.equal(info.settings.masterApi.enabled, false);
    assert.equal((await f.service.call("node.read", { channel: "distribution:status" })).running, false);
    const api = await f.service.call("node.read", { channel: "masterApi:status" }); assert.equal(api.listening, false);
    assert.equal(f.services.settings.get("node.dataDir"), null); assert.equal(f.wallet.address, info.settings.producer?.addresses?.mainnet || f.wallet.address);
    assert.equal(f.services.nodeMgr.dataRoot, path.join(f.dir, "koinos-node", "node"));
    assert.equal(f.signatures, 0);
  } finally { await f.close(); }
});

test("distribution saving requires password and binds approval to wallet, RPC and exact configuration", async () => {
  const f = fixture(); try {
    await assert.rejects(f.service.call("node.wallet", { channel: "distribution:configure", payload: { ...config, password: "wrong" } }), /Incorrect password/);
    assert.equal(f.services.distribution.config().enabled, false);
    await f.service.call("node.wallet", { channel: "distribution:configure", payload: config });
    assert.equal(f.services.rewards.config().enabled, false); assert.doesNotThrow(() => f.services.distribution.authorize());
    const saved = f.services.settings.get("distribution");
    f.services.settings.set("distribution", { ...saved, reburnPct: 60 }); assert.throws(() => f.services.distribution.authorize(), /configuration/);
    f.services.settings.set("distribution", saved);
    const original = f.wallet.address; f.wallet.address = Signer.fromSeed("other master fixture only").address;
    assert.throws(() => f.services.distribution.authorize(), /wallet\/network/); f.wallet.address = original;
    f.services.settings.set("customRpc", { mainnet: "https://example.invalid" }); assert.throws(() => f.services.distribution.authorize(), /wallet\/network/);
    f.services.settings.set("customRpc", {}); assert.doesNotThrow(() => f.services.distribution.authorize());
    await f.service.call("node.wallet", { channel: "distribution:configure", payload: { enabled: false } });
    assert.equal(f.services.distribution.config().enabled, false); assert.equal(f.services.distribution._timer, null);
    assert.equal(f.reviews.some(r => r.detail.includes("fixture proof")), false);
  } finally { await f.close(); }
});

test("distribution reset requires explicit confirmation and native approval, then pauses tracking", async () => {
  const f = fixture(); try {
    await f.service.call("node.wallet", { channel: "distribution:configure", payload: config });
    await assert.rejects(f.service.call("node.wallet", { channel: "distribution:resetStats", payload: {} }), /Confirm Reset Stats/);
    f.setApproved(false);
    await assert.rejects(f.service.call("node.wallet", { channel: "distribution:resetStats", payload: { confirmed: true } }), /Cancelled/);
    assert.equal(f.services.distribution.config().enabled, true);
    f.setApproved(true);
    const result = await f.service.call("node.wallet", { channel: "distribution:resetStats", payload: { confirmed: true } });
    assert.equal(result.config.enabled, false); assert.equal(result.derived.queue.payoutTotal, "0"); assert.equal(result.derived.queue.reburnOwed, "0");
    assert.equal(result.derived.trackingPaused, true);
    assert.equal(f.services.settings.get("distributionAuthorization"), null);
    assert.throws(() => f.services.distribution.authorize(), /wallet\/network/);
  } finally { await f.close(); }
});

test("distribution timer acquires shared spend authority and cannot sign after plugin disposal", async () => {
  const f = fixture(); let ready, release; const entered = new Promise(r => ready = r), gate = new Promise(r => release = r);
  try {
    f.services.distribution._tick = async () => { assert.equal(f.held, true); const signer = f.services.distribution.wallet.signer; ready(); await gate; return signer.signHash("synthetic digest"); };
    const pending = f.services.distribution.tick("timer"); await entered;
    const closing = f.service.dispose({ reason: "disable" }); release(); await assert.rejects(pending, /closing/); await closing;
    assert.equal(f.signatures, 0); assert.equal(f.services.distribution._timer, null);
    assert.equal(f.services.masterApi.disposed, true);
    await assert.rejects(f.services.masterApi.start(), /closing/);
  } finally { release(); await f.close(); }
});

test("manual distribution uses the same spend guard and cancellation invalidates its signer", async () => {
  const f = fixture(), controller = new AbortController(); let ready, release; const entered = new Promise(r => ready = r), gate = new Promise(r => release = r);
  try {
    f.services.distribution._tick = async () => { assert.equal(f.held, true); const signer = f.services.distribution.wallet.signer; ready(); await gate; return signer.signHash("synthetic digest"); };
    const pending = f.service.call("node.wallet", { channel: "distribution:distributeNow" }, controller.signal); await entered;
    controller.abort(); release(); await assert.rejects(pending); assert.equal(f.signatures, 0);
  } finally { release(); await f.close(); }
});

test("Node API requires native opt-in and plugin disposal releases its loopback listener", async () => {
  const f = fixture(), probe = http.createServer(); await new Promise(r => probe.listen(0, "127.0.0.1", r)); const port = probe.address().port; await new Promise(r => probe.close(r));
  try {
    f.setApproved(false); await assert.rejects(f.service.call("node.manage", { channel: "masterApi:configure", payload: { enabled: true, port } }), /Cancelled/);
    assert.equal(f.services.masterApi.status().listening, false); f.setApproved(true);
    const status = await f.service.call("node.manage", { channel: "masterApi:configure", payload: { enabled: true, port } });
    assert.equal(status.listening, true); assert.equal(status.bind, "127.0.0.1");
    await f.service.dispose(); assert.equal(f.services.masterApi.status().listening, false);
    await new Promise((resolve, reject) => probe.once("error", reject).listen(port, "127.0.0.1", resolve)); await new Promise(r => probe.close(r));
  } finally { probe.close(); await f.close(); }
});
