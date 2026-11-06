"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), os = require("node:os"), path = require("node:path"), http = require("node:http");
const full = require("./node-service-fixture");
const { createKoinosNode } = require("../plugin/service/core/lib/koinos-node");
const { Signer } = require("../plugin/service/node_modules/koilib");

function fixture() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "kai-master-integration-")));
  const address = Signer.fromSeed("master plugin isolated public fixture only").address;
  let services, approved = true, held = false, signatures = 0;
  const reviews = [], wallet = { address, status: () => ({ exists: true, address: wallet.address, unlocked: true }),
    get signer() { return { getAddress: () => wallet.address, signHash: async () => { signatures++; return "fixture signature"; } }; },
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

test("a full producer window survives API startup, writes and reconfiguration without blocking plugin reads", async () => {
  const f = fixture(), probe = http.createServer();
  await new Promise(r => probe.listen(0, "127.0.0.1", r)); const port = probe.address().port; await new Promise(r => probe.close(r));
  const root = path.join(f.dir, "koinos-node"), file = path.join(root, "master-producer-index.json");
  const id = height => "0x1220" + BigInt(height).toString(16).padStart(64, "0");
  const blocks = Array.from({ length: 28800 }, (_, i) => ({ height: 40000000 + i, timestamp: Date.now(), id: id(40000000 + i), previous: id(39999999 + i), signer: f.wallet.address }));
  const checkpoint = { version: 1, chainId: "fixture", blocks };
  fs.writeFileSync(file, JSON.stringify({ index: checkpoint }, null, 2));
  assert.ok(fs.statSync(file).size > 8 * 1024 * 1024);
  try {
    const start = () => f.service.call("node.manage", { channel: "masterApi:configure", payload: { enabled: true, port } });
    assert.equal((await start()).listening, true);
    const originalStore = f.services.masterApi.index.store;
    assert.equal(f.services.masterApi.index.blocks.length, 28800);
    originalStore.set("index", checkpoint);
    assert.equal((await start()).listening, true);
    assert.equal(f.services.masterApi.index.store, originalStore);
    f.services.masterApi.index.store.set("index", checkpoint);
    assert.equal((await f.service.call("node.read", { channel: "masterApi:status" })).listening, true);
    assert.equal((await f.service.call("node.read", { channel: "app:info" })).settings.masterApi.enabled, true);
    assert.equal(fs.readdirSync(root).filter(name => name.startsWith("master-producer-index.json.core-backup-")).length, 0);
    const local = await fetch(`http://127.0.0.1:${port}/v1/status`);
    assert.equal(local.status, 200);
    assert.equal((await local.json()).source, "Master KAI Koinos Node");
  } finally { await f.close(); }
});

test("an unreadable producer checkpoint is preserved and does not stop the API or plugin reads", async () => {
  const f = fixture(), probe = http.createServer();
  await new Promise(r => probe.listen(0, "127.0.0.1", r)); const port = probe.address().port; await new Promise(r => probe.close(r));
  const file = path.join(f.dir, "koinos-node", "master-producer-index.json"), original = "unreadable public checkpoint";
  fs.writeFileSync(file, original);
  try {
    const status = await f.service.call("node.manage", { channel: "masterApi:configure", payload: { enabled: true, port } });
    assert.equal(status.listening, true); assert.match(status.producerError, /Producer index unavailable.*unreadable/);
    assert.equal(fs.readFileSync(file, "utf8"), original);
    await f.service.call("node.read", { channel: "app:info" });
    assert.equal((await fetch(`http://127.0.0.1:${port}/v1/status`)).status, 200);
  } finally { await f.close(); }
});

async function prepareAirdrop(f, token = "koin") {
  const input = { token, mode: "amounts", text: Signer.fromSeed("airdrop native recipient").address + ",2" };
  const preview = await f.service.call("node.read", { channel: "airdrop:preview", payload: input });
  return f.service.call("node.wallet", { channel: "airdrop:create", payload: { ...input, fingerprint: preview.fingerprint } });
}
test("airdrop native review and password proof gate all transfers and hide secrets", async () => {
  const f = fixture(); try {
    const prepared = await prepareAirdrop(f), id = prepared.job.id; let sent = 0;
    f.services.chain.balances = async () => ({ koin: "500000000", vhp: "500000000" });
    f.services.chain.submitAirdrop = async (signer, row, record) => {
      assert.equal(f.held, true); await signer.signHash("synthetic"); await record({ txId: "airdrop-test", chainId: "chain", nonce: "nonce" }); sent++;
      return { txId: "airdrop-test", confirmed: true, blockNumber: 20 };
    };
    f.setApproved(false);
    await assert.rejects(f.service.call("node.wallet", { channel: "airdrop:run", payload: { id, password: "fixture proof" } }), /Cancelled/);
    assert.equal(sent, 0); f.setApproved(true);
    await assert.rejects(f.service.call("node.wallet", { channel: "airdrop:run", payload: { id, password: "bad" } }), /password/);
    assert.equal(sent, 0);
    await f.service.call("node.wallet", { channel: "airdrop:run", payload: { id, password: "fixture proof" } });
    assert.equal(sent, 1); assert.equal(f.signatures, 1);
    const review = f.reviews.at(-1).detail; assert.match(review, /remainingAmount/); assert.match(review, /recipientListFingerprint/); assert.doesNotMatch(review, /fixture proof/);
    assert.equal((await f.service.call("node.read", { channel: "airdrop:status" })).job.rows[0].status, "sent");
  } finally { await f.close(); }
});
test("airdrop pause remains available while spending; wallet mutation is blocked", async () => {
  const f = fixture(); try {
    const prepared = await prepareAirdrop(f, "vhp"), id = prepared.job.id;
    f.services.chain.balances = async () => ({ koin: "500000000", vhp: "500000000" });
    let release, entered;
    const reached = new Promise(resolve => { entered = resolve; });
    f.services.chain.submitAirdrop = async (signer, row, record) => {
      assert.equal(row.token, "vhp"); await record({ txId: "paused", chainId: "chain", nonce: "nonce" });
      entered(); await new Promise(resolve => { release = resolve; }); return { txId: "paused", confirmed: true, blockNumber: 20 };
    };
    const run = f.service.call("node.wallet", { channel: "airdrop:run", payload: { id, password: "fixture proof" } });
    await reached;
    await assert.rejects(f.service.call("node.wallet", { channel: "wallet:lock" }), /Wait/);
    await f.service.call("node.manage", { channel: "airdrop:pause" });
    assert.equal((await f.service.call("node.read", { channel: "airdrop:status" })).pauseRequested, true);
    release(); await run;
  } finally { await f.close(); }
});
test("airdrop refuses to compete with enabled reward distribution", async () => {
  const f = fixture(); try {
    const { job } = await prepareAirdrop(f);
    f.services.settings.set("distribution.enabled", true);
    await assert.rejects(f.service.call("node.wallet", { channel: "airdrop:run", payload: { id: job.id, password: "fixture proof" } }), /Pause distribution/);
    assert.equal(f.signatures, 0);
  } finally { await f.close(); }
});
