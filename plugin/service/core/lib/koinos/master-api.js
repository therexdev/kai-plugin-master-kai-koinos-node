"use strict";

// Deliberately separate from Core: no wallet, signer, node-control or gateway reference.
const http = require("node:http");
const path = require("node:path");
const { JsonStore } = require("../store");
const { utils } = require("koilib");
const { PublicRpc, MAX_BODY, error: rpcError } = require("./public-rpc");
const { summarizeProducers } = require("./network-producers");
const WINDOW = 28800, MAX_AGE = 90000, MAX_BYTES = 8 * 1024 * 1024;

function validateConfig(input = {}) {
  const port = Number(input.port ?? 41110);
  if (!Number.isInteger(port) || port < 1024 || port > 65535 || [41100, 41101].includes(port)) throw new Error("Choose an API port from 1024 to 65535, separate from Core.");
  let url;
  try { url = new URL(input.rpcUrl || "http://127.0.0.1:8085"); } catch { throw new Error("Invalid local node RPC URL."); }
  if (url.protocol !== "http:" || !["127.0.0.1", "[::1]"].includes(url.hostname) || url.username || url.password || url.search || url.hash || url.pathname !== "/") throw new Error("Node RPC must be a loopback HTTP URL without credentials or a path.");
  if (Number(url.port || 80) === port || [41100, 41101].includes(Number(url.port || 80))) throw new Error("Choose the node RPC port, not a Core or public API port.");
  let publicUrl;
  try { publicUrl = new URL(input.publicUrl || "https://api.koinosai.com"); } catch { throw new Error("Invalid public HTTPS URL."); }
  if (publicUrl.protocol !== "https:" || publicUrl.username || publicUrl.password || publicUrl.search || publicUrl.hash || publicUrl.pathname !== "/" || publicUrl.port || !/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(publicUrl.hostname)) throw new Error("Public URL must be an HTTPS hostname without a path or port.");
  return { enabled: input.enabled === true, port, rpcUrl: url.origin, publicUrl: publicUrl.origin,
    rpcEnabled: input.rpcEnabled !== false, extendedIndexes: input.extendedIndexes === true,
    metadataFallback: input.metadataFallback !== false };
}

async function rpc(url, method, params = {}, { fetchImpl = fetch, signal } = {}) {
  if (!["chain.get_head_info", "chain.get_chain_id", "block_store.get_blocks_by_height"].includes(method)) throw new Error("RPC method is not read-allowlisted.");
  const response = await fetchImpl(url, { method: "POST", redirect: "error", signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(12000)]) : AbortSignal.timeout(12000),
    headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  if (!response.ok) { await response.body?.cancel(); throw new Error(`Local RPC HTTP ${response.status}`); }
  const reader = response.body.getReader(), chunks = []; let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read(); if (done) break;
      size += value.byteLength; if (size > MAX_BYTES) throw new Error("Local RPC response exceeded size limit.");
      chunks.push(Buffer.from(value));
    }
  } finally { await reader.cancel().catch(() => {}); }
  const result = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (result.error || !result.result) throw new Error(`Local RPC rejected ${method}${result.error?.message ? ": " + String(result.error.message).slice(0,350) : ""}`);
  return result.result;
}

function blockRecord(item) {
  const h = item?.block?.header, height = Number(item?.block_height ?? h?.height), timestamp = Number(h?.timestamp), id = item?.block_id || item?.block?.id;
  if (!h || !Number.isSafeInteger(height) || height < 1 || !Number.isSafeInteger(timestamp) || timestamp <= 0 || typeof id !== "string" || !id || typeof h.previous !== "string" || !utils.isChecksumAddress(h.signer)) throw new Error("Invalid local block response.");
  return { height, timestamp, id, previous: h.previous, signer: h.signer };
}

