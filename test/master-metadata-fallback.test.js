"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const { Signer } = require("koilib");
const { PublicRpc, MAINNET_CHAIN_ID } = require("../plugin/service/core/lib/koinos/public-rpc");
const { MetadataFallback, METHOD, SOURCES, MAX_RESPONSE } = require("../plugin/service/core/lib/koinos/metadata-fallback");
const ADDRESS = "19GYjDBVXU7keLbYvMLazsGQn3GTWHjHkK";
const ABI = JSON.stringify(require("../plugin/service/core/lib/koinos/token-abi.json"));
const META = { meta: { abi: ABI } };
const LOCAL = "http://127.0.0.1:8085";
const request = (id = "wallet-1", address = ADDRESS) => ({ jsonrpc: "2.0", id, method: METHOD, params: { contract_id: address } });

async function fixture(options = {}) {
  const state = { local: {}, first: META, second: META, now: Date.now(), calls: [], chain: MAINNET_CHAIN_ID, enabled: true, indexes: true, ...options };
  const stop = new AbortController();
  const rpc = new PublicRpc({ url: LOCAL, now: () => state.now, network: () => "mainnet", signal: stop.signal,
    optionalServices: () => state.indexes, metadataFallback: () => state.enabled, timeoutMs: options.timeoutMs || 8000,
    fetchImpl: async (url, init) => {
      const input = JSON.parse(init.body); state.calls.push({ url, input, init });
      if (init.signal.aborted) throw init.signal.reason;
      if (input.method === "chain.get_chain_id") return Response.json({ jsonrpc: "2.0", id: input.id, result: { chain_id: url === SOURCES[0] ? state.chain : MAINNET_CHAIN_ID } });
      if (input.method === "chain.get_head_info") return Response.json({ jsonrpc: "2.0", id: input.id, result: { head_topology: { height: "39503404" }, head_block_time: String(state.now) } });
      let data = url === LOCAL ? state.local : url === SOURCES[0] ? state.first : state.second;
      if (typeof data === "function") data = await data(init);
      if (data instanceof Error) throw data;
      if (data instanceof Response) return data;
      return Response.json({ jsonrpc: "2.0", id: input.id, ...(data?.error ? data : { result: data }) });
    } });
  await rpc.refreshHealth(); state.calls = [];
  return { rpc, state, stop, advance: async ms => { state.now += ms; await rpc.refreshHealth(); state.calls = []; } };
}

test("missing KOIN metadata is recovered in standard RPC format; cached responses retain each caller's ID", async () => {
  const f = await fixture();
  const first = await f.rpc.execute(request());
  assert.equal(first.status, 200); assert.deepEqual(first.data, { jsonrpc: "2.0", id: "wallet-1", result: META });
  assert.deepEqual(f.state.calls.map(c => [c.url, c.input.method]), [[LOCAL, METHOD], [SOURCES[0], "chain.get_chain_id"], [SOURCES[1], "chain.get_chain_id"], [SOURCES[0], METHOD]]);
  for (const { init } of f.state.calls) { assert.equal(init.redirect, "error"); assert.deepEqual(init.headers, { "Content-Type": "application/json" }); }
  const second = await f.rpc.execute(request(42));
  assert.equal(second.data.id, 42); assert.deepEqual(second.data.result, META);
  assert.equal(f.state.calls.filter(c => c.url !== LOCAL).length, 3);
  assert.deepEqual(f.rpc.status().metadata_fallback.last_lookup, { source: SOURCES[0], outcome: "found", cached: true, checked_at: f.state.now });
  f.state.local = { meta: { abi: '{"methods":{"updated":{}}}' } };
  assert.deepEqual((await f.rpc.execute(request())).data.result, f.state.local);
  assert.equal(f.rpc.status().metadata_fallback.last_lookup.source, "local");
  assert.equal(f.rpc.metadata.cache.size, 0);
});

test("positive metadata cache expires so a contract update is fetched again", async () => {
  const f = await fixture(); await f.rpc.execute(request());
  await f.advance(61000); f.state.first = { meta: { abi: '{"methods":{"new_method":{}}}' } };
  assert.deepEqual((await f.rpc.execute(request())).data.result, f.state.first);
  assert.equal(f.state.calls.filter(c => c.url === SOURCES[0]).length, 2);
});

test("second backup handles missing, failed, malformed, oversized and non-Mainnet first sources", async () => {
  for (const first of [{}, { meta: {} }, { meta: { abi: "" } }, { meta: { abi: "not JSON" } }, { meta: { abi: "[]" } },
    { error: { code: -32601, message: "not available" } }, { unexpected: "payload" }, new Error("offline"),
    new Response("x", { status: 503 }), new Response("x", { headers: { "content-length": String(MAX_RESPONSE + 1) } }),
    () => new Response(JSON.stringify({ jsonrpc: "2.0", id: "wrong", result: META }))]) {
    const f = await fixture({ first });
    const result = await f.rpc.execute(request());
    assert.equal(result.status, 200); assert.deepEqual(result.data.result, META);
    assert.equal(f.rpc.status().metadata_fallback.last_lookup.source, SOURCES[1]);
  }
  const f = await fixture({ chain: "wrong-chain" });
  assert.deepEqual((await f.rpc.execute(request())).data.result, META);
  assert.equal(f.state.calls.filter(c => c.url === SOURCES[0] && c.input.method === METHOD).length, 0);
});

