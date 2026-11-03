"use strict";

const path = require("node:path");
const { utils } = require("koilib");
const { classifyEntry } = require("./koinos-events");
const { captureOperation } = require("./operation-lifetime");
const { MAINNET_CHAIN_ID } = require("./public-rpc");

// A display-only, bounded window. Never write into ProducerStats or the
// distribution/return journals: their lifetime baselines have different scope.
const WINDOW = 28800, PAGE = 100, PAGES = 4, MAX_AGE = 90000;
const hash = value => typeof value === "string" && /^0x1220[0-9a-f]{64}$/i.test(value);
const integer = value => Number.isSafeInteger(value) && value > 0;
const amount = value => typeof value === "string" && /^\d{1,30}$/.test(value);
const sameChain = (a, b) => typeof a === "string" && typeof b === "string" && Buffer.from(a, "base64").equals(Buffer.from(b, "base64"));

function header(item) {
  const h = item?.block?.header;
  const b = { height: Number(h?.height), id: item?.block_id, previous: h?.previous, time: Number(h?.timestamp) };
  if (!integer(b.height) || !integer(b.time) || !hash(b.id) || !hash(b.previous) ||
      item?.block?.id !== b.id || Number(item.block_height) !== b.height || !utils.isChecksumAddress(h?.signer || "")) {
    throw Error("Local block response is incomplete or inconsistent.");
  }
  return b;
}

function validCheckpoint(c) {
  if (!c || c.version !== 1 || !c.first || !c.last || !Array.isArray(c.records) || c.records.length > WINDOW) return false;
  for (const b of [c.first, c.last]) if (!integer(b.height) || !integer(b.time) || !hash(b.id) || !hash(b.previous)) return false;
  if (c.first.height > c.last.height || c.last.height - c.first.height >= WINDOW) return false;
  let prior = c.first.height - 1;
  for (const r of c.records) {
    if (r.type !== "block" || !integer(r.height) || r.height <= prior || r.height > c.last.height ||
        !hash(r.id) || !integer(r.time) || !amount(r.reward) || !amount(r.vhpBurned) ||
        r.profit !== (BigInt(r.reward) - BigInt(r.vhpBurned)).toString()) return false;
    prior = r.height;
  }
  return true;
}

class LocalProducerActivity {
  constructor({ chain, root, storeFactory, now = Date.now }) {
    Object.assign(this, { chain, root, storeFactory, now });
    this.store = null; this.checkpoint = null; this.identity = null;
    this.checkedAt = 0; this.error = null; this.target = 0; this.pending = null;
  }

  refresh(address) {
    const net = this.chain.network();
    const identity = JSON.stringify([net.id, net.localRpcUrl, address]);
    if (this.pending) return this.pending.identity === identity ? this.pending.work : Promise.resolve({ available: false, network: net.id, address, loading: true });
    const work = this._refresh(net, address, identity);
    this.pending = { identity, work };
    work.finally(() => { if (this.pending?.work === work) this.pending = null; }).catch(() => {});
    return work;
  }

