"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const { ChainService } = require("../plugin/service/core/lib/koinos/chain");
const { Signer } = require("../plugin/service/node_modules/koilib");
const { NETWORKS } = require("../plugin/service/core/lib/koinos/constants");
const { runOperation, guardKoinosProvider } = require("../plugin/service/core/lib/koinos/operation-lifetime");
function fixture(token) {
  const signer = Signer.fromSeed("synthetic airdrop transfer"), address = Signer.fromSeed("synthetic airdrop recipient").address;
  const chain = new ChainService({ get: (_, fallback) => fallback }), records = [], sent = [];
  const provider = { getAccountRc: async () => "10000000000", getNextNonce: async () => "KAE",
    getChainId: async () => Buffer.from([18,32,...Array(32).fill(0)]).toString("base64url"),
    sendTransaction: async transaction => { assert.equal(records.at(-1)?.txId, transaction.id); assert.equal(transaction.signatures.length, 1); sent.push(transaction);
      return { transaction: { ...transaction, wait: async () => ({ blockNumber: 42 }) }, receipt: { id: transaction.id, reverted: false } }; } };
  chain.provider = () => guardKoinosProvider(provider);
  chain.balances = async () => ({ koin: "10000000000", vhp: "10000000000", mana: "10000000000" });
  chain.resolveContracts = async () => NETWORKS.mainnet.contracts;
  return { chain, signer, provider, records, sent, action: { token, address, amountSat: "100000000" }, record: value => records.push(value) };
}
for (const token of ["koin", "vhp"]) {
  test(`${token} airdrop signs once, journals before broadcast and selects the right token contract`, async () => {
    const f = fixture(token), result = await f.chain.submitAirdrop(f.signer, f.action, f.record);
    assert.equal(result.confirmed, true); assert.equal(f.sent[0].operations[0].call_contract.contract_id, NETWORKS.mainnet.contracts[token]);
    assert.equal(result.txId, f.records[0].txId);
  });
  test(`${token} airdrop never broadcasts if journaling fails`, async () => {
    const f = fixture(token);
    await assert.rejects(f.chain.submitAirdrop(f.signer, f.action, () => { throw Error("disk full"); }), error => error.airdropNotBroadcast === true);
    assert.equal(f.sent.length, 0);
  });
  test(`${token} airdrop cannot misclassify a lost response or send after cancellation`, async () => {
    const f = fixture(token); f.provider.sendTransaction = async () => { throw Object.assign(Error("lost"), { airdropNotBroadcast: true }); };
    await assert.rejects(f.chain.submitAirdrop(f.signer, f.action, f.record), error => error.airdropNotBroadcast === false);
    const g = fixture(token); let active = true;
    await runOperation(() => { if (!active) throw Error("cancelled"); }, async () => {
      await assert.rejects(g.chain.submitAirdrop(g.signer, g.action, value => { g.record(value); active = false; }), /cancelled/);
    }); assert.equal(g.sent.length, 0);
  });
}
test("uncertain airdrop needs a canonical irreversible receipt; no lookup is not safe to resend", async () => {
  const f = fixture("koin"), txId = "synthetic-id", chainId = "synthetic-chain", nonce = "KAE";
  const tx = { id: txId, header: { chain_id: chainId, nonce } };
  let lib = 40, canonical = true, reverted = false;
  Object.assign(f.provider, { getChainId: async () => chainId,
    getTransactionsById: async () => ({ transactions: [{ transaction: tx, containing_blocks: ["block"] }] }),
    getHeadInfo: async () => ({ head_topology: { id: "head", height: "100" }, last_irreversible_block: String(lib), head_block_time: String(Date.now()) }),
    getBlocksById: async () => ({ block_items: [{ block_id: "block", block_height: "42" }] }),
    getBlocks: async () => [{ block_id: canonical ? "block" : "fork", block: { id: "block", header: { height: "42" }, transactions: [tx] }, receipt: { id: "block", height: "42", transaction_receipts: [{ id: txId, reverted }] } }] });
  const id = { txId, chainId, nonce };
  assert.equal(await f.chain.airdropOutcome(id), null);
  lib = 80; canonical = false; assert.equal(await f.chain.airdropOutcome(id), null);
  canonical = true; assert.equal((await f.chain.airdropOutcome(id)).status, "sent");
  reverted = true; assert.equal((await f.chain.airdropOutcome(id)).status, "reverted");
  f.provider.getTransactionsById = async () => ({ transactions: [] }); assert.equal(await f.chain.airdropOutcome(id), null);
});
