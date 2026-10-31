"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const http = require("node:http"), fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const { Signer, Serializer } = require("koilib");
const { JsonStore } = require("../plugin/service/core/lib/store");
const { MasterNodeApi, validateConfig } = require("../plugin/service/core/lib/koinos/master-api");
const { PublicRpc, MAINNET_CHAIN_ID, MAX_BODY, MAX_RESPONSE } = require("../plugin/service/core/lib/koinos/public-rpc");
const { createProvider } = require("../plugin/service/core/lib/koinos-rpc");
const { buildEnv } = require("../plugin/service/core/lib/koinos/node-manager");
const { NETWORKS } = require("../plugin/service/core/lib/koinos/constants");
const ADDRESS = new Signer({ privateKey: "1".padStart(64, "0") }).address;
const hash = n => "0x1220" + n.toString(16).padStart(64, "0");
const request = (method, params = {}, id = 7) => ({ jsonrpc: "2.0", id, method, params });
async function listen(server) { await new Promise(r => server.listen(0, "127.0.0.1", r)); return server.address().port; }
function hostRequest(url, host) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { headers: { Host: host } }, res => { res.resume(); res.on("end", () => resolve(res.statusCode)); });
    req.on("error", reject);
  });
}
async function fixture(t, config = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "master-public-rpc-"));
  const state = { calls: [], mode: "ok", chain: MAINNET_CHAIN_ID, time: Date.now(), custom: null };
  const node = http.createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const raw = Buffer.concat(chunks).toString("utf8"), input = JSON.parse(raw); state.calls.push({ input, raw, headers: req.headers });
    if (state.mode === "http") { res.writeHead(503); res.end(); return; }
    let result;
    if (input.method === "chain.get_chain_id") result = { chain_id: state.chain };
    else if (input.method === "chain.get_head_info") result = { head_topology: { id: hash(3), height: "3" }, head_block_time: String(state.time), last_irreversible_block: "3" };
    else if (input.method === "block_store.get_blocks_by_height") result = { block_items: Array.from({ length: input.params.num_blocks }, (_, i) => {
      const h = Number(input.params.ancestor_start_height) + i;
      return { block_height: String(h), block_id: hash(h), block: { header: { previous: hash(h - 1), signer: ADDRESS, timestamp: String(state.time) } } };
    }) };
    else if (state.custom) return state.custom(input, res);
    else result = { echoed: input.params };
    res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ jsonrpc: "2.0", id: input.id, result }));
  });
  const upstreamPort = await listen(node), probe = http.createServer(), port = await listen(probe); await new Promise(r => probe.close(r));
  const settings = new JsonStore(path.join(root, "settings.json"), { network: "mainnet", masterApi: { enabled: true, port, rpcUrl: `http://127.0.0.1:${upstreamPort}`, ...config } });
  const api = new MasterNodeApi({ root, settings });
  t.after(async () => { await api.stop(); node.closeAllConnections(); await new Promise(r => node.close(r)); fs.rmSync(root, { recursive: true, force: true }); });
  await api.start(); await api.publicRpc.refreshHealth();
  const url = `http://127.0.0.1:${port}`;
  const post = (body, route = "/", headers = {}) => fetch(url + route, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
  return { api, settings, state, url, post };
}

test("real HTTP RPC supports koilib, browser CORS and producer routes on the same listener", async t => {
  const f = await fixture(t), provider = createProvider([f.url]);
  assert.equal(await provider.getChainId(), MAINNET_CHAIN_ID);
  assert.equal((await provider.getHeadInfo()).head_topology.height, "3");
  assert.equal((await provider.getBlocks(2, 1))[0].block_height, "2");
  const serializer = new Serializer({ nested: { response: { fields: { value: { type: "record", id: 1 } } }, record: { fields: { address: { type: "bytes", id: 1, options: { "(koinos.btype)": "ADDRESS" } } } } } });
  const encoded = await serializer.serialize({ value: { address: ADDRESS } }, "response");
  f.state.custom = (input, res) => res.end(JSON.stringify({ jsonrpc: "2.0", id: input.id, result: { value: Buffer.from(encoded).toString("base64url") } }));
  assert.equal((await provider.invokeGetContractAddress("koin")).value.address, ADDRESS);
  const options = await fetch(f.url, { method: "OPTIONS", headers: { origin: "https://ouro.lifestyle", "access-control-request-method": "POST", "access-control-request-headers": "content-type" } });
  assert.equal(options.status, 204); assert.equal(options.headers.get("access-control-allow-origin"), "*");
  const response = await f.post(request("chain.get_account_rc", { account: ADDRESS }, "wallet-1"), "/rpc", { origin: "https://koinvault.app", cookie: "private=do-not-forward", authorization: "Bearer do-not-forward", host: "api.koinosai.com" });
  assert.equal((await response.json()).id, "wallet-1");
  const forwarded = f.state.calls.find(c => c.input.id === "wallet-1"); assert.equal(forwarded.headers.cookie, undefined); assert.equal(forwarded.headers.authorization, undefined);
  assert.equal((await fetch(f.url + "/healthz/rpc")).status, 200);
  assert.equal(await hostRequest(f.url, "api.koinosai.com"), 200);
  for (let i = 0; i < 100 && !f.api.payload; i++) await new Promise(r => setTimeout(r, 5));
  assert.equal((await (await fetch(f.url + "/v1/token-tracker/producers")).json()).total_blocks, 3);
  assert.equal((await (await fetch(f.url + "/v1/status")).json()).rpc.ready, true);
});

