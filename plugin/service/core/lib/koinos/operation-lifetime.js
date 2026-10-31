"use strict";

// Optional native-broker context. AsyncLocalStorage binds every awaited step
// (including a cached funding signer) to the operation that was actually
// reviewed. Original standalone callers retain their existing behaviour.
const { AsyncLocalStorage } = require("node:async_hooks");
const context = new AsyncLocalStorage();
const evmTransports = new WeakMap();
const noop = () => {};
function runOperation(assertActive, run) { return context.run(assertActive, run); }
function captureOperation() { return context.getStore() || noop; }

function evmTransport(provider) {
  let state = evmTransports.get(provider);
  if (state) return state;
  state = new Map(); evmTransports.set(provider, state);
  const assertPayload = payload => {
    for (const entry of Array.isArray(payload) ? payload : [payload]) {
      if (entry?.method === "eth_sendRawTransaction") state.get(entry.params?.[0])?.();
    }
  };
  // JsonRpcProvider queues batches outside the caller's async context. Bind
  // each serialized transaction to its own guard, including transport retries.
  if (typeof provider._send === "function") {
    const send = provider._send.bind(provider);
    provider._send = payload => { assertPayload(payload); return send(payload); };
  }
  if (typeof provider._getConnection === "function") {
    const connection = provider._getConnection.bind(provider);
    provider._getConnection = () => {
      const request = connection(), getUrl = request.getUrlFunc;
      request.getUrlFunc = (req, signal) => {
        if (req.body) assertPayload(JSON.parse(Buffer.from(req.body).toString("utf8")));
        return getUrl(req, signal);
      };
      return request;
    };
  }
  return state;
}

function createEvmWallet(privateKey, provider) {
  const { ethers } = require("ethers");
  if (!context.getStore()) return new ethers.Wallet(privateKey, provider);
  // Read the current operation rather than retaining a previous lease: Route C
  // intentionally reuses its signer over several separately coordinated steps.
  const assertActive = () => {
    const guard = context.getStore();
    if (!guard) throw Error("Node signer is outside its approved operation");
    guard();
  };
  const key = new ethers.SigningKey(privateKey);
  const submissions = evmTransport(provider);
  const guardedKey = new Proxy(key, { get(target, name) {
    const value = Reflect.get(target, name, target);
    if (typeof value !== "function") return value;
    return (...args) => { if (name === "sign") assertActive(); return value.apply(target, args); };
  } });
  const guardedProvider = new Proxy(provider, { get(target, name) {
    const value = Reflect.get(target, name, target);
    if (typeof value !== "function") return value;
    return (...args) => {
      if (name !== "broadcastTransaction") return value.apply(target, args);
      assertActive();const guard = captureOperation(), serialized = args[0];
      submissions.set(serialized, guard);
      return Promise.resolve().then(() => {guard();return value.apply(target, args);})
        .finally(() => {if (submissions.get(serialized) === guard) submissions.delete(serialized);});
    };
  } });
  // BaseWallet performs exactly the ethers transaction population/sign/send
  // path; the key guard runs AFTER ENS resolution and immediately before signing.
  return new ethers.BaseWallet(guardedKey, guardedProvider);
}

function guardKoinosProvider(provider) {
  const guard = context.getStore();
  if (!guard) return provider;
  return new Proxy(provider, { get(target, name, receiver) {
    const value = Reflect.get(target, name, receiver);
    if (typeof value !== "function") return value;
    return (...args) => {
      if (name === "sendTransaction" || name === "onError" || (name === "call" && args[0] === "chain.submit_transaction")) guard();
      if (name === "fetchImpl" && args[1]?.body && JSON.parse(args[1].body).method === "chain.submit_transaction") guard();
      // koilib has no private fields. Keep internal call/onError dispatch on
      // the proxy so a cancelled operation cannot retry another RPC endpoint.
      return value.apply(receiver, args);
    };
  } });
}
module.exports = { runOperation, captureOperation, createEvmWallet, guardKoinosProvider };
