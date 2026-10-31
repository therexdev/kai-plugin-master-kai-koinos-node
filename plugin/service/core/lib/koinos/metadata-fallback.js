"use strict";

// Fixed destinations, independent of the client's Custom RPC/default priority:
// the public gateway must never use itself (or a caller's URL) as a backup.
const SOURCES = Object.freeze(["https://api.koinosblocks.com", "https://api.koinos.io"]);
const METHOD = "contract_meta_store.get_contract_meta";
const TIMEOUT_MS = 7000, MAX_RESPONSE = 1024 * 1024, MAX_ABI = 512 * 1024;
const TTL_MS = 60000, EMPTY_TTL_MS = 30000, MAX_ENTRIES = 128, MAX_CACHE_BYTES = 4 * 1024 * 1024;
const LOOKUPS_PER_MINUTE = 60;
const plain = v => v !== null && typeof v === "object" && !Array.isArray(v);

function metadataState(result) {
  if (!plain(result) || Object.keys(result).some(k => k !== "meta")) return "invalid";
  if (result.meta == null) return "empty";
  if (!plain(result.meta) || Object.keys(result.meta).some(k => k !== "abi")) return "invalid";
  const abi = result.meta.abi;
  if (abi == null || typeof abi === "string" && !abi.trim()) return "empty";
  if (typeof abi !== "string" || Buffer.byteLength(abi) > MAX_ABI) return "invalid";
  try { return plain(JSON.parse(abi)) ? "found" : "invalid"; } catch { return "invalid"; }
}

class MetadataFallback {
  constructor({ call, sameChain, enabled, now = Date.now }) {
    Object.assign(this, { call, sameChain, enabled, now });
    this.cache = new Map(); this.cacheBytes = 0; this.windowAt = now(); this.lookups = 0; this.lastLookup = null;
  }
  status() {
    return { enabled: this.enabled(), sources: [...SOURCES], last_lookup: this.lastLookup };
  }
  record(source, outcome, cached = false) {
    this.lastLookup = { source, outcome, cached, checked_at: this.now() };
  }
  forget(address) {
    const entry = this.cache.get(address);
    if (entry) { this.cacheBytes -= entry.bytes; this.cache.delete(address); }
  }
  remember(address, result, source) {
    this.forget(address);
    const bytes = Buffer.byteLength(JSON.stringify(result));
    while (this.cache.size && (this.cache.size >= MAX_ENTRIES || this.cacheBytes + bytes > MAX_CACHE_BYTES)) this.forget(this.cache.keys().next().value);
    this.cache.set(address, { result, source, bytes, until: this.now() + (source ? TTL_MS : EMPTY_TTL_MS) });
    this.cacheBytes += bytes;
  }
  async lookup(address, signal) {
    signal.throwIfAborted();
    if (!this.enabled()) throw new Error("Metadata backups disabled");
    const cached = this.cache.get(address);
    if (cached && cached.until > this.now()) {
      this.record(cached.source, cached.source ? "found" : "not_found", true);
      return cached.result;
    }
    this.forget(address);
    if (this.now() - this.windowAt >= 60000) { this.windowAt = this.now(); this.lookups = 0; }
    if (++this.lookups > LOOKUPS_PER_MINUTE) throw new Error("Metadata backup lookup limit reached");
    const finished = new AbortController();
    const lookupSignal = AbortSignal.any([signal, finished.signal]);
    // Check chain IDs concurrently so cold connections to two hosts fit the
    // overall deadline. Contract addresses are still queried in priority order.
    // Convert failures to values immediately; an unused check cannot reject
    // unhandled, and finally cancels it as soon as a result is available.
    const checks = SOURCES.map(async source => {
      try {
        const chain = await this.call(source, "chain.get_chain_id", {}, lookupSignal);
        return !chain.error && this.sameChain(chain.result?.chain_id);
      } catch { return false; }
    });
    try {
      let unavailable = false;
      for (let i = 0; i < SOURCES.length; i++) {
        signal.throwIfAborted();
        try {
          if (!await checks[i]) throw new Error("Metadata source is not verified Mainnet");
          signal.throwIfAborted();
          const reply = await this.call(SOURCES[i], METHOD, { contract_id: address }, lookupSignal);
          signal.throwIfAborted();
          if (reply.error || metadataState(reply.result) === "invalid") throw new Error("Invalid metadata response");
          if (metadataState(reply.result) === "found") {
            const result = { meta: { abi: reply.result.meta.abi } };
            this.remember(address, result, SOURCES[i]); this.record(SOURCES[i], "found"); return result;
          }
        } catch {
          signal.throwIfAborted();
          unavailable = true;
        }
      }
      // Never disguise a failed lookup as a successful empty result. Both
      // Mainnet backups must explicitly report absence before we cache it.
      if (unavailable) throw new Error("Contract metadata backups unavailable");
      this.remember(address, {}, null); this.record(null, "not_found"); return {};
    } finally { finished.abort(); }
  }
}

module.exports = { MetadataFallback, metadataState, METHOD, SOURCES, TIMEOUT_MS, MAX_RESPONSE };
