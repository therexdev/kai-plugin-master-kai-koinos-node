"use strict";
const { Provider } = require("koilib");
const { AsyncLocalStorage } = require("node:async_hooks");

const READS = new Set([
  "chain.get_chain_id", "chain.get_head_info", "chain.get_account_rc",
  "chain.get_account_nonce", "chain.read_contract", "chain.get_resource_limits",
  "chain.get_fork_heads", "transaction_store.get_transactions_by_id",
  "block_store.get_blocks_by_id", "block_store.get_blocks_by_height",
]);
function retryableMethod(method, params) {
  return READS.has(method) ||
    (method === "chain.invoke_system_call" &&
      ["get_contract_metadata", "get_contract_address"].includes(params?.name)) ||
    (method === "chain.submit_transaction" && params?.broadcast === false);
}
function readOnlyMethod(method, params) {
  return READS.has(method) || (method === "chain.invoke_system_call" &&
    ["get_contract_metadata", "get_contract_address"].includes(params?.name));
}
class RpcFailure extends Error {
  constructor(message, retryable = false, code = "koin_rpc_unavailable") {
    super(message); this.retryable = retryable; this.code = code;
  }
}
const unavailable = () => new RpcFailure(
  "KOIN RPC is temporarily unavailable. Check confirmation again shortly.", true);
const stopped = () => new RpcFailure("KOIN RPC request stopped.", false, "koin_rpc_stopped");
function rejection(error) {
  // RPC errors may contain request bodies and signatures. Inspect a bounded
  // string only to select a fixed public category, never return that string.
  let detail = "";
  if (typeof error?.message === "string") detail += error.message.slice(0, 4096);
  if (typeof error?.data === "string") detail += error.data.slice(0, 4096);
  if (/insufficient rc|insufficient mana|compute bandwidth limit|rc limit/i.test(detail))
    return new RpcFailure("KOIN RPC rejected the transaction: insufficient rc.", false, "koin_rpc_insufficient_rc");
  // Koinos JSON-RPC can return HTTP 200 while its AMQP connection to the
  // chain service is down. Match that gateway diagnostic exactly: contract
  // failures/logs mentioning AMQP are not evidence of a transport outage.
  const amqpUnavailable = typeof error?.data === "string" && error.data.length <= 4096 &&
    /^rpc failed, AMQP connection is not open$/i.test(error.data.trim());
  if (error?.code === -32603 && (amqpUnavailable ||
      /context deadline exceeded|temporarily unavailable|service unavailable|upstream timed out/i.test(detail)))
    return unavailable();
  return new RpcFailure("KOIN RPC rejected the request.", false, "koin_rpc_rejected");
}

