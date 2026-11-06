"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const { Airdrops, parseRecipients } = require("../plugin/service/core/lib/koinos/airdrops");
const { ChainService } = require("../plugin/service/core/lib/koinos/chain");
const { Signer } = require("../plugin/service/node_modules/koilib");
const { runOperation } = require("../plugin/service/core/lib/koinos/operation-lifetime");
const sender = Signer.fromSeed("airdrop synthetic sender, never funded"), a = Signer.fromSeed("airdrop synthetic a").address, b = Signer.fromSeed("airdrop synthetic b").address;
const validator = new ChainService({ get: (_, fallback) => fallback });
const valid = address => validator.isValidAddress(address);
const input = { token: "koin", mode: "equal", total: "1.00000001", text: `${a}\n${b}` };
function fixture() {
  let data = {}, network = "mainnet", failWrite = false;
  const store = { get: (key, fallback) => structuredClone(data[key] ?? fallback), set(key, value) { if (failWrite) throw Error("disk full"); data[key] = structuredClone(value); } };
  const sent = [];
  const chain = { network: () => ({ id: network }), rpcUrls: () => ["http://synthetic.invalid"], isValidAddress: valid,
    balances: async () => ({ koin: "100000000000", vhp: "100000000000" }),
    async submitAirdrop(signer, row, record) { const txId = "tx-" + row.address; await record({ txId, nonce: "KAE", chainId: "synthetic-chain" }); sent.push(row); return { txId, confirmed: true, blockNumber: 42 }; },
    airdropOutcome: async () => null };
  const wallet = { status: () => ({ address: sender.address }), signerFor(password) { if (password !== "proof") throw Error("Incorrect password"); return sender; } };
  const make = () => new Airdrops({ store, chain, wallet });
  const engine = make(), plan = engine.preview(input); engine.create({ ...input, fingerprint: plan.fingerprint });
  return { engine, chain, store, sent, make, setNetwork: v => { network = v; }, failWrites: () => { failWrite = true; }, run: () => engine.run({ id: engine.status().job.id, password: "proof" }) };
}
test("equal split conserves every atomic unit and assigns the remainder in order", () => {
  const plan = parseRecipients(input, valid);
  assert.equal(plan.totalSat, "100000001"); assert.deepEqual(plan.rows.map(r => r.amountSat), ["50000001", "50000000"]);
});
test("CSV, tabs, optional headers and BOM parse exact per-wallet amounts", () => {
  for (const separator of [",", "\t"]) {
    const plan = parseRecipients({ token: "vhp", mode: "amounts", text: `\uFEFFADDRESS${separator}TOKEN-AMOUNT\r\n${a}${separator}12.34567890\r\n${b}${separator}0.00000001` }, valid);
    assert.equal(plan.totalSat, "1234567891"); assert.equal(plan.token, "vhp");
  }
});
test("rejects duplicates, invalid addresses, ambiguous columns and unsafe amounts", () => {
  for (const text of [`${a}\n${a}`, "invalid", `${a.slice(0, -1)}0`]) assert.throws(() => parseRecipients({ ...input, text }, valid));
  for (const value of ["0", "-1", "1e3", "1.123456789", "1,000", "184467440738"]) assert.throws(() => parseRecipients({ ...input, total: value }, valid));
  assert.throws(() => parseRecipients({ ...input, total: "0.00000001" }, valid), /too small/);
  assert.throws(() => parseRecipients({ token: "koin", mode: "amounts", text: `${a},1,000` }, valid), /two tab/);
  assert.throws(() => parseRecipients({ ...input, token: "eth" }, valid), /KOIN or VHP/);
});
test("preview fingerprint binds amounts, wallet, network and recipient order", () => {
  const f = fixture(), plan = f.engine.preview(input);
  assert.throws(() => f.engine.create({ ...input, total: "2", fingerprint: plan.fingerprint }), /changed/);
  f.setNetwork("harbinger"); assert.throws(() => f.engine.job(f.engine.status().job.id), /original/);
});
test("password failure and insufficient token balance never submit", async () => {
  const f = fixture(); await assert.rejects(f.engine.run({ id: f.engine.status().job.id, password: "bad" }), /password/);
  f.chain.balances = async () => ({ koin: "0", vhp: "10000000000" }); await assert.rejects(f.run(), /Insufficient KOIN/); assert.equal(f.sent.length, 0);
});
test("pause after a payment survives restart; resume sends only unpaid rows", async () => {
  const f = fixture(), send = f.chain.submitAirdrop;
  f.chain.submitAirdrop = async (...args) => { const result = await send(...args); f.engine.pause(); return result; };
  await f.run(); assert.equal(f.sent.length, 1); assert.equal(f.engine.status().job.rows[0].status, "sent");
  const reopened = f.make(); f.chain.submitAirdrop = send;
  await reopened.run({ id: reopened.status().job.id, password: "proof" }); assert.equal(f.sent.length, 2);
  assert.equal(reopened.status().job.rows.every(r => r.status === "sent"), true);
  assert.match(reopened.csv(reopened.status().job.id), /0.50000001/);
  assert.throws(() => reopened.create({ ...input, fingerprint: reopened.preview(input).fingerprint }), /already exists/);
});
test("lost response remains unknown after restart and cannot be resent", async () => {
  const f = fixture(); f.chain.submitAirdrop = async (_, row, record) => { await record({ txId: "uncertain", chainId: "chain", nonce: "KAE" }); throw Object.assign(Error("timeout"), { airdropNotBroadcast: true }); };
  await assert.rejects(f.run(), /timeout/); const reopened = f.make(), id = reopened.status().job.id;
  await assert.rejects(reopened.run({ id, password: "proof" }), /uncertain/);
  await reopened.reconcile({ id }); assert.equal(reopened.status().job.rows[0].status, "unknown");
  f.chain.airdropOutcome = async () => ({ status: "sent", blockNumber: 42 });
  await reopened.reconcile({ id }); assert.equal(reopened.status().job.rows[0].status, "sent");
});
test("preflight failure is resumable; reverted irreversible receipt keeps attempt history", async () => {
  const f = fixture(); f.chain.submitAirdrop = async () => { throw Object.assign(Error("no mana"), { airdropNotBroadcast: true }); };
  await assert.rejects(f.run(), /no mana/); assert.equal(f.engine.status().job.rows[0].status, "pending");
  f.chain.submitAirdrop = async (_, row, record) => { await record({ txId: "reverted", chainId: "chain", nonce: "KAE" }); throw Error("reverted"); };
  await assert.rejects(f.run(), /reverted/); f.chain.airdropOutcome = async () => ({ status: "reverted" });
  await f.engine.reconcile({ id: f.engine.status().job.id }); const row = f.engine.status().job.rows[0];
  assert.equal(row.status, "pending"); assert.equal(row.txId, undefined); assert.equal(row.attempts[0].outcome, "reverted");
});
test("durable write failure and cancellation prevent later payments", async () => {
  const f = fixture(); f.failWrites(); await assert.rejects(f.run(), /disk full/); assert.equal(f.sent.length, 0);
  const g = fixture(); let active = true; const send = g.chain.submitAirdrop;
  g.chain.submitAirdrop = async (...args) => { const result = await send(...args); active = false; return result; };
  await assert.rejects(runOperation(() => { if (!active) throw Error("cancelled"); }, g.run), /cancelled/); assert.equal(g.sent.length, 1);
});
test("corrupt saved amounts fail closed without changing the journal", () => {
  const f = fixture(), data = f.store.get("data"); data.job.rows[0].amountSat = "999"; f.store.set("data", data);
  assert.throws(f.make, /journal needs recovery/); assert.equal(f.store.get("data").job.rows[0].amountSat, "999");
});
test("only an untouched draft can be discarded; a completed payment record cannot", async () => {
  const f = fixture(); f.engine.discard({ id: f.engine.status().job.id }); assert.equal(f.engine.status().job, null);
  const g = fixture(); await g.run(); assert.throws(() => g.engine.discard({ id: g.engine.status().job.id }), /unsent draft/);
});
