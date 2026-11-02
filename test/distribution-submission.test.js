"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const { ChainService } = require("../plugin/service/core/lib/koinos/chain");
const { Signer } = require("../plugin/service/node_modules/koilib");
const { NETWORKS } = require("../plugin/service/core/lib/koinos/constants");
const { runOperation, guardKoinosProvider } = require("../plugin/service/core/lib/koinos/operation-lifetime");

function fixture() {
  const signer = Signer.fromSeed("disposable distribution submission fixture only");
  const recipient = Signer.fromSeed("disposable distribution recipient only").address;
  const chain = new ChainService({ get: (_, fallback) => fallback });
  const sent = [], recorded = [];
  const provider = {
    getAccountRc: async () => "10000000000",
    getNextNonce: async () => "KAE",
    getChainId: async () => Buffer.from([18, 32, ...Array(32).fill(0)]).toString("base64url"),
    sendTransaction: async transaction => {
      assert.equal(recorded.at(-1)?.txId, transaction.id, "identity must be durable before transport");
      assert.equal(transaction.signatures.length, 1, "sign exactly once");
      sent.push(structuredClone(transaction));
      return { transaction: { ...transaction, wait: async () => ({ blockNumber: 42 }) }, receipt: { id: transaction.id, reverted: false } };
    },
  };
  chain.provider = () => guardKoinosProvider(provider);
  chain.balances = async () => ({ koin: "10000000000", mana: "10000000000", vhp: "0" });
  chain.resolveContracts = async () => NETWORKS.mainnet.contracts;
  chain._isAllowanceToken = async () => true;
  return { chain, signer, recipient, provider, sent, recorded, record: value => recorded.push(value) };
}

for (const kind of ["reburn", "payout"]) {
  const action = f => ({ kind, amountSat: "500000000", ...(kind === "payout" ? { address: f.recipient } : {}) });
  test(`${kind}: a preflight failure proves no broadcast and retains the original error`, async () => {
    const f = fixture(); f.chain.balances = async () => { throw Error("Synthetic RPC unavailable during balance read"); };
    await assert.rejects(f.chain.submitDistribution(f.signer, action(f), f.record), error => {
      assert.equal(error.distributionNotBroadcast, true); assert.match(error.message, /balance read/); return true;
    });
    assert.equal(f.sent.length, 0); assert.equal(f.recorded.length, 0);
  });

  test(`${kind}: real signed transaction identity is recorded before one broadcast`, async () => {
    const f = fixture(); const result = await f.chain.submitDistribution(f.signer, action(f), f.record);
    assert.equal(result.confirmed, true); assert.equal(f.sent.length, 1);
    assert.equal(result.txId, f.recorded[0].txId); assert.equal(f.recorded[0].nonce, "KAE");
    assert.deepEqual(Object.keys(f.recorded[0]).sort(), ["chainId", "nonce", "txId"]);
  });

  test(`${kind}: a journal failure prevents transport even after signing`, async () => {
    const f = fixture();
    await assert.rejects(f.chain.submitDistribution(f.signer, action(f), () => { throw Error("disk full"); }), error => {
      assert.equal(error.distributionNotBroadcast, true); assert.match(error.message, /disk full/); return true;
    });
    assert.equal(f.sent.length, 0);
  });

  test(`${kind}: a lost response is uncertain even when its text claims insufficient mana`, async () => {
    const f = fixture();
    f.provider.sendTransaction = async () => { throw Object.assign(Error("Not enough mana to send a transaction"), { distributionNotBroadcast: true }); };
    await assert.rejects(f.chain.submitDistribution(f.signer, action(f), f.record), error => {
      assert.equal(error.distributionNotBroadcast, false); return true;
    });
    assert.equal(f.recorded.length, 1);
  });

  test(`${kind}: a reverted submit receipt is never reported as successful`, async () => {
    const f = fixture(); const send = f.provider.sendTransaction;
    f.provider.sendTransaction = async transaction => { const result = await send(transaction); result.receipt.reverted = true; return result; };
    await assert.rejects(f.chain.submitDistribution(f.signer, action(f), f.record), error => {
      assert.equal(error.distributionNotBroadcast, false); assert.match(error.message, /reverted/); return true;
    });
    assert.equal(f.sent.length, 1); assert.equal(f.recorded.length, 1);
  });

  test(`${kind}: cancellation after journaling cannot reach transport`, async () => {
    const f = fixture(); let active = true;
    await runOperation(() => { if (!active) throw Error("cancelled"); }, async () => {
      await assert.rejects(f.chain.submitDistribution(f.signer, action(f), value => { f.record(value); active = false; }), /cancelled/);
    });
    assert.equal(f.sent.length, 0);
  });
}