test("signed transaction is relayed once unchanged and chain rejection details survive", async t => {
  const f = await fixture(t);
  const tx = { id: hash(9), header: { chain_id: MAINNET_CHAIN_ID, payer: ADDRESS, nonce: "KAE=", rc_limit: "100" }, operations: [{ call_contract: { contract_id: ADDRESS, entry_point: 1, args: "" } }], signatures: ["AQIDBA=="] };
  // A chain rejection must remain HTTP 200 even if its code overlaps a
  // gateway transport error. Clients must not mistake it for failover advice.
  const params = { transaction: tx, broadcast: true }, rejection = { code: -32002, message: "insufficient rc", data: '{"logs":["mana exceeded"]}' };
  f.state.custom = (input, res) => res.end(JSON.stringify({ jsonrpc: "2.0", id: input.id, error: rejection }));
  const res = await f.post(request("chain.submit_transaction", params, "signed"));
  assert.equal(res.status, 200); assert.deepEqual((await res.json()).error, rejection);
  const submitted = f.state.calls.filter(c => c.input.method === "chain.submit_transaction");
  assert.equal(submitted.length, 1); assert.deepEqual(submitted[0].input.params, params);
  for (const bad of [{ ...tx, signatures: [] }, { ...tx, header: { chain_id: "other" } }]) {
    assert.equal((await (await f.post(request("chain.submit_transaction", { transaction: bad }))).json()).error.code, -32602);
  }
  assert.equal(f.state.calls.filter(c => c.input.method === "chain.submit_transaction").length, 1);
});

test("public RPC refuses admin methods, unsafe system calls, malformed parameters and oversized work", async t => {
  const f = await fixture(t);
  const forbidden = ["chain.submit_block", "chain.propose_block", "block_store.add_block", "wallet:revealWif", "node:start", "distribution:configure", "constructor", "__proto__"];
  for (const method of forbidden) assert.equal((await (await f.post(request(method))).json()).error.code, -32601);
  for (const [method, params] of [
    ["chain.invoke_system_call", { name: "put_object", args: "" }],
    ["chain.invoke_system_call", { id: 301, args: "" }],
    ["chain.invoke_system_call", { name: "get_chain_id", id: 301 }],
    ["chain.invoke_system_call", { name: "constructor" }],
    ["chain.get_chain_id", { url: "http://127.0.0.1:41101" }],
    ["chain.get_account_rc", { account: "invalid" }],
    ["block_store.get_blocks_by_height", { head_block_id: hash(3), ancestor_start_height: "1", num_blocks: 101 }],
  ]) assert.equal((await (await f.post(request(method, params))).json()).error.code, -32602);
  // Health/index probes have ID 1 and may finish at any time. None of the
  // rejected public requests (ID 7) may reach the upstream node.
  assert.equal(f.state.calls.filter(c => c.input.id === 7).length, 0);
  assert.equal((await f.post(request("chain.get_chain_id"), "/core/koinos/rpc")).status, 404);
  assert.equal(await hostRequest(f.url, "rebound.example"), 403);
  assert.equal((await f.post(request("chain.get_chain_id"), "/", { "content-type": "text/plain" })).status, 415);
  const malformed = await fetch(f.url, { method: "POST", headers: { "content-type": "application/json" }, body: "{" });
  assert.equal((await malformed.json()).error.code, -32700);
  const large = await f.post({ data: "x".repeat(MAX_BODY) }); assert.equal(large.status, 413);
});

