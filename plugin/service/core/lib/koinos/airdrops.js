"use strict";
const { createHash, randomUUID } = require("node:crypto");
const { parseAmount, formatAmount } = require("./format");
const { captureOperation } = require("./operation-lifetime");
const MAX_RECIPIENTS = 2000, MAX_UINT64 = (1n << 64n) - 1n;
const fingerprint = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const amount = value => {
  const text = String(value ?? "").trim();
  if (!/^\d{1,12}(\.\d{1,8})?$/.test(text)) throw Error("Use a positive amount with at most 8 decimals, without thousands separators.");
  const sats = BigInt(parseAmount(text));
  if (sats <= 0n || sats > MAX_UINT64) throw Error("Amount is outside the token range.");
  return sats;
};
function parseRecipients(input, isValidAddress) {
  if (!["koin", "vhp"].includes(input.token)) throw Error("Choose KOIN or VHP.");
  if (!["equal", "amounts"].includes(input.mode)) throw Error("Choose equal split or per-wallet amounts.");
  if (typeof input.text !== "string" || input.text.length > 180000) throw Error("Recipient list is missing or too large.");
  const lines = input.text.replace(/^\uFEFF/, "").split(/\r?\n/).map(x => x.trim()).filter(Boolean);
  if (input.mode === "amounts" && /^address[\t,](token[-_ ]?amount|amount)$/i.test(lines[0] || "")) lines.shift();
  if (input.mode === "equal" && /^address$/i.test(lines[0] || "")) lines.shift();
  const values = input.mode === "equal" ? lines.flatMap(line => line.split(/[\t,\s]+/)) : lines;
  if (!values.length || values.length > MAX_RECIPIENTS) throw Error(`Enter between 1 and ${MAX_RECIPIENTS} wallets.`);
  const seen = new Set();
  const rows = values.map((line, i) => {
    const fields = input.mode === "amounts" ? line.split(/[\t,]/).map(x => x.trim()) : [line];
    if (fields.length !== (input.mode === "amounts" ? 2 : 1)) throw Error(`Row ${i + 1}: use ADDRESS,AMOUNT or two tab-separated columns.`);
    const address = fields[0];
    if (!isValidAddress(address)) throw Error(`Row ${i + 1}: invalid wallet address.`);
    if (seen.has(address)) throw Error(`Row ${i + 1}: duplicate wallet ${address}. Remove or combine it first.`);
    seen.add(address);
    return { address, amountSat: input.mode === "amounts" ? amount(fields[1]).toString() : "0" };
  });
  let remainder = 0n;
  if (input.mode === "equal") {
    const total = amount(input.total), count = BigInt(rows.length), each = total / count;
    remainder = total % count;
    if (!each) throw Error("Total is too small to give every wallet at least 0.00000001 tokens.");
    rows.forEach((row, i) => { row.amountSat = (each + (BigInt(i) < remainder ? 1n : 0n)).toString(); });
  }
  const total = rows.reduce((sum, row) => sum + BigInt(row.amountSat), 0n);
  if (total > MAX_UINT64) throw Error("Airdrop total is outside the token range.");
  return { token: input.token, mode: input.mode, totalSat: total.toString(), remainderWallets: Number(remainder), rows };
}
class Airdrops {
  constructor({ store, chain, wallet, onEvent = () => {} }) {
    Object.assign(this, { store, chain, wallet, onEvent }); this.running = false; this.paused = false;
    const saved = store.get("data", null);
    if (saved && (!Array.isArray(saved.history) || saved.history.length > 20 || (saved.job && !Array.isArray(saved.job.rows)))) throw Error("Airdrop journal needs recovery; original data was preserved.");
    this.data();
  }
  data() {
    const data = structuredClone(this.store.get("data", { job: null, history: [] }));
    if (!data || !Array.isArray(data.history) || data.history.length > 20) throw Error("Airdrop journal needs recovery; original data was preserved.");
    for (const job of [data.job, ...data.history].filter(Boolean)) {
      const fail = () => { throw Error("Airdrop journal needs recovery; original data was preserved."); };
      if (!Array.isArray(job.rows) || !job.rows.length || job.rows.length > MAX_RECIPIENTS || typeof job.id !== "string" ||
          !["koin", "vhp"].includes(job.token) || !["equal", "amounts"].includes(job.mode) || !this.chain.isValidAddress(job.wallet)) fail();
      const seen = new Set();
      for (const row of job.rows) {
        if (!this.chain.isValidAddress(row.address) || seen.has(row.address) || !/^[1-9]\d*$/.test(row.amountSat) ||
            BigInt(row.amountSat) > MAX_UINT64 || !["pending", "submitting", "unknown", "sent"].includes(row.status) || !Array.isArray(row.attempts)) fail();
        seen.add(row.address);
        if (row.status === "sent" && !row.txId || row.txId && row.attempts.at(-1)?.txId !== row.txId) fail();
      }
      const original = { wallet: job.wallet, network: job.network, rpc: job.rpc, token: job.token, mode: job.mode,
        totalSat: job.totalSat, remainderWallets: job.remainderWallets, rows: job.rows.map(({ address, amountSat }) => ({ address, amountSat })) };
      if (fingerprint(original) !== job.fingerprint || job.rows.reduce((n, r) => n + BigInt(r.amountSat), 0n).toString() !== job.totalSat) fail();
    }
    return data;
  }
  save(data) { this.store.set("data", data); this.onEvent({ type: "airdrop" }); }
  context() { return { wallet: this.wallet.status().address, network: this.chain.network().id, rpc: JSON.stringify(this.chain.rpcUrls()) }; }
  preview(input) {
    const plan = { ...this.context(), ...parseRecipients(input, address => this.chain.isValidAddress(address)) };
    if (!plan.wallet) throw Error("Create or import the Node wallet first.");
    if (plan.rows.some(row => row.address === plan.wallet)) throw Error("Remove the sending Node wallet from the recipient list.");
    return { ...plan, fingerprint: fingerprint(plan) };
  }
  create(input) {
    if (this.running) throw Error("Pause the current airdrop first.");
    const plan = this.preview(input);
    if (plan.fingerprint !== input.fingerprint) throw Error("Airdrop changed. Preview the recipients again.");
    const data = this.data();
    if (data.job && data.job.rows.some(row => row.status !== "sent")) throw Error("Finish the existing airdrop before creating another. Its payment record is preserved.");
    if (data.job) data.history.push(data.job);
    if (data.history.length > 20) throw Error("Airdrop history is full. Preserve the journal before starting another campaign.");
    if ([data.job, ...data.history].some(job => job?.fingerprint === plan.fingerprint)) throw Error("This exact airdrop already exists in the payment history.");
    data.job = { ...plan, id: randomUUID(), createdAt: Date.now(), error: null, rows: plan.rows.map(row => ({ ...row, status: "pending", attempts: [] })) };
    this.save(data); return this.status();
  }
  discard({ id }) {
    const job = this.job(id);
    if (this.running || job.rows.some(row => row.status !== "pending" || row.txId || row.attempts.length)) throw Error("Only an unsent draft can be discarded. Payment records are preserved.");
    const data = this.data(); data.job = null; this.save(data); return this.status();
  }
  status() { const data = this.data(); return { job: data.job, history: data.history.map(job => ({ id: job.id, network: job.network, token: job.token, totalSat: job.totalSat, createdAt: job.createdAt, recipientCount: job.rows.length })), running: this.running, pauseRequested: this.paused }; }
  job(id) {
    const job = this.data().job;
    if (!job || job.id !== id) throw Error("Select the current saved airdrop.");
    const ctx = this.context();
    if (job.wallet !== ctx.wallet || job.network !== ctx.network || job.rpc !== ctx.rpc) throw Error("Restore the airdrop's original Node wallet, network and RPC settings before continuing.");
    return job;
  }
  review() {
    const job = this.data().job;
    if (!job) throw Error("Preview and save an airdrop first.");
    this.job(job.id);
    const pending = job.rows.filter(row => row.status !== "sent");
    return { airdropId: job.id, token: job.token.toUpperCase(), wallet: job.wallet, network: job.network,
      recipients: job.rows.length, remainingRecipients: pending.length,
      total: formatAmount(job.totalSat), remainingAmount: formatAmount(pending.reduce((n, r) => n + BigInt(r.amountSat), 0n)),
      recipientListFingerprint: job.fingerprint, paymentStateFingerprint: fingerprint(job),
      notice: "Send to the saved recipient list shown in Airdrops. Transfers cannot be undone. Pause stops after the current transaction. Uncertain transactions are never automatically resent." };
  }
  pause() { this.paused = true; return { pauseRequested: true }; }
  async run({ id, password }) {
    if (this.running) throw Error("An airdrop is already running.");
    let job = this.job(id);
    if (job.rows.some(row => row.status === "unknown" || row.status === "submitting")) throw Error("Check the uncertain transaction before resuming. It will not be resent.");
    const signer = this.wallet.signerFor(password), guard = captureOperation();
    if (signer.getAddress() !== job.wallet) throw Error("Airdrop signer does not match the sending wallet.");
    this.running = true; this.paused = false;
    try {
      guard();
      const balances = await this.chain.balances(job.wallet); guard(); this.job(id);
      const remaining = job.rows.filter(r => r.status === "pending").reduce((n, r) => n + BigInt(r.amountSat), 0n);
      if (BigInt(balances[job.token]) < remaining) throw Error(`Insufficient ${job.token.toUpperCase()} balance for the remaining airdrop.`);
      for (let index = 0; index < job.rows.length; index++) {
        if (this.paused) break;
        guard(); job = this.job(id);
        if (job.rows[index].status !== "pending") continue;
        let data = this.data(), row = data.job.rows[index];
        row.status = "submitting"; data.job.error = null; this.save(data);
        try {
          const tx = await this.chain.submitAirdrop(signer, { ...row, token: job.token }, identity => {
            guard(); this.job(id);
            const next = this.data(), current = next.job.rows[index];
            current.status = "unknown"; current.txId = identity.txId;
            current.attempts.push({ ...identity, at: Date.now() }); this.save(next);
          });
          data = this.data(); row = data.job.rows[index];
          if (!tx?.txId || tx.txId !== row.txId || !tx.confirmed || tx.reverted) throw Error("Transaction outcome is uncertain. Check its recorded transaction ID before continuing.");
          row.status = "sent"; row.blockNumber = tx.blockNumber; row.sentAt = Date.now(); this.save(data);
        } catch (error) {
          data = this.data(); row = data.job.rows[index];
          // Once a transaction identity is journaled, every uncertain outcome
          // blocks replay, even if a downstream error claims no broadcast.
          if (!row.txId && error.airdropNotBroadcast === true) row.status = "pending";
          else row.status = "unknown";
          data.job.error = String(error.message).slice(0, 1000); this.save(data); throw error;
        }
      }
      return this.status();
    } finally { this.running = false; this.onEvent({ type: "airdrop" }); }
  }
  async reconcile({ id }) {
    if (this.running) throw Error("Pause the running airdrop before checking transactions.");
    const job = this.job(id), guard = captureOperation();
    for (let index = 0; index < job.rows.length; index++) {
      const row = job.rows[index];
      if (!["unknown", "submitting"].includes(row.status)) continue;
      let result;
      if (!row.txId) result = { status: "not-broadcast" }; // transport requires durable identity
      else result = await this.chain.airdropOutcome(row.attempts.at(-1));
      guard(); this.job(id);
      if (!result) continue;
      const data = this.data(), current = data.job.rows[index];
      if (result.status === "sent") { current.status = "sent"; current.blockNumber = result.blockNumber; current.sentAt = Date.now(); }
      else if (["reverted", "not-broadcast"].includes(result.status)) {
        if (current.attempts.length) current.attempts.at(-1).outcome = result.status;
        current.status = "pending"; delete current.txId;
      }
      data.job.error = null; this.save(data);
    }
    return this.status();
  }
  csv(id) {
    const data = this.data(), job = [data.job, ...data.history].find(j => j?.id === id);
    if (!job) throw Error("Unknown airdrop report.");
    const quote = value => '"' + String(value ?? "").replace(/"/g, '""') + '"';
    return ["AIRDROP_ID,NETWORK,SENDER,TOKEN,ADDRESS,TOKEN-AMOUNT,STATUS,TRANSACTION_ID,ATTEMPT_IDS", ...job.rows.map(row =>
      [job.id, job.network, job.wallet, job.token.toUpperCase(), row.address, formatAmount(row.amountSat, { grouping: false }), row.status, row.txId, row.attempts.map(a => a.txId).join(";")].map(quote).join(","))].join("\r\n") + "\r\n";
  }
}
module.exports = { Airdrops, parseRecipients, MAX_RECIPIENTS };
