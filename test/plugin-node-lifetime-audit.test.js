"use strict";
// Independent regression coverage for the native Node operation boundary.
// Every provider below is synthetic; no wallet profile, RPC or subprocess is used.
const test = require("node:test");
const assert = require("node:assert/strict");
const { ethers } = require("../plugin/service/node_modules/ethers");
const { runOperation, captureOperation, createEvmWallet, guardKoinosProvider } = require("../plugin/service/core/lib/koinos/operation-lifetime");
const KEY = "0x" + "11".repeat(32);
const TO = "0x" + "22".repeat(20);
const TX = { to: TO, value: 1n, nonce: 0, gasLimit: 21000n, gasPrice: 1n, chainId: 1, type: 0 };
function deferred() { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; }
function lease() { let live = true; return { assert() { if (!live) throw Error("synthetic operation cancelled"); }, cancel() { live = false; } }; }
function provider(overrides = {}) {
  return { getNetwork: async () => ({ chainId: 1n }), getTransactionCount: async () => 0,
    getFeeData: async () => ({ gasPrice: 1n, maxFeePerGas: null, maxPriorityFeePerGas: null }),
    estimateGas: async () => 21000n, resolveName: async () => TO,
    broadcastTransaction: async bytes => ({ hash: ethers.Transaction.from(bytes).hash }), ...overrides };
}
test("standalone EVM callers retain original signing when no broker scope is installed", async () => {
  const wallet = createEvmWallet(KEY, provider());
  const signed = await wallet.signTransaction(TX);
  assert.equal(ethers.Transaction.from(signed).from, wallet.address);
});
test("EVM signing rechecks cancellation after asynchronous ENS resolution", async () => {
  const entered = deferred(), released = deferred(), scope = lease();
  await runOperation(scope.assert, async () => {
    const wallet = createEvmWallet(KEY, provider({ resolveName: async () => { entered.resolve(); await released.promise; return TO; } }));
    const pending = wallet.signTransaction({ ...TX, to: "synthetic.eth" });
    await entered.promise; scope.cancel(); released.resolve();
    await assert.rejects(pending, /cancelled/);
  });
});
test("EVM population cannot sign or broadcast after the requesting window closes", async () => {
  const entered = deferred(), released = deferred(), scope = lease(); let submissions = 0;
  await runOperation(scope.assert, async () => {
    const wallet = createEvmWallet(KEY, provider({ getTransactionCount: async () => { entered.resolve(); await released.promise; return 0; }, broadcastTransaction: async () => { submissions++; } }));
    const { nonce, ...tx } = TX;
    const pending = wallet.sendTransaction(tx);
    await entered.promise; scope.cancel(); released.resolve();
    await assert.rejects(pending, /cancelled/); assert.equal(submissions, 0);
  });
});
test("a cancellation after EVM signing still prevents the provider broadcast", async () => {
  const scope = lease(); let submissions = 0;
  await runOperation(scope.assert, async () => {
    const wallet = createEvmWallet(KEY, provider({ broadcastTransaction: async () => { submissions++; } }));
    const sign = wallet.signTransaction.bind(wallet);
    wallet.signTransaction = async input => { const bytes = await sign(input); scope.cancel(); return bytes; };
    await assert.rejects(wallet.sendTransaction(TX), /cancelled/); assert.equal(submissions, 0);
  });
});
test("cached Route C wallets accept fresh background leases without reviving a closed window lease", async () => {
  const windowScope = lease(), backgroundScope = lease(), entered = deferred(), released = deferred(); let wallet;
  const oldRequest = runOperation(windowScope.assert, async () => {
    wallet = createEvmWallet(KEY, provider()); entered.resolve(); await released.promise;
    return wallet.signTransaction(TX);
  });
  await entered.promise; windowScope.cancel();
  const freshSigned = await runOperation(backgroundScope.assert, () => wallet.signTransaction(TX));
  assert.equal(ethers.Transaction.from(freshSigned).from, wallet.address);
  released.resolve(); await assert.rejects(oldRequest, /cancelled/);
  await assert.rejects(wallet.signTransaction(TX), /outside its approved operation/);
});
test("captured post-await authorization retains its own operation and never inherits a later review", async () => {
  const first = lease(), second = lease(); let guard;
  await runOperation(first.assert, async () => { guard = captureOperation(); await Promise.resolve(); });
  first.cancel();
  await runOperation(second.assert, async () => { assert.throws(guard, /cancelled/); captureOperation()(); });
});
test("raw Koinos providers recheck before submit after asynchronous preparation", async () => {
  const scope = lease(), entered = deferred(), released = deferred(); let submissions = 0;
  await runOperation(scope.assert, async () => {
    const raw = { async sendTransaction(tx) { entered.resolve(); await released.promise; return this.call("chain.submit_transaction", { transaction: tx }); }, async call() { submissions++; return {}; } };
    const guarded = guardKoinosProvider(raw), pending = guarded.sendTransaction({ id: "synthetic" });
    await entered.promise; scope.cancel(); released.resolve();
    await assert.rejects(pending, /cancelled/); assert.equal(submissions, 0);
  });
});
test("Koinos RPC failover cannot retry a submission after operation cancellation", async () => {
  const scope = lease(); let attempts = 0;
  await runOperation(scope.assert, async () => {
    const raw = { async sendTransaction() { attempts++; scope.cancel(); this.onError(Error("synthetic RPC failed")); attempts++; }, onError() { return false; } };
    await assert.rejects(guardKoinosProvider(raw).sendTransaction({}), /cancelled/); assert.equal(attempts, 1);
  });
});
test("queued ethers JSON-RPC broadcasts cannot drain after the operation is cancelled", async () => {
  const scope = lease(); let submissions = 0;
  // Exercise ethers' real async startup and batching, replacing only HTTP _send.
  const raw = new ethers.JsonRpcProvider("http://127.0.0.1:1", 1, { staticNetwork: true, batchStallTime: 30 });
  raw._send = async payload => (Array.isArray(payload) ? payload : [payload]).map(row => {
    if (row.method === "eth_sendRawTransaction") submissions++;
    return { id: row.id, jsonrpc: "2.0", result: row.method === "eth_sendRawTransaction" ? ethers.Transaction.from(row.params[0]).hash : row.method === "eth_blockNumber" ? "0x1" : "0x1" };
  });
  try {
    await runOperation(scope.assert, async () => {
      const wallet = createEvmWallet(KEY, raw), signed = await wallet.signTransaction(TX);
      const pending = wallet.provider.broadcastTransaction(signed);
      await new Promise(resolve => setTimeout(resolve, 5)); scope.cancel();
      await assert.rejects(pending, /cancelled/); assert.equal(submissions, 0);
    });
  } finally { raw.destroy(); }
});
test("fresh background transactions survive an ethers batch first scheduled by a closed window", async () => {
  const oldWindow = lease(), background = lease(); let wallet, submissions = 0;
  const raw = new ethers.JsonRpcProvider("http://127.0.0.1:1", 1, { staticNetwork: true, batchStallTime: 30 });
  raw._send = async payload => (Array.isArray(payload) ? payload : [payload]).map(row => {
    if (row.method === "eth_sendRawTransaction") submissions++;
    return { id: row.id, jsonrpc: "2.0", result: row.method === "eth_sendRawTransaction" ? ethers.Transaction.from(row.params[0]).hash : "0x1" };
  });
  try {
    const initialRead = runOperation(oldWindow.assert, () => { wallet = createEvmWallet(KEY, raw); return raw.getBlockNumber(); });
    await new Promise(resolve => setTimeout(resolve, 5)); oldWindow.cancel();
    const result = await runOperation(background.assert, async () => wallet.provider.broadcastTransaction(await wallet.signTransaction(TX)));
    await initialRead; assert.equal(result.hash.length, 66); assert.equal(submissions, 1);
  } finally { raw.destroy(); }
});
test("Ethereum HTTP transport checks the captured transaction lease after a delayed connection", async () => {
  const scope = lease(), entered = deferred(), released = deferred(); let submissions = 0;
  const raw = provider({
    _getConnection() { return { getUrlFunc: async () => { submissions++; return {}; } }; },
    async broadcastTransaction(bytes) { const request = this._getConnection(); request.body = Buffer.from(JSON.stringify({ method: "eth_sendRawTransaction", params: [bytes] })); entered.resolve(); await released.promise; return request.getUrlFunc(request); },
  });
  await runOperation(scope.assert, async () => {
    const wallet = createEvmWallet(KEY, raw), pending = wallet.provider.broadcastTransaction(await wallet.signTransaction(TX));
    await entered.promise; scope.cancel(); released.resolve();
    await assert.rejects(pending, /cancelled/); assert.equal(submissions, 0);
  });
});
test("Core's actual Koinos failover provider cannot send to a fallback after cancellation", async () => {
  const { createProvider } = require("../plugin/service/core/lib/koinos-rpc"); const scope = lease(); let submissions = 0;
  await runOperation(scope.assert, async () => {
    const raw = createProvider(["https://first.invalid", "https://second.invalid"], { fetchImpl: async () => { submissions++; scope.cancel(); throw Error("synthetic disconnected RPC"); } });
    await assert.rejects(guardKoinosProvider(raw).call("chain.submit_transaction", { transaction: { id: "synthetic" } }), /cancelled/);
    assert.equal(submissions, 1);
  });
});
test("both original sponsor relayers block a cancelled signed transaction before POST", async () => {
  const { coSignAndBroadcast } = require("../plugin/service/core/lib/koinos/sponsor-relay"), { BridgeOrchestrator } = require("../plugin/service/core/lib/koinos/bridge-orchestrator");
  const settings = { get: () => "" }, bridge = new BridgeOrchestrator({ settings }), originalFetch = global.fetch; let submissions = 0;
  global.fetch = async (_url, options) => { assert.equal(options.method, "POST"); submissions++; return { ok: true, json: async () => ({ ok: true, id: "synthetic" }) }; };
  try {
    for (const submit of [() => coSignAndBroadcast(settings, "fixture", { id: "signed-synthetic" }), () => bridge._coSignAndBroadcast({ id: "signed-synthetic" })]) {
      const scope = lease();
      await runOperation(scope.assert, async () => { await Promise.resolve(); scope.cancel(); await assert.rejects(submit(), /cancelled/); });
      assert.equal(submissions, 0);
    }
    await runOperation(lease().assert, () => coSignAndBroadcast(settings, "fixture", { id: "signed-synthetic" }));
    assert.equal(submissions, 1);
  } finally { global.fetch = originalFetch; }
});
test("Koin Vault preserves the prepared draft when cancelled during status and accepts a fresh review", async () => {
  const { ProducerVault } = require("../plugin/service/core/lib/koinos/producer-vault"); const scope = lease(), entered = deferred(), released = deferred(); let requests = 0;
  const now = 1700000000000, address = "synthetic-external-producer";
  const vault = new ProducerVault({ custody: { config: () => ({ address }), requireExternal() {} }, chain: { network: () => ({ id: "mainnet" }) }, now: () => now,
    request: async route => { assert.equal(route, "dapp/request"); requests++; return { requestId: "r".repeat(24), expiresAt: now + 60000 }; } });
  vault.session = { sessionId: "fixture", secret: "synthetic-only", address, expiresAt: now + 120000 };
  vault.draft = { id: "draft", summary: { producer: address, network: "mainnet", action: "send", amount: "2", to: "recipient" }, operations: [], expiresAt: now + 60000 };
  vault.status = async () => { entered.resolve(); await released.promise; return vault.view(); };
  await runOperation(scope.assert, async () => {
    const pending = vault.send({ confirm: true, draftId: "draft" });
    await entered.promise; scope.cancel(); released.resolve();
    await assert.rejects(pending, /cancelled/); assert.equal(requests, 0); assert.equal(vault.draft.id, "draft"); assert.equal(vault.pending, null);
  });
  await runOperation(lease().assert, () => vault.send({ confirm: true, draftId: "draft" }));
  assert.equal(requests, 1); assert.equal(vault.pending.status, "pending");
});
test("the actual Node broker gives configured rewards and supervision fresh leases after window close under AI Local-Only", async () => {
  const fs = require("node:fs"), os = require("node:os"), path = require("node:path"), { AsyncResource } = require("node:async_hooks");
  const full = require("./node-service-fixture"), dir = fs.mkdtempSync(path.join(os.tmpdir(), "kai-node-background-audit-"));
  const controller = new AbortController(); let timerResource, configured, supervised = 0, signed = 0, spending = 0;
  const settings = { all: () => ({ network: "mainnet" }), get: (key, fallback) => key === "network" ? "mainnet" : fallback };
  const wallet = { status: () => ({ address: "synthetic-local-wallet", exists: true, unlocked: true }), signer: { signHash: async () => { signed++; return "synthetic-signature"; } } };
  const service = full.create({ dataDir: dir, core: { account: { wallet }, gateway: { network: { status: () => ({ privacyMode: "local-only" }) } } }, electron: {}, confirm: async () => true,
    withWalletSpend: async run => { spending++; return run(); } }, { createEngine(options) {
    const nodeMgr = { intentPath: path.join(options.dataDir, "koinos-node", "node-supervisor.json"), _intent: {}, ensureFiles() {}, dirs: () => ({ root: path.join(options.dataDir, "node") }),
      async _watchTick() { captureOperation()(); supervised++; } };
    const rewards = { stop() {}, start() {}, async tick() { return options.wallet.signer.signHash("synthetic-hash"); } };
    configured = { settings, state: {}, chain: { network: () => ({ id: "mainnet" }), provider: () => ({}) }, nodeMgr, setup: {}, rewards, bridge: { status: () => null }, routeC: { status: () => null } };
    options.configureServices(configured);
    return { settings, nodeMgr, stop() {}, async call() { timerResource = new AsyncResource("synthetic-original-node-timer"); return { started: true }; } };
  } });
  try {
    await service.call("node.manage", { channel: "node:start", payload: { produce: true } }, controller.signal);
    controller.abort(); // PluginHost closes only the window, retaining this service.
    await timerResource.runInAsyncScope(() => configured.nodeMgr._watchTick());
    await timerResource.runInAsyncScope(() => configured.rewards.tick("timer"));
    assert.equal(supervised, 1); assert.equal(signed, 1); assert.equal(spending, 1);
  } finally { timerResource?.emitDestroy(); await service.dispose({ reason: "quit" }); fs.rmSync(dir, { recursive: true, force: true }); }
});