class ProducerIndex {
  constructor({ store, call, now = Date.now }) {
    Object.assign(this, { store, call, now });
    this.blocks = []; this.chainId = null; this.updatedAt = 0; this.head = 0; this.target = 0; this.error = null; this.busy = false;
    const saved = store.get("index", null);
    if (saved?.version === 1 && typeof saved.chainId === "string" && Array.isArray(saved.blocks) && saved.blocks.length <= WINDOW) {
      try {
        const blocks = saved.blocks.map(b => blockRecord({ block_height: b.height, block_id: b.id, block: { header: b } }));
        for (let i = 1; i < blocks.length; i++) if (blocks[i].height !== blocks[i-1].height + 1 || blocks[i].previous !== blocks[i-1].id) throw new Error("Checkpoint gap");
        this.blocks = blocks; this.chainId = saved.chainId;
      } catch { /* rebuild damaged checkpoint; never serve it as fresh */ }
    }
  }
  async read(from, count, headId) {
    const data = await this.call("block_store.get_blocks_by_height", { head_block_id: headId, ancestor_start_height: String(from), num_blocks: count, return_block: true, return_receipt: false });
    if (!Array.isArray(data.block_items) || data.block_items.length !== count) throw new Error("Local block store has incomplete history; wait for sync or restore missing blocks.");
    const blocks = data.block_items.map(blockRecord);
    for (let i = 0; i < blocks.length; i++) if (blocks[i].height !== from+i || blocks[i].timestamp > this.now()+300000 || (i && blocks[i].previous !== blocks[i-1].id)) throw new Error("Local block history is inconsistent.");
    return blocks;
  }
  async refresh() {
    if (this.busy) return this.snapshot();
    this.busy = true;
    try {
      const beforeId = this.blocks.at(-1)?.id, beforeLength = this.blocks.length;
      const [head, chain] = await Promise.all([this.call("chain.get_head_info"), this.call("chain.get_chain_id")]);
      const height = Number(head.head_topology?.height), target = Number(head.last_irreversible_block), headId = head.head_topology?.id;
      if (!Number.isSafeInteger(height) || !Number.isSafeInteger(target) || target < 1 || target > height || !headId || typeof chain.chain_id !== "string" || !chain.chain_id) throw new Error("Local node is not ready.");
      this.head = height; this.target = target;
      if (this.chainId && this.chainId !== chain.chain_id) throw new Error("Node chain ID changed; disable the API and select the correct node.");
      this.chainId = chain.chain_id;
      const last = this.blocks.at(-1);
      if (last && (last.height > target || (await this.read(last.height, 1, headId))[0].id !== last.id)) { this.blocks = []; this.updatedAt = 0; }
      const floor = Math.max(1, target-WINDOW+1);
      this.blocks = this.blocks.filter(b => b.height >= floor);
      let from = this.blocks.at(-1)?.height + 1 || floor;
      const end = Math.min(target, from+499);
      while (from <= end) {
        const batch = await this.read(from, Math.min(100, end-from+1), headId);
        if (this.blocks.length && batch[0].previous !== this.blocks.at(-1).id) throw new Error("Block parent mismatch.");
        this.blocks.push(...batch); from += batch.length;
      }
      if (this.blocks.at(-1)?.id !== beforeId || this.blocks.length !== beforeLength) this.store.set("index", { version: 1, chainId: this.chainId, blocks: this.blocks });
      this.updatedAt = this.now(); this.error = null;
    } catch (e) { this.error = e.message; }
    finally { this.busy = false; }
    return this.snapshot();
  }
  snapshot() {
    const tip = this.blocks.at(-1), complete = this.blocks.length === Math.min(WINDOW, this.target) && tip?.height === this.target;
    const fresh = !!this.updatedAt && this.now()-this.updatedAt <= MAX_AGE && tip?.timestamp >= this.now()-15*60000;
    const counts = new Map();
    for (const b of this.blocks) { const p = counts.get(b.signer) || { address: b.signer, blocks_24h: 0, last_block_time: 0 }; p.blocks_24h++; p.last_block_time = Math.max(p.last_block_time,b.timestamp); counts.set(b.signer,p); }
    return { source: "Master KAI Koinos Node", available: !!(complete && fresh && !this.error), stale: !fresh || !!this.error,
      chain_id: this.chainId, head_height: this.head, indexed_height: tip?.height || 0, finalized_height: this.target,
      window_blocks: WINDOW, total_blocks: this.blocks.length, complete, updated_at: this.updatedAt,
      tracked_scope: "producers-in-finalized-window", producers: [...counts.values()].sort((a,b) => a.address.localeCompare(b.address)),
      error: this.error || (!complete ? "Indexing finalized block history" : !fresh ? "Local node data is stale" : null) };
  }
}

