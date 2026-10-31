"use strict";
const crypto = require("node:crypto");
const { utils } = require("koilib");
const { formatAmount } = require("./format");
const { MAINNET_CHAIN } = require("../koin-network/payment-network");
const PAGE = 20, MAX_UINT = (1n << 64n) - 1n;
const id = v => typeof v === "string" && /^0x1220[a-f0-9]{64}$/.test(v);
const integer = v => typeof v === "string" && /^(0|[1-9][0-9]{0,19})$/.test(v) && BigInt(v) <= MAX_UINT;
const address = v => typeof v === "string" && v.length <= 40 && utils.isChecksumAddress(v);
const digest = value => crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");

// Read the known native-token event wire schemas strictly. A truncated amount,
// duplicate field or unrelated contract must never become a wallet movement.
function tokenEvent(data, transfer) {
  if (typeof data !== "string" || data.length > 1024 || !/^[A-Za-z0-9_=-]*$/.test(data)) throw Error("Invalid wallet event");
  const bytes = Buffer.from(data, "base64url"), fields = new Map(); let offset = 0;
  const varint = () => {
    let value = 0n;
    for (let n = 0; n < 10; n++) {
      if (offset >= bytes.length) throw Error("Truncated wallet event");
      const b = bytes[offset++]; value |= BigInt(b & 127) << BigInt(n * 7);
      if (!(b & 128)) { if (value > MAX_UINT) throw Error("Wallet amount overflow"); return value; }
    }
    throw Error("Invalid wallet amount");
  };
  while (offset < bytes.length) {
    const tag = varint(), field = Number(tag >> 3n), wire = Number(tag & 7n), amountField = transfer ? 3 : 2;
    if (field < 1 || field > amountField || fields.has(field)) throw Error("Invalid wallet event field");
    if (field === amountField) {
      if (wire !== 0) throw Error("Invalid wallet amount field");
      fields.set(field, varint().toString());
    } else {
      if (wire !== 2 || varint() !== 25n || offset + 25 > bytes.length) throw Error("Invalid wallet event address");
      const value = utils.encodeBase58(bytes.subarray(offset, offset + 25)); offset += 25;
      if (!address(value)) throw Error("Invalid wallet event checksum"); fields.set(field, value);
    }
  }
  if (!fields.has(1) || (transfer && !fields.has(2))) throw Error("Missing wallet event address");
  return { from: fields.get(1), to: transfer ? fields.get(2) : null, amount: fields.get(transfer ? 3 : 2) || "0" };
}
function evidence(entry) {
  const tx = entry.trx?.transaction, receipt = entry.trx?.receipt;
  if (tx) return digest([tx.id, tx.header, tx.operations, receipt?.id, receipt?.payer, receipt?.reverted, receipt?.events || []]);
  return digest(entry.block);
}
function normalize(entry, { account, contracts, chainId, tokenSymbol, confirmed }) {
  const tx = entry.trx?.transaction, block = entry.block, receipt = tx ? entry.trx?.receipt : block?.receipt;
  const objectId = tx?.id || block?.id || receipt?.id;
  if (!id(objectId) || !receipt || (receipt.id && receipt.id !== objectId) || ![undefined, false, true].includes(receipt.reverted)) throw Error("Invalid wallet history receipt");
  if (tx && tx.header?.chain_id !== chainId) throw Error("Wallet history chain mismatch");
  const events = receipt.events || [];
  if (!Array.isArray(events) || events.length > 1024) throw Error("Invalid wallet history events");
  const changes = [], counterparties = new Set(), seen = new Map(); let burned = false, minted = false, self = false;
  for (const event of events) {
    const asset = event.source === contracts.koin ? tokenSymbol : event.source === contracts.vhp ? "VHP" : null;
    const match = /^(?:token|koinos\.standards\.kcs4)\.(transfer|burn|mint)_event$/.exec(event.name || "");
    if (!asset || !match) continue;
    if (event.sequence != null && (!Number.isInteger(event.sequence) || event.sequence < 0 || event.sequence > 4294967295)) throw Error("Invalid wallet event sequence");
    const fingerprint = digest([event.source, event.name, event.data]), key = event.sequence == null ? fingerprint : String(event.sequence);
    if (seen.has(key)) { if (seen.get(key) !== fingerprint) throw Error("Conflicting wallet event sequence"); continue; } seen.set(key, fingerprint);
    const type = match[1], decoded = tokenEvent(event.data, type === "transfer");
    if (!BigInt(decoded.amount)) continue;
    const add = direction => changes.push({ asset, direction, amount: decoded.amount, formatted: formatAmount(decoded.amount, { grouping: false }) });
    if (type === "transfer") {
      if (decoded.from === account && decoded.to === account) { self = true; continue; }
      if (decoded.from === account) { add("out"); counterparties.add(decoded.to); }
      if (decoded.to === account) { add("in"); counterparties.add(decoded.from); }
    } else if (decoded.from === account) { add(type === "mint" ? "in" : "out"); burned ||= type === "burn"; minted ||= type === "mint"; }
  }
  const own = tx?.header?.payer === account || block?.header?.signer === account;
  if (!own && !changes.length && !self) return null;
  const failed = receipt.reverted === true, directions = new Set(changes.map(c => c.direction));
  let type = "transaction", label = "Transaction";
  if (failed) label = "Failed transaction";
  else if (block?.header?.signer === account && minted) { type = "reward"; label = "Block reward"; }
  else if (burned) { type = "burn"; label = changes.some(c => c.asset === tokenSymbol && c.direction === "out") && changes.some(c => c.asset === "VHP" && c.direction === "in") ? `${tokenSymbol} burned / VHP received` : "Token burn"; }
  else if (self) { type = "transfer"; label = "Self transfer"; }
  else if (directions.size > 1) { type = "transfer"; label = "Transfer"; }
  else if (directions.has("in")) { type = "received"; label = "Received"; }
  else if (directions.has("out")) { type = "sent"; label = "Sent"; }
  else if (minted) { type = "reward"; label = "Reward"; }
  const time = Number(block?.header?.timestamp), height = block?.header?.height;
  return { id: objectId, kind: tx ? "transaction" : "block", type, label,
    status: failed ? "failed" : confirmed ? "confirmed" : "confirming", timestamp: Number.isSafeInteger(time) && time > 0 ? time : null,
    height: integer(height) ? height : null, changes: failed ? [] : changes, counterparty: counterparties.size === 1 ? [...counterparties][0] : null };
}

