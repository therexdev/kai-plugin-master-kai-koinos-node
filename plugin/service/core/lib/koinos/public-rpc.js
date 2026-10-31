"use strict";

// Public blockchain transport only. This module never receives a wallet,
// signer, Core route, Docker manager or arbitrary destination URL from callers.
const { utils } = require("koilib");
const metadata = require("./metadata-fallback");
const MAINNET_CHAIN_ID = "EiBZK_GGVP0H_fXVAM3j6EAuz3-B-l3ejxRSewi7qIBfSA==";
const MAX_BODY = 2 * 1024 * 1024, MAX_RESPONSE = 8 * 1024 * 1024;
const MAX_BATCH = 10, MAX_INFLIGHT = 4, CALLS_PER_SECOND = 30;
const LOCAL_ERROR = Symbol("local RPC error");
const SYSTEM_READS = Object.freeze({
  get_head_info: 1, get_chain_id: 12, get_last_irreversible_block: 106,
  get_account_nonce: 107, get_contract_metadata: 112, get_account_rc: 201,
  get_resource_limits: 203, get_object: 303, get_next_object: 304,
  get_prev_object: 305, get_contract_name: 10000, get_contract_address: 10001,
});
const OPTIONAL = Object.freeze({
  "account_history.get_account_history": "account_history",
  "transaction_store.get_transactions_by_id": "transaction_store",
  "contract_meta_store.get_contract_meta": "contract_meta_store",
});
const plain = v => v !== null && typeof v === "object" && !Array.isArray(v);
const own = (v, key) => Object.hasOwn(v, key);
const fail = (message, code = -32602) => { throw Object.assign(new Error(message), { rpcCode: code }); };
function fields(p, keys) {
  if (!plain(p) || Object.keys(p).some(k => !keys.includes(k))) fail("Unexpected RPC parameters");
}
function uint(v, max = 18446744073709551615n) {
  if (!(typeof v === "string" && /^(0|[1-9]\d{0,19})$/.test(v)) && !(Number.isSafeInteger(v) && v >= 0)) fail("Expected an unsigned integer");
  if (BigInt(v) > BigInt(max)) fail("RPC quantity exceeds limit");
}
function address(v) { if (typeof v !== "string" || !utils.isChecksumAddress(v)) fail("Invalid Koinos address"); }
function bytes(v, max = 128 * 1024, empty = true) {
  if (typeof v !== "string" || v.length > max || (!empty && !v.length) || !/^[A-Za-z0-9_+/\-]*={0,2}$/.test(v)) fail("Invalid encoded bytes");
}
function hash(v) { if (typeof v !== "string" || !/^0x[0-9a-fA-F]{68}$/.test(v)) fail("Invalid block or transaction ID"); }
function list(v, check, max = 100) { if (!Array.isArray(v) || !v.length || v.length > max) fail("RPC list must contain 1–" + max + " items"); v.forEach(check); }
function flags(p, names) { for (const n of names) if (own(p, n) && typeof p[n] !== "boolean") fail("Expected a boolean: " + n); }
function sameChain(value) {
  return typeof value === "string" && /^[A-Za-z0-9_+/\-]+={0,2}$/.test(value) &&
    Buffer.from(value, "base64").equals(Buffer.from(MAINNET_CHAIN_ID, "base64"));
}
const VALIDATORS = Object.freeze({
  "chain.get_chain_id": p => fields(p, []),
  "chain.get_head_info": p => fields(p, []),
  "chain.get_fork_heads": p => fields(p, []),
  "chain.get_resource_limits": p => fields(p, []),
  "block_store.get_highest_block": p => fields(p, []),
  "chain.get_account_nonce": p => { fields(p, ["account"]); address(p.account); },
  "chain.get_account_rc": p => { fields(p, ["account"]); address(p.account); },
  "chain.read_contract": p => { fields(p, ["contract_id", "entry_point", "args"]); address(p.contract_id); uint(p.entry_point, 4294967295); bytes(p.args ?? ""); },
  "chain.invoke_system_call": p => {
    fields(p, ["id", "name", "args", "caller_data"]);
    if (own(p, "id") === own(p, "name")) fail("Choose one system-call name or ID");
    if (own(p, "id")) uint(p.id, 4294967295);
    if (own(p, "name") ? typeof p.name !== "string" || !own(SYSTEM_READS, p.name) : !Object.values(SYSTEM_READS).some(id => String(id) === String(p.id))) fail("System call is not a permitted public read");
    bytes(p.args ?? "");
    if (p.caller_data != null) { fields(p.caller_data, ["caller", "caller_privilege"]); address(p.caller_data.caller); uint(p.caller_data.caller_privilege, 1); }
  },
  "block_store.get_blocks_by_height": p => {
    fields(p, ["head_block_id", "ancestor_start_height", "num_blocks", "return_block", "return_receipt"]);
    hash(p.head_block_id); uint(p.ancestor_start_height); uint(p.num_blocks, 100);
    if (Number(p.num_blocks) < 1) fail("num_blocks must be at least 1"); flags(p, ["return_block", "return_receipt"]);
  },
  "block_store.get_blocks_by_id": p => { fields(p, ["block_ids", "return_block", "return_receipt"]); list(p.block_ids, hash); flags(p, ["return_block", "return_receipt"]); },
  "transaction_store.get_transactions_by_id": p => { fields(p, ["transaction_ids"]); list(p.transaction_ids, hash); },
  "contract_meta_store.get_contract_meta": p => { fields(p, ["contract_id"]); address(p.contract_id); },
  "account_history.get_account_history": p => {
    fields(p, ["address", "seq_num", "limit", "ascending", "irreversible"]); address(p.address);
    uint(p.limit, 100); if (Number(p.limit) < 1) fail("limit must be at least 1");
    if (own(p, "seq_num")) uint(p.seq_num); flags(p, ["ascending", "irreversible"]);
  },
  "chain.submit_transaction": p => {
    fields(p, ["transaction", "broadcast"]); flags(p, ["broadcast"]);
    const tx = p.transaction; fields(tx, ["id", "header", "operations", "signatures"]); hash(tx.id);
    if (!plain(tx.header) || !sameChain(tx.header.chain_id)) fail("A signed Mainnet transaction is required");
    list(tx.operations, op => { if (!plain(op)) fail("Invalid transaction operation"); });
    list(tx.signatures, s => bytes(s, 512, false), 64);
    // Signature, nonce, mana and operation validity are checked by the node.
    // Forward this signed transaction unchanged; never retry or re-sign it.
  },
});