class MasterNodeApi {
  constructor({ root, settings, fetchImpl = fetch, storeFactory = (file, defaults) => new JsonStore(file, defaults) }) {
    Object.assign(this, { root, settings, fetchImpl, storeFactory });
    this.disposed = false; this.starting = null; this.refreshing = null; this.healthChecking = null;
    this.publicRpc = null; this.server = null; this.timer = null; this.healthTimer = null; this.controller = null; this.index = null; this.payload = null; this.error = null; this.changing = false; this.active = false;
  }
  config() { return validateConfig(this.settings.get("masterApi", {})); }
  producerSummary() {
    const p = this.payload;
    const available = this.active && this.settings.get("network", "mainnet") === "mainnet" && !!p?.available && Date.now()-p.updated_at <= MAX_AGE;
    return { network: "mainnet", source: "Master KAI Koinos Node", sourceUrl: this.status().producerUrl,
      trackedScope: "producers-in-finalized-window", available, stale: !available, fetchedAt: p?.updated_at || null,
      ...(available ? summarizeProducers(p) : {}),
      error: available ? null : this.error || p?.error || "Local producer index is not ready" };
  }
  status() {
    const cfg = this.config();
    return { config: cfg, listening: !!this.server?.listening, bind: "127.0.0.1", error: this.error,
      summary: this.payload ? { ...this.payload, producers: undefined } : null,
      rpc: this.publicRpc?.status() || { ready: false },
      rpcUrl: `http://127.0.0.1:${cfg.port}/`, publicRpcUrl: cfg.publicUrl,
      producerUrl: `http://127.0.0.1:${cfg.port}/v1/token-tracker/producers` };
  }
  async configure(input) {
    if (this.disposed) throw new Error("Master Node API is closing.");
    if (this.changing) throw new Error("Wait for the current API operation.");
    this.changing = true;
    try {
      const cfg = validateConfig({ ...this.config(), ...input });
      if (cfg.enabled && this.settings.get("network","mainnet") !== "mainnet") throw new Error("Master API requires mainnet.");
      await this.stop();
      if (this.disposed) throw new Error("Master Node API is closing.");
      this.settings.set("masterApi",cfg); await this.start(); return this.status();
    } finally { this.changing = false; }
  }
  async refresh() {
    if (!this.active || !this.index) return;
    if (this.settings.get("network","mainnet") !== "mainnet") { await this.stop({ skipRefresh: true }); this.error = "Mainnet selection changed; API stopped."; return; }
    const index = this.index;
    const value = await index.refresh();
    if (this.active && this.index === index) this.payload = value;
  }
  async maintain() {
    // A temporary port conflict at login must not disable the API until the
    // user closes/reopens Master. Configuration and explicit disable still win.
    if (!this.disposed && !this.changing && this.config().enabled && !this.server) await this.start();
  }
  start() {
    if (this.disposed) return Promise.reject(new Error("Master Node API is closing."));
    if (this.starting) return this.starting;
    const work = this._start();
    this.starting = work;
    work.finally(() => { if (this.starting === work) this.starting = null; }).catch(() => {});
    return work;
  }
  async _start() {
    const cfg = this.config(); if (!cfg.enabled || this.server) return;
    if (this.settings.get("network","mainnet") !== "mainnet") throw new Error("Master API requires mainnet.");
    this.controller = new AbortController(); const signal = this.controller.signal;
    this.index = new ProducerIndex({ store: this.storeFactory(path.join(this.root,"master-producer-index.json"), {}), call: async (method,params) => { signal.throwIfAborted(); const value = await rpc(cfg.rpcUrl,method,params,{ fetchImpl: this.fetchImpl, signal }); signal.throwIfAborted(); return value; } });
    this.publicRpc = new PublicRpc({ url: cfg.rpcUrl, fetchImpl: this.fetchImpl, signal,
      network: () => this.settings.get("network", "mainnet"), optionalServices: () => cfg.extendedIndexes,
      metadataFallback: () => cfg.rpcEnabled && cfg.metadataFallback });
    let requests = 0, period = Date.now(), activeRequests = 0;
    const rpcPaths = new Set(["/", "/rpc"]), dataPaths = new Set(["/healthz", "/healthz/rpc", "/v1/status", "/v1/token-tracker/producers"]);
    const hosts = new Set([`127.0.0.1:${cfg.port}`, `localhost:${cfg.port}`, `[::1]:${cfg.port}`, new URL(cfg.publicUrl).host]);
    const gateway = this.publicRpc;
    this.server = http.createServer(async (req,res) => {
      const reply = (code,data) => {
        if (res.destroyed || res.writableEnded) return;
        res.writeHead(code, { "Content-Type":"application/json", "Cache-Control":"no-store", "X-Content-Type-Options":"nosniff",
          "Access-Control-Allow-Origin":"*", Connection:"close" });
        res.end(data == null ? undefined : JSON.stringify(data));
      };
      if (!hosts.has(String(req.headers.host || "").toLowerCase())) return reply(403, { error:"Unknown API hostname" });
      if (Date.now()-period > 1000) { period = Date.now(); requests = 0; }
      if (++requests > 60) return reply(429,rpcError(null,-32005,"API rate limit"));
      if (req.url?.length > 200 || !rpcPaths.has(req.url) && !dataPaths.has(req.url)) return reply(404,{ error:"Unknown endpoint" });
      if (req.method === "OPTIONS") {
        res.setHeader("Access-Control-Allow-Methods", rpcPaths.has(req.url) ? "POST, GET, OPTIONS" : "GET, OPTIONS");
        res.setHeader("Access-Control-Allow-Headers", "Content-Type"); res.setHeader("Access-Control-Max-Age", "3600");
        return reply(204,null);
      }
      if (req.method === "POST" && rpcPaths.has(req.url)) {
        if (!cfg.rpcEnabled) return reply(403,rpcError(null,-32601,"Public RPC is disabled"));
        if (!/^application\/json(?:\s*;|$)/i.test(req.headers["content-type"] || "")) return reply(415,rpcError(null,-32600,"Use application/json"));
        if (req.headers["content-encoding"] && req.headers["content-encoding"] !== "identity") return reply(415,rpcError(null,-32600,"Compressed requests are not supported"));
        if (Number(req.headers["content-length"]) > MAX_BODY) return reply(413,rpcError(null,-32600,"Request exceeds 2 MiB"));
        if (activeRequests >= 16) return reply(503,rpcError(null,-32005,"API busy"));
        activeRequests++;
        const client = new AbortController();
        const closed = () => { if (!res.writableEnded) client.abort(); };
        res.on("close",closed); req.once("aborted",closed);
        const deadline = setTimeout(() => { client.abort(); reply(408,rpcError(null,-32002,"Request timed out")); req.destroy(); },12000);
        try {
          const chunks = []; let size = 0;
          for await (const chunk of req.iterator({ destroyOnReturn: false })) { size += chunk.length; if (size > MAX_BODY) { reply(413,rpcError(null,-32600,"Request exceeds 2 MiB")); return; } chunks.push(chunk); }
          let body; try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { return reply(400,rpcError(null,-32700,"Parse error")); }
          const result = await gateway.execute(body, client.signal); return reply(result.status,result.data);
        } catch { reply(400,rpcError(null,-32600,"Invalid request body")); }
        finally { clearTimeout(deadline); activeRequests--; res.off("close",closed); req.off("aborted",closed); }
        return;
      }
      if (req.method !== "GET") return reply(405,{ error:"Method not allowed" });
      const p = this.payload, healthy = this.settings.get("network","mainnet") === "mainnet" && !!p?.available && Date.now()-p.updated_at <= MAX_AGE;
      const rpcStatus = gateway.status(); rpcStatus.ready = cfg.rpcEnabled && rpcStatus.ready;
      if (req.url === "/v1/token-tracker/producers") return reply(healthy ? 200 : 503,{ ...p, available:healthy, stale:!healthy, error:healthy ? null : p?.error || "Producer data unavailable" });
      if (req.url === "/healthz/rpc") return reply(rpcStatus.ready ? 200 : 503,rpcStatus);
      const data = { ready:healthy, source:"Master KAI Koinos Node", chain_id:p?.chain_id || rpcStatus.chain_id,
        head_height:rpcStatus.head_height || p?.head_height || 0, indexed_height:p?.indexed_height || 0, updated_at:p?.updated_at || null,
        rpc: rpcStatus, rpc_path:"/", producers_path:"/v1/token-tracker/producers" };
      return reply(req.url === "/healthz" && !healthy ? 503 : 200,data);
    });
    const server = this.server;
    this.server.requestTimeout = 5000; this.server.headersTimeout = 5000; this.server.maxConnections = 32;
    await new Promise((resolve,reject) => {
      const cleanup = () => { signal.removeEventListener("abort", aborted); server.off("error", failed); };
      const failed = error => { cleanup(); reject(error); };
      const aborted = () => { cleanup(); server.closeAllConnections(); server.close(); reject(new Error("Master Node API is closing.")); };
      if (signal.aborted) return aborted();
      signal.addEventListener("abort", aborted, { once: true }); server.once("error", failed);
      server.listen(cfg.port,"127.0.0.1", () => { cleanup(); resolve(); });
    }).catch(e => { if (this.server === server) this.server = null; this.controller?.abort(); this.error = `Node API could not listen: ${e.message}`; throw new Error(this.error); });
    if (this.disposed || signal.aborted || this.server !== server) {
      server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
      if (this.server === server) this.server = null;
      return;
    }
    this.error = null; this.active = true;
    const loop = async () => { const work = this.refresh(); this.refreshing = work; await work.catch(e => { if (!signal.aborted) this.error = e.message; }); if (this.refreshing === work) this.refreshing = null; if (this.active && !signal.aborted) { this.timer = setTimeout(loop,3000); this.timer.unref?.(); } };
    // Producer backfill must not delay health checks for normal wallet RPC.
    const healthLoop = async () => { const work = gateway.refreshHealth(); this.healthChecking = work; await work; if (this.healthChecking === work) this.healthChecking = null; if (this.active && !signal.aborted) { this.healthTimer = setTimeout(healthLoop,3000); this.healthTimer.unref?.(); } };
    void healthLoop();
    void loop();
  }
  async stop({ skipRefresh = false } = {}) {
    this.active = false; clearTimeout(this.timer); clearTimeout(this.healthTimer); this.timer = null; this.healthTimer = null; this.controller?.abort();
    const server = this.server; this.server = null;
    if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    await Promise.allSettled([...(skipRefresh ? [] : [this.refreshing]), this.healthChecking].filter(Boolean));
    this.payload = null; this.publicRpc = null;
  }
  async dispose() {
    this.disposed = true;
    await this.stop();
    await this.starting?.catch(() => {});
    await this.stop();
  }
}
module.exports = { ProducerIndex, MasterNodeApi, validateConfig, rpc, WINDOW };