test("JSON-RPC batches, notifications and IDs remain compatible while batch work is bounded", async t => {
  const f = await fixture(t);
  const res = await f.post([request("chain.get_chain_id", {}, "a"), { jsonrpc: "2.0", method: "chain.get_head_info" }, request("node:start", {}, 0), null]);
  const batch = await res.json(); assert.deepEqual(batch.map(r => r.id), ["a", 0, null]); assert.equal(batch[1].error.code, -32601);
  assert.equal((await f.post({ jsonrpc: "2.0", method: "chain.get_chain_id" })).status, 204);
  assert.equal((await f.post([])).status, 400);
  assert.equal((await f.post(Array.from({ length: 11 }, () => request("chain.get_chain_id")))).status, 400);
  assert.equal((await (await f.post(request("chain.get_chain_id", {}, {}))).json()).error.code, -32600);
});

test("wrong chain, stale head, network changes and disable all stop public forwarding", async t => {
  const f = await fixture(t);
  f.state.chain = "not-mainnet"; await f.api.publicRpc.refreshHealth();
  assert.equal((await f.post(request("chain.get_head_info"))).status, 503);
  f.state.chain = MAINNET_CHAIN_ID; f.state.time = Date.now() - 120000; await f.api.publicRpc.refreshHealth();
  assert.equal((await fetch(f.url + "/healthz/rpc")).status, 503);
  f.state.time = Date.now(); await f.api.publicRpc.refreshHealth(); f.settings.set("network", "harbinger");
  assert.equal((await f.post(request("chain.get_head_info"))).status, 503);
  f.settings.set("network", "mainnet");
  await f.api.configure({ rpcEnabled: false });
  assert.equal((await f.post(request("chain.get_head_info"))).status, 403);
  assert.equal((await fetch(f.url + "/healthz/rpc")).status, 503);
});

test("unsupported optional indexes fail explicitly so clients can use their backups", async t => {
  const f = await fixture(t), req = request("account_history.get_account_history", { address: ADDRESS, limit: 10 });
  assert.equal((await (await f.post(req)).json()).error.code, -32601);
  await f.api.configure({ extendedIndexes: true }); await f.api.publicRpc.refreshHealth();
  assert.equal((await f.post(req)).status, 200);
  const env = buildEnv(NETWORKS.mainnet, "/fixture", true, false, false, true);
  assert.match(env, /COMPOSE_PROFILES=jsonrpc,block_producer,account_history,transaction_store,contract_meta_store/);
  assert.match(buildEnv(NETWORKS.mainnet, "/fixture", true, true, false, true), /COMPOSE_PROFILES=jsonrpc,block_producer,account_history,transaction_store,contract_meta_store/);
});

test("upstream timeouts, response bounds, concurrency and rate limits cannot exhaust the node", async t => {
  let mode = "ok", release, aborted = false;
  const rpc = new PublicRpc({ url: "http://127.0.0.1:8085", network: () => "mainnet", timeoutMs: 25, fetchImpl: async (_, { body, signal }) => {
    const input = JSON.parse(body);
    if (mode === "hang") return new Promise((resolve, reject) => { release = resolve; signal.addEventListener("abort", () => { aborted = true; reject(new Error("aborted")); }, { once: true }); });
    if (mode === "large") return new Response("x", { headers: { "content-length": String(MAX_RESPONSE + 1) } });
    return Response.json({ jsonrpc: "2.0", id: input.id, result: input.method === "chain.get_chain_id" ? { chain_id: MAINNET_CHAIN_ID } : { head_topology: { height: "1" }, head_block_time: String(Date.now()) } });
  } });
  await rpc.refreshHealth(); mode = "large"; assert.equal((await rpc.execute(request("chain.get_head_info"))).status, 503);
  mode = "hang";
  const timer = setTimeout(() => {}, 1000); t.after(() => clearTimeout(timer));
  const pending = Array.from({ length: 4 }, () => rpc.execute(request("chain.get_head_info")));
  assert.equal((await rpc.execute(request("chain.get_head_info"))).data.error.code, -32005);
  assert.ok((await Promise.all(pending)).every(r => r.status === 503)); assert.equal(aborted, true); assert.equal(rpc.inflight, 0);
  mode = "ok"; for (let i = 0; i < 3; i++) await rpc.execute(Array.from({ length: 10 }, () => request("chain.get_chain_id")));
  assert.equal((await rpc.execute(request("chain.get_chain_id"))).status, 429);
  assert.ok(release);
});

test("public URL and local upstream configuration reject redirects to control ports", () => {
  for (const input of [{ rpcUrl: "http://127.0.0.1:41101" }, { rpcUrl: "http://127.0.0.1:41110" }, { publicUrl: "http://api.koinosai.com" }, { publicUrl: "https://api.koinosai.com/path" }]) assert.throws(() => validateConfig(input));
  assert.equal(validateConfig().publicUrl, "https://api.koinosai.com");
});