function error(id, code, message, data) {
  const reply = { jsonrpc: "2.0", id, error: { code, message, ...(data === undefined ? {} : { data }) } };
  return Object.defineProperty(reply, LOCAL_ERROR, { value: true });
}
async function boundedJson(response, limit = MAX_RESPONSE) {
  if (Number(response.headers.get("content-length")) > limit) { await response.body?.cancel(); throw new Error("Oversize RPC response"); }
  const reader = response.body.getReader(), chunks = []; let size = 0;
  try {
    for (;;) { const { value, done } = await reader.read(); if (done) break; size += value.byteLength;
      if (size > limit) throw new Error("Oversize RPC response"); chunks.push(Buffer.from(value)); }
  } finally { await reader.cancel().catch(() => {}); }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

class PublicRpc {
  constructor({ url, fetchImpl = fetch, signal, network, optionalServices = () => false, metadataFallback = () => true, now = Date.now, timeoutMs = 8000 }) {
    Object.assign(this, { url, fetchImpl, signal, network, optionalServices, now, timeoutMs });
    this.health = null; this.inflight = 0; this.windowAt = now(); this.calls = 0;
    this.metadata = new metadata.MetadataFallback({ now, sameChain,
      enabled: () => this.optionalServices() && metadataFallback(),
      call: (url, method, params, signal) => this.upstream(method, params, signal, 1,
        { url, timeoutMs: Math.min(timeoutMs, metadata.TIMEOUT_MS), limit: metadata.MAX_RESPONSE }) });
  }
  status() {
    const h = this.health;
    return { ready: !!(h?.ready && this.network() === "mainnet" && !this.signal?.aborted && this.now() - h.checked_at < 15000),
      chain_id: h?.chain_id || null, head_height: h?.head_height || 0, checked_at: h?.checked_at || null,
      error: h?.error || null, optional_indexes_enabled: this.optionalServices(),
      metadata_fallback: this.metadata.status(),
      methods: Object.keys(VALIDATORS).filter(m => !own(OPTIONAL, m) || this.optionalServices()) };
  }
  async upstream(method, params, signal, id = 1, { url = this.url, timeoutMs = this.timeoutMs, limit = MAX_RESPONSE } = {}) {
    const signals = [AbortSignal.timeout(timeoutMs), this.signal, signal].filter(Boolean);
    const res = await this.fetchImpl(url, { method: "POST", redirect: "error", signal: AbortSignal.any(signals),
      headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id, method, params }) });
    if (!res.ok) { await res.body?.cancel(); throw new Error("Local RPC HTTP failure"); }
    const data = await boundedJson(res, limit);
    if (!plain(data) || data.jsonrpc !== "2.0" || data.id !== id || own(data, "result") === own(data, "error") ||
        (own(data, "error") && (!plain(data.error) || !Number.isInteger(data.error.code) || typeof data.error.message !== "string"))) throw new Error("Invalid RPC response");
    return data;
  }
  async contractMetadata(params, signal, id) {
    const deadline = AbortSignal.any([AbortSignal.timeout(10000), this.signal, signal].filter(Boolean));
    let local;
    try {
      local = await this.upstream(metadata.METHOD, params, deadline, id,
        { timeoutMs: Math.min(this.timeoutMs, 1800), limit: metadata.MAX_RESPONSE });
    } catch { /* A missing/unavailable local index can use the read-only backups. */ }
    deadline.throwIfAborted();
    if (local && !local.error && metadata.metadataState(local.result) === "found") {
      this.metadata.forget(params.contract_id); this.metadata.record("local", "found"); return local;
    }
    if (!this.metadata.enabled()) {
      this.metadata.record("local", local && !local.error && metadata.metadataState(local.result) === "empty" ? "not_found" : "unavailable");
      if (local && (local.error || metadata.metadataState(local.result) === "empty")) return local;
      throw new Error("Local contract metadata unavailable");
    }
    try {
      const result = await this.metadata.lookup(params.contract_id, deadline);
      return { jsonrpc: "2.0", id, result };
    } catch {
      this.metadata.record(null, "unavailable");
      return error(id, -32002, "Contract metadata unavailable; retry or use another RPC");
    }
  }
  async refreshHealth() {
    const checked_at = this.now();
    try {
      const [chain, head] = await Promise.all([this.upstream("chain.get_chain_id", {}), this.upstream("chain.get_head_info", {})]);
      const height = Number(head.result?.head_topology?.height), time = Number(head.result?.head_block_time);
      if (!sameChain(chain.result?.chain_id)) throw new Error("Local node is not Koinos Mainnet");
      if (!Number.isSafeInteger(height) || height < 1 || !Number.isSafeInteger(time) || time < checked_at - 90000 || time > checked_at + 300000) throw new Error("Local node is syncing or stale");
      this.health = { ready: true, checked_at, chain_id: MAINNET_CHAIN_ID, head_height: height, error: null };
    } catch { this.health = { ready: false, checked_at, error: "Local Mainnet RPC is unavailable, syncing or stale" }; }
  }
  async one(req, signal) {
    const validId = v => v === null || typeof v === "string" && v.length <= 128 || Number.isSafeInteger(v);
    if (!plain(req) || req.jsonrpc !== "2.0" || typeof req.method !== "string" || req.method.length > 100 ||
        (own(req, "id") && !validId(req.id)) || Object.keys(req).some(k => !["jsonrpc", "id", "method", "params"].includes(k))) return error(null, -32600, "Invalid Request");
    const id = own(req, "id") ? req.id : null, notification = !own(req, "id");
    const out = await (async () => {
      const params = own(req, "params") ? req.params : {};
      if (!own(VALIDATORS, req.method) || own(OPTIONAL, req.method) && !this.optionalServices()) return error(id, -32601, "Method not available on this endpoint");
      try { VALIDATORS[req.method](params); } catch (e) { return error(id, e.rpcCode || -32602, e.message); }
      if (!this.status().ready) return error(id, -32001, "Local Mainnet RPC is not ready");
      if (this.inflight >= MAX_INFLIGHT) return error(id, -32005, "RPC busy; retry later");
      this.inflight++;
      try {
        const result = req.method === metadata.METHOD ? await this.contractMetadata(params, signal, id) : await this.upstream(req.method, params, signal, id);
        if (!this.status().ready) return error(id, -32001, "Local Mainnet RPC is not ready");
        return result;
      } catch { return error(id, -32002, "Local RPC unavailable or response exceeded limits"); }
      finally { this.inflight--; }
    })();
    return notification ? null : out;
  }
  async execute(body, signal) {
    const batch = Array.isArray(body), items = batch ? body : [body];
    if (!items.length || items.length > MAX_BATCH) return { status: 400, data: error(null, -32600, "A batch must contain 1–10 requests") };
    if (this.now() - this.windowAt >= 1000) { this.windowAt = this.now(); this.calls = 0; }
    if ((this.calls += items.length) > CALLS_PER_SECOND) return { status: 429, data: error(null, -32005, "RPC rate limit") };
    // Serial execution bounds both work and the aggregate batch response.
    const replies = []; let responseBytes = 0;
    for (const req of items) {
      if (signal?.aborted || this.signal?.aborted) return { status: 503, data: error(null, -32002, "RPC request cancelled") };
      const reply = await this.one(req, signal);
      if (reply) { responseBytes += Buffer.byteLength(JSON.stringify(reply));
        if (responseBytes > MAX_RESPONSE) return { status: 502, data: error(null, -32002, "Batch response exceeded limits") }; replies.push(reply); }
    }
    if (!replies.length) return { status: 204, data: null };
    // A node's application error may use the same numeric code. Only our
    // transport/readiness failures should produce HTTP 503 and client failover.
    const status = !batch && replies[0][LOCAL_ERROR] && [-32001, -32002, -32005].includes(replies[0].error?.code) ? 503 : 200;
    return { status, data: batch ? replies : replies[0] };
  }
}

module.exports = { PublicRpc, MAINNET_CHAIN_ID, MAX_BODY, MAX_RESPONSE, VALIDATORS, SYSTEM_READS, error };
