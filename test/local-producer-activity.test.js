"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const { Signer, utils } = require("koilib");
const { LocalProducerActivity } = require("../plugin/service/core/lib/koinos/local-producer-activity");
const { GuardedStore } = require("../plugin/service/electron/plugin-services/guarded-store");
const { MAINNET_CHAIN_ID } = require("../plugin/service/core/lib/koinos/public-rpc");
const { NETWORKS } = require("../plugin/service/core/lib/koinos/constants");
const { runOperation } = require("../plugin/service/core/lib/koinos/operation-lifetime");
const { compose } = require("../plugin/dashboard-activity");
const ADDRESS = Signer.fromSeed("local dashboard synthetic producer").address;
const OTHER = Signer.fromSeed("local dashboard other synthetic producer").address;

function eventData(address, value) {
  const out = [10, 25, ...utils.decodeBase58(address), 16];
  let n = BigInt(value);
  while (n >= 128n) { out.push(Number(n & 127n) | 128); n >>= 7n; }
  out.push(Number(n)); return utils.encodeBase64url(Uint8Array.from(out));
}
function fixture(t, target = 400) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "master-local-rewards-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const f = { root, target, now: Date.now(), fork: 0, chainId: MAINNET_CHAIN_ID, own: new Set([390, 398, 400, 402]),
    calls: [], missing: null, badReceipt: null, broken: null, down: false, afterRead: () => {} };
  const id = h => "0x1220" + BigInt(h + f.fork * 10000000).toString(16).padStart(64, "0");
  f.provider = {
    invokeGetContractAddress: async name => ({ value: { address: NETWORKS.mainnet.contracts[name] } }),
    call: async (method, p) => {
      f.calls.push({ method, p });
      if (f.down) throw Error("fixture offline");
      if (method === "chain.get_chain_id") return { chain_id: f.chainId };
      if (method === "chain.get_head_info") return { head_topology: { height: String(f.target + 2), id: id(f.target + 2) }, last_irreversible_block: String(f.target) };
      assert.equal(method, "block_store.get_blocks_by_height");
      assert.ok(p.num_blocks <= 100);
      const from = Number(p.ancestor_start_height);
      if (f.missing != null && from <= f.missing && from + p.num_blocks > f.missing) return { block_items: [] };
      const block_items = Array.from({ length: p.num_blocks }, (_, i) => {
        const h = from + i, signer = f.own.has(h) ? ADDRESS : OTHER;
        const events = [{ source: NETWORKS.mainnet.contracts.vhp, name: "token.burn_event", data: eventData(signer, 400000000) },
          { source: NETWORKS.mainnet.contracts.koin, name: "token.mint_event", data: eventData(signer, 425000000) }];
        return { block_id: id(h), block_height: String(h), block: { id: id(h), header: { height: String(h),
          previous: f.broken === h ? id(1) : id(h-1), signer, timestamp: String(f.now - (f.target-h) * 3000) } },
          ...(p.return_receipt && f.badReceipt !== h ? { receipt: { id: id(h), height: String(h), events } } : {}) };
      });
      f.afterRead(); return { block_items };
    },
  };
  const chain = { network: () => NETWORKS.mainnet, provider: urls => { assert.deepEqual(urls, ["http://127.0.0.1:8085"]); return f.provider; } };
  const storeFactory = file => { assert.equal(path.basename(file), "master-dashboard-rewards.json"); return new GuardedStore(file, { maxBytes: 16 * 1024 * 1024, backup: false }); };
  f.open = () => new LocalProducerActivity({ chain, root, storeFactory, now: () => f.now });
  f.activity = f.open(); f.file = path.join(root, "master-dashboard-rewards.json");
  return f;
}

test("local finalized receipts update without an account-history service or public API", async t => {
  const f = fixture(t), result = await f.activity.refresh(ADDRESS);
  assert.equal(result.available, true, result.error); assert.equal(result.stale, false, result.error); assert.equal(result.windowComplete, true);
  assert.equal(result.throughHeight, 400); assert.equal(result.totals.blocks, 3);
  assert.equal(result.totals.rewards, "1275000000"); assert.equal(result.totals.vhpConsumed, "1200000000");
  assert.equal(result.totals.profit, "75000000"); assert.deepEqual(result.feed.map(r => r.height), [400, 398, 390]);
  assert.ok(f.calls.every(c => !c.method.startsWith("account_history")));
});

test("polls, restart and finality advancement count each block once", async t => {
  const f = fixture(t); await f.activity.refresh(ADDRESS);
  assert.equal((await f.activity.refresh(ADDRESS)).totals.blocks, 3);
  f.activity = f.open(); assert.equal((await f.activity.refresh(ADDRESS)).totals.blocks, 3);
  f.target = 402;
  assert.equal((await f.activity.refresh(ADDRESS)).totals.blocks, 4);
  assert.equal((await f.activity.refresh(ADDRESS)).totals.blocks, 4);
  assert.deepEqual(fs.readdirSync(f.root), ["master-dashboard-rewards.json"]);
});

