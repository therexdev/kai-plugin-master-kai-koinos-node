"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const { createProvider } = require("../plugin/service/core/lib/koinos-rpc");
const URLS = ["https://primary.invalid", "https://backup.invalid"];
const timeout = { code: -32603, message: "request timeout: synthetic-request-id" };

function fixture(replies) {
  const calls = [];
  const provider = createProvider(URLS, { fetchImpl: async (url, { body }) => {
    calls.push({ url, body });
    return Response.json({ jsonrpc: "2.0", id: 1, ...replies[calls.length - 1] });
  } });
  return { provider, calls };
}

test("a server timeout during a mana read uses the backup without changing the request", async () => {
  const f = fixture([{ error: timeout }, { result: { rc: "53100563634" } }]);
  assert.equal(await f.provider.getAccountRc("synthetic-wallet"), "53100563634");
  assert.deepEqual(f.calls.map(c => c.url), URLS);
  assert.equal(f.calls[0].body, f.calls[1].body);
});

test("nonce preparation can recover from an RPC timeout in structured error details", async () => {
  const error = { code: -32603, message: "An internal server error has occurred", data: JSON.stringify({ error: timeout.message }) };
  const f = fixture([{ error }, { result: { nonce: "KAA=" } }]);
  // Exercise koilib's real nonce decoding/increment after the successful read.
  assert.equal(await f.provider.getNextNonce("synthetic-wallet"), "KAE=");
  assert.deepEqual(f.calls.map(c => c.url), URLS);
  assert.equal(f.calls[0].body, f.calls[1].body);
});

test("contract reads and named address lookups recover from backend timeout details", async () => {
  for (const [method, params] of [
    ["chain.read_contract", { contract_id: "synthetic-token", entry_point: 1, args: "" }],
    ["chain.invoke_system_call", { name: "get_contract_address", args: "" }],
  ]) {
    const f = fixture([{ error: { code: -32603, message: "An internal server error has occurred", data: timeout.message } }, { result: { value: "fixture" } }]);
    assert.deepEqual(await f.provider.call(method, params), { value: "fixture" });
    assert.equal(f.calls.length, 2);
    assert.equal(f.calls[0].body, f.calls[1].body);
  }
});

test("a submit timeout is still uncertain and cannot trigger the read retry path", async () => {
  const f = fixture([{ error: timeout }, { result: {} }]);
  await assert.rejects(f.provider.call("chain.submit_transaction", { transaction: { id: "signed-fixture" } }), /request timeout: synthetic-request-id/);
  assert.equal(f.calls.length, 1);
});

test("contract rejections and unclassified methods are not mistaken for read timeouts", async () => {
  for (const [method, params, error] of [
    ["chain.read_contract", {}, { code: -32603, message: "contract rejected", data: JSON.stringify({ logs: [timeout.message] }) }],
    ["chain.submit_block", {}, timeout],
    ["chain.invoke_system_call", { name: "put_object" }, timeout],
    ["chain.invoke_system_call", { name: "get_contract_address", id: 1 }, timeout],
    ["future.unknown_read", {}, timeout],
  ]) {
    const f = fixture([{ error }, { result: {} }]);
    await assert.rejects(f.provider.call(method, params));
    assert.equal(f.calls.length, 1, method);
  }
});

test("exhausted read timeouts retain the final error and try each endpoint only once", async () => {
  const final = { ...timeout, message: "request timeout: backup-request-id" };
  const f = fixture([{ error: timeout }, { error: final }]);
  await assert.rejects(f.provider.getAccountRc("synthetic-wallet"), /request timeout: backup-request-id/);
  assert.deepEqual(f.calls.map(c => c.url), URLS);
});