// Koilib's default shared cursor aborts instead of trying a backup. Its optional
// retry loop also retries broadcasts. Override only the transport: all inherited
// serializers and helpers still use this call, and writes have one attempt.
class PinnedRpcProvider extends Provider {
  #endpoints; #chainId; #fetch; #timeoutMs; #attemptTimeoutMs; #signals = new AsyncLocalStorage();
  #preferred = 0; #lastAccepted = 0; #generation = 0; #requestId = 0;
  #requestIntervalMs; #nextRequest = new Map();
  #verificationScopes = new AsyncLocalStorage(); #probes = new Map(); #readHedgeMs;
  // Each endpoint attempt includes a chain-id probe followed by the requested
  // operation. Allow both reads to finish on a slow node, and leave a full
  // backup attempt after a stalled primary without removing the total bound.
  constructor(rpc, chainId, { fetchImpl = globalThis.fetch, timeoutMs = 45000, attemptTimeoutMs = 20000, requestIntervalMs = 0, readHedgeMs = 0 } = {}) {
    if (!Array.isArray(rpc) || !rpc.length || rpc.length > 3 || new Set(rpc).size !== rpc.length ||
        typeof chainId !== "string" || !chainId || typeof fetchImpl !== "function" ||
        !Number.isSafeInteger(timeoutMs) || timeoutMs < 10 || timeoutMs > 45000 ||
        !Number.isSafeInteger(attemptTimeoutMs) || attemptTimeoutMs < 10 || attemptTimeoutMs > timeoutMs ||
        !Number.isSafeInteger(requestIntervalMs) || requestIntervalMs < 0 || requestIntervalMs > 1000 ||
        !Number.isSafeInteger(readHedgeMs) || readHedgeMs < 0 || readHedgeMs > 5000)
      throw Error("Invalid pinned KOIN RPC settings");
    const endpoints = Object.freeze(rpc.map(value => {
      const url = new URL(value);
      if (url.protocol !== "https:" || url.username || url.password || url.hash)
        throw Error("Pinned HTTPS KOIN RPC required");
      return value;
    }));
    super(endpoints);
    Object.defineProperty(this, "rpcNodes", { value: endpoints, writable: false, configurable: false });
    this.#endpoints = endpoints; this.#chainId = chainId; this.#fetch = fetchImpl;
    this.#timeoutMs = timeoutMs; this.#attemptTimeoutMs = attemptTimeoutMs;
    this.#requestIntervalMs = requestIntervalMs;
    this.#readHedgeMs = readHedgeMs;
  }
  withSignal(signal, run) { return this.#signals.run(signal, run); }
  withVerificationScope(run) { return this.#verificationScopes.run(new Map(), run); }
  get pinnedChainId() { return this.#chainId; }
  get readGeneration() { return this.#generation; }
  async #chain(endpoint, signal) {
    const scope = this.#verificationScopes.getStore(), cached = scope?.get(endpoint), now = Date.now();
    if (cached && cached.generation === this.#generation && now >= cached.checkedAt && now - cached.checkedAt < 10000) {
      signal.throwIfAborted(); return cached.value;
    }
    let probe = this.#probes.get(endpoint);
    if (!probe) {
      probe = { controller: new AbortController(), users: 0, done: false };
      this.#probes.set(endpoint, probe);
      probe.promise = this.#request(endpoint, "chain.get_chain_id", {}, probe.controller.signal).then(value => {
        if (value?.chain_id !== this.#chainId) throw new RpcFailure("Deployment chain mismatch", false, "koin_rpc_chain_mismatch");
        return value;
      }).finally(() => {
        probe.done = true; if (this.#probes.get(endpoint) === probe) this.#probes.delete(endpoint);
      });
    }
    probe.users++;
    let aborted;
    try {
      const value = await Promise.race([probe.promise, new Promise((_, reject) => {
        aborted = () => reject(stopped());
        signal.addEventListener("abort", aborted, { once: true });
        if (signal.aborted) aborted();
      })]);
      signal.throwIfAborted();
      scope?.set(endpoint, { value, checkedAt: Date.now(), generation: this.#generation });
      return value;
    } finally {
      signal.removeEventListener("abort", aborted); probe.users--;
      if (!probe.users && !probe.done) {
        if (this.#probes.get(endpoint) === probe) this.#probes.delete(endpoint);
        probe.controller.abort();
      }
    }
  }
  async #pace(endpoint, signal) {
    while (this.#requestIntervalMs) {
      signal.throwIfAborted();
      const now = Date.now(), delay = (this.#nextRequest.get(endpoint) || 0) - now;
      if (delay <= 0) { this.#nextRequest.set(endpoint, now + this.#requestIntervalMs); return; }
      // Reserve only when a request actually starts. Stopped reviews cannot
      // leave future slots occupied or send anything when their timer wakes.
      await new Promise((resolve, reject) => {
        const done = () => { signal.removeEventListener("abort", abort); resolve(); };
        const timer = setTimeout(done, delay);
        const abort = () => { clearTimeout(timer); signal.removeEventListener("abort", abort); reject(stopped()); };
        signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted) abort();
      });
    }
  }
  async #request(endpoint, method, params, signal) {
    if (this.#requestIntervalMs) await this.#pace(endpoint, signal);
    signal.throwIfAborted();
    const id = ++this.#requestId;
    let response;
    try {
      response = await this.#fetch(endpoint, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, jsonrpc: "2.0", method, params }), signal,
        redirect: "error",
      });
    } catch { throw unavailable(); }
    signal.throwIfAborted();
    if (!response?.ok) {
      if (response?.status === 429) {
        const value = response.headers?.get?.("retry-after"), seconds = /^\d{1,4}$/.test(value || "") ? Number(value) : 1;
        this.#nextRequest.set(endpoint, Math.max(this.#nextRequest.get(endpoint) || 0, Date.now() + Math.min(5000, Math.max(1000, seconds * 1000))));
        throw new RpcFailure("KOIN RPC is rate-limiting requests. Wait a moment before resuming.", true, "koin_rpc_rate_limited");
      }
      if (response?.status === 403 || response?.status >= 500) throw unavailable();
      throw new RpcFailure("KOIN RPC refused the request.");
    }
    let json;
    try {
      const body = await response.text();
      signal.throwIfAborted();
      if (body.length > 16 * 1024 * 1024) throw Error("Response too large");
      json = JSON.parse(body);
    } catch { throw unavailable(); }
    if (!json || typeof json !== "object" || Array.isArray(json) || json.jsonrpc !== "2.0" || json.id !== id ||
        (Object.hasOwn(json, "result") === Object.hasOwn(json, "error"))) throw unavailable();
    if (Object.hasOwn(json, "error")) throw rejection(json.error);
    return json.result;
  }
  async #attempt(endpoint, method, params, remaining, signal) {
    const controller = new AbortController();
    let timer, onAbort;
    const task = async () => {
      // Only read-only operations share a short, explicit verification phase.
      // Broadcasts and simulations always obtain their own fresh chain pin.
      const chain = readOnlyMethod(method, params) ? await this.#chain(endpoint, controller.signal)
        : await this.#request(endpoint, "chain.get_chain_id", {}, controller.signal);
      if (chain?.chain_id !== this.#chainId)
        throw new RpcFailure("Deployment chain mismatch", false, "koin_rpc_chain_mismatch");
      if (method === "chain.get_chain_id") return chain;
      controller.signal.throwIfAborted();
      return this.#request(endpoint, method, params, controller.signal);
    };
    try {
      return await Promise.race([task(), new Promise((_, reject) => {
        onAbort = () => { controller.abort(); reject(stopped()); };
        signal?.addEventListener("abort", onAbort, { once: true });
        if (signal?.aborted) onAbort();
        timer = setTimeout(() => { controller.abort(); reject(unavailable()); }, remaining);
      })]);
    } catch (error) {
      if (signal?.aborted) throw stopped();
      throw error instanceof RpcFailure ? error : unavailable();
    } finally {
      clearTimeout(timer); controller.abort();
      if (onAbort) signal?.removeEventListener("abort", onAbort);
    }
  }
  async call(method, params, { signal } = {}) {
    const scoped = this.#signals.getStore();
    if (scoped) signal = signal ? AbortSignal.any([signal, scoped]) : scoped;
    if (signal?.aborted) throw stopped();
    const captured = structuredClone(params), retry = retryableMethod(method, captured);
    if (this.#readHedgeMs && this.#endpoints.length > 1 && readOnlyMethod(method, captured)) return this.#hedgedRead(method, captured, signal);
    const preferred = this.#preferred, deadline = Date.now() + this.#timeoutMs;
    const count = retry ? this.#endpoints.length : 1;
    for (let attempt = 0; attempt < count; attempt++) {
      if (signal?.aborted) throw stopped();
      const index = (preferred + attempt) % this.#endpoints.length;
      const remaining = Math.min(this.#attemptTimeoutMs, deadline - Date.now());
      if (remaining <= 0) throw unavailable();
      try {
        const result = await this.#attempt(this.#endpoints[index], method, captured, remaining, signal);
        if (signal?.aborted) throw stopped();
        // Count every accepted endpoint transition, including a late old
        // primary response, so concurrent A/B/A reads cannot form a snapshot.
        if (index !== this.#lastAccepted) { this.#lastAccepted = index; this.#generation++; }
        // A late primary success does not undo a healthy fallback preference.
        if (attempt > 0) this.#preferred = index;
        return result;
      } catch (error) {
        if (!(error instanceof RpcFailure) || !error.retryable || attempt + 1 >= count) throw error;
      }
    }
    throw unavailable();
  }
  async #hedgedRead(method, params, signal) {
    const preferred = this.#preferred, deadline = Date.now() + this.#timeoutMs;
    const controller = new AbortController(), combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    let completed = 0, settled = false, deadlineTimer;
    const startNext = [];
    try {
      return await new Promise((resolve, reject) => {
        deadlineTimer = setTimeout(() => { if (!settled) { settled = true; reject(unavailable()); } }, this.#timeoutMs);
        const finish = (error, value, index, attempt) => {
          if (settled) return;
          if (error && error.retryable && ++completed < this.#endpoints.length) return;
          settled = true;
          if (error) { reject(error); return; }
          if (signal?.aborted) { reject(stopped()); return; }
          if (index !== this.#lastAccepted) { this.#lastAccepted = index; this.#generation++; }
          if (attempt > 0) this.#preferred = index;
          resolve(value);
        };
        for (let attempt = 0; attempt < this.#endpoints.length; attempt++) {
          const index = (preferred + attempt) % this.#endpoints.length;
          (async () => {
            if (attempt) await new Promise((done, fail) => {
              const abort = () => { clearTimeout(timer); combined.removeEventListener("abort", abort); fail(stopped()); };
              const start = () => { clearTimeout(timer); combined.removeEventListener("abort", abort); done(); };
              const timer = setTimeout(start, this.#readHedgeMs * attempt); startNext[attempt] = start;
              combined.addEventListener("abort", abort, { once: true }); if (combined.aborted) abort();
            });
            combined.throwIfAborted();
            const remaining = Math.min(this.#attemptTimeoutMs, deadline - Date.now());
            if (remaining <= 0) throw unavailable();
            const value = await this.#attempt(this.#endpoints[index], method, params, remaining, combined);
            finish(null, value, index, attempt);
          })().catch(error => {
            const failure = signal?.aborted ? stopped() : error instanceof RpcFailure ? error : unavailable();
            if (failure.retryable) startNext[attempt + 1]?.();
            finish(failure);
          });
        }
      });
    } finally { clearTimeout(deadlineTimer); controller.abort(); }
  }
}
module.exports = { PinnedRpcProvider };