class WalletHistory {
  constructor({ chain, wallet, clock = Date.now }) { this.chain = chain; this.wallet = wallet; this.clock = clock; this.cache = new Map(); this.pending = new Map(); }
  async read(input = {}) {
    if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some(k => k !== "cursor")) throw Error("Invalid wallet history request");
    const account = this.wallet.address || null, net = this.chain.network(), rpc = JSON.stringify(this.chain.rpcUrls());
    const context = () => { if (this.wallet.address !== account || this.chain.network().id !== net.id || JSON.stringify(this.chain.rpcUrls()) !== rpc) throw Error("Wallet or network changed; refresh transaction history."); };
    if (!account) return { address: null, network: net.id, tokenSymbol: net.tokenSymbol, observedAt: this.clock(), rows: [], nextCursor: null, available: true };
    if (!address(account)) throw Error("Invalid local wallet address");
    let cursor;
    if (input.cursor !== undefined && input.cursor !== null) {
      if (typeof input.cursor !== "string" || input.cursor.length > 300 || !/^[A-Za-z0-9_-]+$/.test(input.cursor)) throw Error("Invalid wallet history cursor");
      try { cursor = JSON.parse(Buffer.from(input.cursor, "base64url").toString()); } catch { throw Error("Invalid wallet history cursor"); }
      if (Object.keys(cursor || {}).sort().join() !== "address,network,seq" || cursor.address !== account || cursor.network !== net.id || !integer(cursor.seq)) throw Error("Wallet history cursor belongs to another wallet or network");
    }
    const key = digest([account, net.id, rpc, cursor?.seq || "latest"]), saved = this.cache.get(key);
    if (saved && this.clock() >= saved.observedAt && this.clock() - saved.observedAt < 15000) return structuredClone(saved);
    if (this.pending.has(key)) { const value = await this.pending.get(key); context(); return structuredClone(value); }
    if (this.pending.size >= 2) throw Error("Transaction history is already loading");
    const task = this.load({ account, net, cursor, context }); this.pending.set(key, task);
    try { const value = await task; context(); if (this.cache.size >= 8) this.cache.delete(this.cache.keys().next().value); this.cache.set(key, value); return structuredClone(value); }
    finally { this.pending.delete(key); }
  }
  async load({ account, net, cursor, context }) {
    const provider = this.chain.provider(), chainId = await provider.getChainId(); context();
    if (typeof chainId !== "string" || Buffer.from(chainId, "base64url").length !== 34 || (net.id === "mainnet") !== (chainId === MAINNET_CHAIN)) throw Error("Wallet history network mismatch");
    const [koin, vhp] = await Promise.all([provider.invokeGetContractAddress("koin"), provider.invokeGetContractAddress("vhp")]);
    const contracts = { koin: koin?.value?.address, vhp: vhp?.value?.address };
    if (!address(contracts.koin) || !address(contracts.vhp) || contracts.koin === contracts.vhp) throw Error("Native wallet tokens could not be verified");
    const params = { address: account, limit: PAGE, ascending: false, ...(cursor ? { seq_num: cursor.seq } : {}) };
    const [recent, final] = await Promise.all([false, true].map(irreversible => provider.call("account_history.get_account_history", { ...params, irreversible })));
    context();
    const read = value => {
      if (!value || typeof value !== "object" || value.error || value.rpc_error || (value.values !== undefined && !Array.isArray(value.values))) throw Error("Transaction history is unavailable");
      const rows = value.values || [];
      if (rows.length > PAGE || JSON.stringify(rows).length > 4000000 || rows.some(e => !integer(e.seq_num) || (cursor && BigInt(e.seq_num) > BigInt(cursor.seq)))) throw Error("Invalid wallet history page");
      return rows;
    };
    const entries = read(recent), confirmed = new Set(read(final).map(e => evidence(e))), rows = [], seen = new Set();
    for (const entry of entries) {
      const row = normalize(entry, { account, contracts, chainId, tokenSymbol: net.tokenSymbol, confirmed: confirmed.has(evidence(entry)) });
      if (row && !seen.has(row.id)) { seen.add(row.id); rows.push(row); }
    }
    // Dates are optional enrichment, never the source of confirmation. An
    // unavailable transaction/block store must not invent a date or height.
    try {
      const ids = rows.filter(r => r.kind === "transaction").map(r => r.id);
      if (ids.length) {
        const lookup = await provider.getTransactionsById(ids), txs = lookup?.transactions;
        if (!Array.isArray(txs) || txs.length > PAGE) throw Error("Invalid wallet transaction metadata");
        const blockIds = [...new Set(txs.flatMap(t => ids.includes(t.transaction?.id) && t.transaction?.header?.chain_id === chainId && Array.isArray(t.containing_blocks) && t.containing_blocks.length <= 4 ? t.containing_blocks.filter(id) : []))];
        if (blockIds.length) {
          const blocks = (await provider.getBlocksById(blockIds, { returnBlock: true, returnReceipt: false }))?.block_items;
          if (!Array.isArray(blocks) || blocks.length > PAGE * 4) throw Error("Invalid wallet block metadata");
          for (const row of rows) {
            const tx = txs.find(t => t.transaction?.id === row.id), candidates = blocks.filter(b => tx?.containing_blocks?.includes(b.block_id) && b.block?.id === b.block_id && b.block.transactions?.some(t => t.id === row.id && t.header?.chain_id === chainId));
            if (candidates.length !== 1) continue;
            const h = candidates[0].block.header, time = Number(h?.timestamp);
            if (integer(h?.height) && Number.isSafeInteger(time) && time > 0 && time <= this.clock() + 60000) { row.height = h.height; row.timestamp = time; }
          }
        }
      }
    } catch { /* Keep verified movement and confirmation; metadata stays unknown. */ }
    if (await provider.getChainId() !== chainId) throw Error("Wallet history chain changed"); context();
    const oldest = entries.length ? entries.reduce((n, e) => BigInt(e.seq_num) < n ? BigInt(e.seq_num) : n, MAX_UINT) : 0n;
    const nextCursor = entries.length === PAGE && oldest > 0n ? Buffer.from(JSON.stringify({ address: account, network: net.id, seq: String(oldest - 1n) })).toString("base64url") : null;
    return { address: account, network: net.id, tokenSymbol: net.tokenSymbol, observedAt: this.clock(), available: true, rows, nextCursor };
  }
}
module.exports = { WalletHistory, normalize, tokenEvent };