  async _refresh(net, address, identity) {
    const active = captureOperation();
    if (this.identity !== identity) {
      this.identity = identity; this.checkpoint = null; this.checkedAt = 0; this.error = null; this.target = 0;
    }
    try {
      active();
      if (!utils.isChecksumAddress(address || "")) throw Error("Choose a producer wallet to read local rewards.");
      // Explicit loopback source; never the configured public/custom RPC.
      const provider = this.chain.provider([net.localRpcUrl]);
      const [chain, head, koin, vhp] = await Promise.all([
        provider.call("chain.get_chain_id", {}), provider.call("chain.get_head_info", {}),
        provider.invokeGetContractAddress("koin"), provider.invokeGetContractAddress("vhp"),
      ]);
      active();
      const chainId = chain?.chain_id, target = Number(head?.last_irreversible_block), height = Number(head?.head_topology?.height), headId = head?.head_topology?.id;
      const contracts = { koin: koin?.value?.address, vhp: vhp?.value?.address };
      if (!chainId || net.id === "mainnet" && !sameChain(chainId, MAINNET_CHAIN_ID)) throw Error("Local node is on a different chain.");
      if (!integer(target) || !integer(height) || target > height || !hash(headId) ||
          !utils.isChecksumAddress(contracts.koin || "") || !utils.isChecksumAddress(contracts.vhp || "")) throw Error("Local node is not ready to read confirmed rewards.");
      this.target = target;
      this.store ??= this.storeFactory(path.join(this.root, "master-dashboard-rewards.json"), {});
      const saved = this.checkpoint || this.store.get("activity", null);
      if (saved && !validCheckpoint(saved)) throw Error("Saved local reward cache needs review; original data was preserved.");
      let c = saved && saved.identity === identity && sameChain(saved.chainId, chainId) &&
        saved.contracts?.koin === contracts.koin && saved.contracts?.vhp === contracts.vhp ? structuredClone(saved) : null;
      const floor = Math.max(1, target - WINDOW + 1);

      const read = async (from, count, receipts = true) => {
        active();
        const data = await provider.call("block_store.get_blocks_by_height", { head_block_id: headId,
          ancestor_start_height: String(from), num_blocks: count, return_block: true, return_receipt: receipts });
        active();
        if (!Array.isArray(data?.block_items) || data.block_items.length !== count) throw Error("Local block history is still syncing or missing receipts.");
        const rows = data.block_items.map(item => ({ item, block: header(item) }));
        rows.forEach(({ block: b }, i) => {
          if (b.height !== from + i || b.time > this.now() + 300000 || i && b.previous !== rows[i-1].block.id) throw Error("Local block history has a gap or changed branch.");
        });
        return rows;
      };

      if (c && (c.last.height > target || c.last.height < floor || (await read(c.last.height, 1, false))[0].block.id !== c.last.id)) {
        // A restored/rewound node must not leave orphaned rewards in the feed.
        c = null; this.checkpoint = null; this.checkedAt = 0;
      }
      if (c && c.first.height < floor) {
        c.first = (await read(floor, 1, false))[0].block;
        c.records = c.records.filter(r => r.height >= floor);
      }
      const records = rows => rows.flatMap(({ item, block: b }) => {
        if (item.block.header.signer !== address) return [];
        const receipt = item.receipt;
        if (receipt?.id !== b.id || Number(receipt.height) !== b.height || !Array.isArray(receipt.events)) throw Error("A local reward receipt is missing; retrying without counting it.");
        const rec = classifyEntry({ block: { header: item.block.header, receipt } }, { address, contracts });
        if (!rec || !amount(rec.reward) || !amount(rec.vhpBurned) || BigInt(rec.reward) === 0n || BigInt(rec.vhpBurned) === 0n) throw Error("A local block reward could not be verified.");
        const { seqNum, ...value } = rec;
        return [{ ...value, id: b.id }];
      });
      let pages = 0;
      if (!c) {
        const from = Math.max(floor, target - PAGE + 1), rows = await read(from, target - from + 1);
        c = { version: 1, identity, chainId, contracts, first: rows[0].block, last: rows.at(-1).block, records: records(rows) };
        pages++;
      }
      let scanError = null;
      try {
        // Catch up new blocks before extending the window into older history.
        while (c.last.height < target && pages < PAGES) {
          const rows = await read(c.last.height + 1, Math.min(PAGE, target - c.last.height));
          if (rows[0].block.previous !== c.last.id) throw Error("Local block parent changed; retrying.");
          c.records.push(...records(rows)); c.last = rows.at(-1).block; pages++;
        }
        while (c.first.height > floor && pages < PAGES) {
          const from = Math.max(floor, c.first.height - PAGE), rows = await read(from, c.first.height - from);
          if (c.first.previous !== rows.at(-1).block.id) throw Error("Local block parent changed; retrying.");
          c.records.unshift(...records(rows)); c.first = rows[0].block; pages++;
        }
      } catch (error) {
        // A missing older page must not discard newer, already verified rewards.
        scanError = String(error.message || error);
      }
      active();
      if (JSON.stringify(c) !== JSON.stringify(saved)) this.store.set("activity", c);
      this.checkpoint = c; this.checkedAt = this.now(); this.error = scanError;
    } catch (error) {
      this.error = String(error.message || error);
    }
    return this.snapshot(net.id, address);
  }

  snapshot(network, address) {
    const c = this.checkpoint;
    const stale = !this.checkedAt || this.now() - this.checkedAt > MAX_AGE || !!this.error || !c || c.last.time < this.now() - 15 * 60000;
    const totals = { blocks: 0, rewards: "0", vhpConsumed: "0", profit: "0" };
    for (const r of c?.records || []) {
      totals.blocks++; totals.rewards = (BigInt(totals.rewards) + BigInt(r.reward)).toString();
      totals.vhpConsumed = (BigInt(totals.vhpConsumed) + BigInt(r.vhpBurned)).toString();
    }
    totals.profit = (BigInt(totals.rewards) - BigInt(totals.vhpConsumed)).toString();
    return { network, address, source: "local-chain", available: !!c, stale,
      error: this.error, checkedAt: this.checkedAt, fromHeight: c?.first.height || 0, throughHeight: c?.last.height || 0,
      fromTime: c?.first.time || 0, throughTime: c?.last.time || 0, finalizedHeight: this.target,
      catchingUp: !c || c.last.height !== this.target, windowComplete: !!c && c.first.height === Math.max(1, this.target - WINDOW + 1),
      totals, feed: [...(c?.records || [])].reverse().slice(0, 60) };
  }
}

module.exports = { LocalProducerActivity, validCheckpoint, WINDOW };