test("a missing old page preserves verified new rewards and resumes backfill", async t => {
  const f = fixture(t, 800); f.own = new Set([798, 799]); f.missing = 650;
  let result = await f.activity.refresh(ADDRESS);
  assert.equal(result.available, true); assert.equal(result.stale, true); assert.equal(result.windowComplete, false);
  assert.equal(result.fromHeight, 701); assert.equal(result.totals.blocks, 2);
  f.missing = null; result = await f.activity.refresh(ADDRESS);
  assert.equal(result.stale, false); assert.equal(result.totals.blocks, 2); assert.ok(result.fromHeight < 701);
});

test("missing receipts, broken parents and offline reads cannot become zero rewards or fresh data", async t => {
  const f = fixture(t); await f.activity.refresh(ADDRESS); f.target = 402; f.badReceipt = 402;
  let result = await f.activity.refresh(ADDRESS);
  assert.equal(result.stale, true); assert.equal(result.throughHeight, 400); assert.equal(result.totals.blocks, 3);
  f.badReceipt = null; f.broken = 402;
  result = await f.activity.refresh(ADDRESS); assert.equal(result.stale, true); assert.equal(result.throughHeight, 400);
  f.broken = null; result = await f.activity.refresh(ADDRESS); assert.equal(result.totals.blocks, 4);
  f.down = true; result = await f.activity.refresh(ADDRESS);
  assert.equal(result.stale, true); assert.equal(result.totals.blocks, 4);
});

test("a changed canonical checkpoint removes orphaned local rewards", async t => {
  const f = fixture(t); await f.activity.refresh(ADDRESS); f.fork = 1; f.own.clear();
  const result = await f.activity.refresh(ADDRESS);
  assert.equal(result.stale, false); assert.equal(result.totals.blocks, 0); assert.deepEqual(result.feed, []);
});

test("wallet and chain identity changes cannot reuse another producer's fresh results", async t => {
  const f = fixture(t); await f.activity.refresh(ADDRESS);
  f.chainId = Buffer.from("foreign chain").toString("base64");
  const wrong = await f.activity.refresh(ADDRESS); assert.equal(wrong.stale, true); assert.match(wrong.error, /different chain/);
  f.down = true;
  const other = await f.activity.refresh(OTHER); assert.equal(other.available, false); assert.equal(other.totals.blocks, 0);
});

test("cancellation and corrupt cache preserve the existing files", async t => {
  const f = fixture(t); await f.activity.refresh(ADDRESS); const before = fs.readFileSync(f.file);
  let active = true; f.afterRead = () => { active = false; };
  await runOperation(() => { if (!active) throw Error("fixture cancelled"); }, () => f.activity.refresh(ADDRESS));
  assert.deepEqual(fs.readFileSync(f.file), before);
  fs.writeFileSync(f.file, "unreadable fixture"); f.activity = f.open();
  const result = await f.activity.refresh(ADDRESS);
  assert.equal(result.available, false); assert.equal(fs.readFileSync(f.file, "utf8"), "unreadable fixture");
});

test("a long offline gap starts a bounded recent window rather than replaying lifetime history", async t => {
  const f = fixture(t); await f.activity.refresh(ADDRESS); f.target = 60000; f.own.add(59999); f.calls.length = 0;
  const result = await f.activity.refresh(ADDRESS);
  assert.equal(result.totals.blocks, 1); assert.equal(result.throughHeight, 60000); assert.equal(result.fromHeight, 59601);
  assert.ok(f.calls.filter(c => c.method.startsWith("block_store")).length <= 4);
});

test("display merges history by block height without changing payout totals", async t => {
  const f = fixture(t), local = await f.activity.refresh(ADDRESS);
  const dashboard = { network: { id: "mainnet" }, wallet: { address: ADDRESS }, stats: { available: true,
    totals: { rewards: "old financial baseline" }, feed: [{ type: "block", height: 398 }, { type: "block", height: 402 }] } };
  const before = JSON.stringify(dashboard);
  const view = compose(dashboard, local);
  assert.deepEqual(view.feed.map(r => r.height), [400, 398, 390]);
  assert.equal(JSON.stringify(dashboard), before);
  dashboard.stats.feed = [{ type: "block", height: 370 }];
  assert.equal(compose(dashboard, local).historyBehind, true);
  dashboard.stats.feed = local.feed;
  assert.equal(compose(dashboard, local).feed.length, 3);
  dashboard.wallet.address = OTHER;
  assert.equal(compose(dashboard, local).local, null);
});