test("failed backups return a retryable failure, never a cached empty success", async () => {
  const f = await fixture({ first: {}, second: new Error("offline") });
  const result = await f.rpc.execute(request());
  assert.equal(result.status, 503); assert.equal(result.data.error.code, -32002);
  assert.equal(f.rpc.metadata.cache.size, 0);
  assert.equal(f.rpc.status().metadata_fallback.last_lookup.outcome, "unavailable");
  f.state.second = META;
  assert.deepEqual((await f.rpc.execute(request())).data.result, META);
});

test("genuinely absent metadata needs two successful Mainnet lookups and uses a short negative cache", async () => {
  const f = await fixture({ first: {}, second: { meta: { abi: "" } } });
  assert.deepEqual((await f.rpc.execute(request())).data.result, {});
  assert.equal(f.state.calls.filter(c => c.url !== LOCAL).length, 4);
  assert.deepEqual((await f.rpc.execute(request())).data.result, {});
  assert.equal(f.state.calls.filter(c => c.url !== LOCAL).length, 4);
  await f.advance(31000); f.state.second = META;
  assert.deepEqual((await f.rpc.execute(request())).data.result, META);
});

test("local metadata, disabled backups/indexes and rejected callers never contact the backups", async () => {
  const f = await fixture({ local: META });
  assert.deepEqual((await f.rpc.execute(request())).data.result, META);
  f.state.local = {}; f.state.enabled = false;
  assert.deepEqual((await f.rpc.execute(request())).data.result, {});
  f.state.local = new Error("offline");
  assert.equal((await f.rpc.execute(request())).status, 503);
  f.state.enabled = true; f.state.indexes = false;
  assert.equal((await f.rpc.execute(request())).data.error.code, -32601);
  f.state.indexes = true;
  assert.equal((await f.rpc.execute(request(1, "invalid"))).data.error.code, -32602);
  assert.equal((await f.rpc.execute({ ...request(), params: { contract_id: ADDRESS, url: "http://127.0.0.1:41101" } })).data.error.code, -32602);
  f.rpc.health.ready = false;
  assert.equal((await f.rpc.execute(request())).status, 503);
  assert.equal(f.state.calls.filter(c => c.url !== LOCAL).length, 0);
});

test("local service errors and timeouts can recover without delaying other RPC methods", async t => {
  const hold = setTimeout(() => {}, 1000); t.after(() => clearTimeout(hold));
  const hang = init => new Promise((_, reject) => init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true }));
  for (const local of [{ error: { code: -32601, message: "missing service" } }, { meta: { abi: "bad" } }, hang]) {
    const f = await fixture({ local, timeoutMs: 20 });
    assert.deepEqual((await f.rpc.execute(request())).data.result, META);
    assert.equal(f.rpc.inflight, 0);
  }
  const f = await fixture({ first: hang, timeoutMs: 20 });
  assert.deepEqual((await f.rpc.execute(request())).data.result, META);
  assert.equal(f.rpc.status().metadata_fallback.last_lookup.source, SOURCES[1]);
});

test("disconnect or API stop cancels remote work, does not try another source or cache it", async () => {
  for (const stopApi of [false, true]) {
    const client = new AbortController(); let started;
    const reached = new Promise(r => started = r);
    const f = await fixture({ first: init => new Promise((_, reject) => {
      init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true }); started();
    }) });
    const pending = f.rpc.execute(request(), client.signal);
    await reached; (stopApi ? f.stop : client).abort();
    assert.equal((await pending).status, 503);
    assert.equal(f.state.calls.filter(c => c.url === SOURCES[1] && c.input.method === METHOD).length, 0);
    assert.equal(f.rpc.metadata.cache.size, 0); assert.equal(f.rpc.inflight, 0);
  }
});

test("metadata lookups share concurrency limits and cap cache misses at sixty per minute", async () => {
  let release;
  const waiting = new Promise(r => release = r);
  const f = await fixture({ first: async () => { await waiting; return META; } });
  const pending = Array.from({ length: 4 }, (_, i) => f.rpc.execute(request(i)));
  assert.equal((await f.rpc.execute(request(9))).data.error.code, -32005);
  release(); assert.ok((await Promise.all(pending)).every(r => r.status === 200));
  let now = 0, calls = 0;
  const cache = new MetadataFallback({ now: () => now, enabled: () => true, sameChain: v => v === MAINNET_CHAIN_ID,
    call: async (_, method) => { calls++; return { result: method === METHOD ? {} : { chain_id: MAINNET_CHAIN_ID } }; } });
  const signal = new AbortController().signal;
  for (let i = 0; i < 60; i++) await cache.lookup(String(i), signal);
  assert.equal(calls, 240);
  await assert.rejects(cache.lookup("next", signal), /limit/); assert.equal(calls, 240);
  assert.deepEqual(await cache.lookup("0", signal), {}); assert.equal(calls, 240);
  now = 60000; assert.deepEqual(await cache.lookup("next", signal), {});
});

test("metadata cache bounds memory and evicts old contract entries", async () => {
  const f = await fixture();
  for (let i = 1; i <= 130; i++) {
    await f.advance(1001);
    const address = new Signer({ privateKey: i.toString(16).padStart(64, "0") }).address;
    await f.rpc.execute(request(i, address));
  }
  assert.equal(f.rpc.metadata.cache.size, 128);
  for (let i = 0; i < 20; i++) f.rpc.metadata.remember(String(i), { meta: { abi: JSON.stringify({ data: "x".repeat(500000) }) } }, SOURCES[0]);
  assert.ok(f.rpc.metadata.cacheBytes <= 4 * 1024 * 1024);
  assert.ok(f.rpc.metadata.cache.size < 20);
});
