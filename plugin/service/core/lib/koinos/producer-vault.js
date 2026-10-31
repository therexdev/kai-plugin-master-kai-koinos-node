"use strict";
const { randomBytes } = require("node:crypto");
const { Transaction } = require("koilib");
const { isDeepStrictEqual } = require("node:util");
const ORIGIN = "https://koinosai.com", WALLET = "https://koinvault.app";
const clone = value => JSON.parse(JSON.stringify(value));

// Only this fixed wallet service receives session credentials. Never persist
// them in settings/state, log them, or pass a caller-supplied URL to fetch.
async function walletRequest(route, body, method = "POST") {
  const url = new URL("/api/" + route, WALLET);
  if (method === "GET" && body) url.search = new URLSearchParams(body).toString();
  try {
    const response = await fetch(url, { method, redirect: "error", signal: AbortSignal.timeout(15000),
      headers: { Origin: ORIGIN, "Content-Type": "application/json" },
      ...(method === "POST" ? { body: JSON.stringify(body || {}) } : {}) });
    const reader = response.body.getReader(); let size = 0; const chunks = [];
    for (;;) { const { done, value } = await reader.read(); if (done) break;
      size += value.length; if (size > 100000) { await reader.cancel(); throw new Error("oversize"); } chunks.push(value); }
    const data = JSON.parse(Buffer.concat(chunks).toString());
    if (!response.ok || data.ok !== true) {
      const e = new Error(response.status === 404 ? "Koin Vault connection expired or was disconnected. Connect again."
        : response.status === 403 ? "Koin Vault has not enabled KAI connections yet. Update the wallet backend and try again."
        : "Koin Vault could not complete this request. Check the wallet and try again.");
      e.walletError = true; e.status = response.status; throw e;
    }
    return data;
  } catch (e) { if (e.walletError) throw e; throw new Error("Could not reach Koin Vault. Check the wallet before retrying; a sent approval may still be pending."); }
}

class ProducerVault {
  constructor({ custody, chain, request = walletRequest, now = Date.now, recovery = null }) {
    if (recovery) {
      const { VaultRecovery } = require("./vault-recovery");
      if (!(recovery instanceof VaultRecovery) || request === walletRequest) throw Error("Isolated vault recovery requires an injected fixture transport");
      recovery.assertChain(chain);
    }
    Object.assign(this, { custody, chain, request, now, recovery }); this.session = null; this.draft = null; this.pending = null;
    this.restorePending();
  }
  restorePending() {
    if (this.recovery && this.custody.config().address) {
      const saved = this.recovery.pending(this.custody.config().address);
      if (saved && saved.nonceReservation !== this.pending?.nonceReservation) this.pending = saved;
    }
  }
  pair() { if (!this.session || this.session.expiresAt <= this.now()) throw new Error("Connect Koin Vault again."); return { sessionId: this.session.sessionId, secret: this.session.secret }; }
  requireNetwork() { if (this.recovery) return this.recovery.assertChain(this.chain); if (this.chain.network().id !== "mainnet") throw new Error("Koin Vault producer signing currently supports Mainnet only."); }
  hasPending() {
    this.restorePending();
    if (this.recovery && this.pending?.nonceReservation) return ["signing", "signed"].includes(this.recovery.nonces.status(this.pending.nonceReservation).state);
    return !!this.pending && ["sending", "pending", "submitting", "unknown"].includes(this.pending.status) && this.pending.expiresAt > this.now();
  }
  guardMutation() { if (this.hasPending()) throw new Error("Finish or cancel the Koin Vault approval before changing the producer, hot key or network."); this.draft = null; }
  view() {
    const active = this.session && this.session.expiresAt > this.now();
    return { connected: !!(active && this.session.address), address: active ? this.session.address || null : null,
      uri: active && !this.session.address ? this.session.uri : null, expiresAt: active ? this.session.expiresAt : null,
      pending: this.pending ? { status: this.pending.status, txId: this.pending.txId || null, summary: this.pending.summary, note: this.pending.note || "", expiresAt: this.pending.expiresAt } : null };
  }
  async connect() {
    this.requireNetwork();
    if (this.session) throw new Error("Disconnect the existing Koin Vault connection before creating a new QR.");
    const config = await this.request("config", null, "GET");
    if (config.demo || config.network !== this.chain.network().id || config.features?.kaiProducer !== true) throw new Error("Koin Vault's KAI producer update is not available yet. Try again after the wallet backend updates.");
    const made = await this.request("dapp/create", { name: "Koinos AI Test · Producer", icon: ORIGIN + "/favicon.ico" });
    if (!/^[A-Za-z0-9_-]{24}$/.test(made.sessionId) || !/^[A-Za-z0-9_-]{43}$/.test(made.secret) || !Number.isSafeInteger(made.expiresAt) || made.expiresAt <= this.now() || made.expiresAt > this.now() + 31 * 60000) throw new Error("Invalid Koin Vault connection response.");
    this.session = { sessionId: made.sessionId, secret: made.secret, expiresAt: made.expiresAt,
      uri: this.recovery ? "about:blank#isolated-wallet-fixture" : WALLET + "/?connect=" + made.sessionId + "&secret=" + made.secret };
    if (!this.recovery) this.pending = null; this.draft = null; return this.view();
  }
  async status() {
    this.restorePending();
    if (this.recovery && this.pending?.nonceReservation) await this.verifySubmitted();
    if (!this.session) return this.view();
    if (this.session.expiresAt <= this.now()) { this.session = null; this.draft = null; return this.view(); }
    try {
      const info = await this.request("dapp/status", this.pair(), "GET");
      if (info.connected) {
        if (!this.chain.isValidAddress(info.address) || (this.session.address && this.session.address !== info.address)) throw new Error("Koin Vault returned a different or invalid account. Disconnect and scan again.");
        this.session.address = info.address;
      }
      if (this.pending?.requestId && this.hasPending()) {
        const result = await this.request("dapp/request-status", { ...this.pair(), requestId: this.pending.requestId }, "GET");
        if (["pending", "submitting", "rejected", "failed", "approved"].includes(result.status)) {
          this.pending.status = result.status === "approved" ? "submitted" : result.status;
          if (result.status === "approved") {
            if (!/^0x1220[0-9a-f]{64}$/i.test(result.txid || "")) throw new Error("Koin Vault returned an invalid transaction ID.");
            this.pending.txId = result.txid;
            this.pending.note = "Wallet submitted. Checking the transaction on-chain…";
          } else if (result.status === "failed") {
            const detail = typeof result.error === "string" ? result.error.replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, 500).trim() : "";
            this.pending.note = "Wallet submission failed." + (detail ? " " + detail : " Check Koin Vault for the reason.") + " Check wallet history before preparing another request.";
            if (/^0x1220[0-9a-f]{64}$/i.test(result.txid || "")) this.pending.txId = result.txid;
          }
        }
      }
      if (this.pending?.status === "submitted") await this.verifySubmitted();
      if (this.hasPending() === false && this.pending && ["pending", "sending", "unknown"].includes(this.pending.status)) {
        this.pending.status = "expired"; this.pending.note = "Approval expired. Check your wallet history before trying again.";
      }
      return this.view();
    } catch (e) {
      if (e.status === 404) {
        this.session = null; this.draft = null;
        if (this.pending) { this.pending.status = "disconnected"; this.pending.note = "Connection ended. Check wallet history for any approval already submitted."; }
        return this.view();
      }
      throw e;
    }
  }
  async useWallet() {
    this.requireNetwork(); await this.status();
    if (!this.session?.address) throw new Error("Scan the QR and approve the KAI connection in Koin Vault first.");
    this.guardMutation();
    return this.custody.configure({ mode: "external", address: this.session.address });
  }
  assertContext(summary) {
    this.requireNetwork(); this.custody.requireExternal();
    const address = this.custody.config().address;
    if (!this.session?.address || this.session.address !== address || summary && (summary.producer !== address || summary.network !== this.chain.network().id)) throw new Error("Use the connected Koin Vault account as your producer first.");
    if (summary?.action === "register" && summary.publicKey !== this.custody.hotPublicKey()) throw new Error("Hot key changed. Prepare a fresh registration.");
  }
  async prepare(input) {
    if (this.hasPending() || this.pending?.status === "submitted") throw new Error("Finish the existing Koin Vault request first.");
    await this.status(); this.assertContext();
    if (input?.action === "productionAllowance") {
      const config = await this.request("config", null, "GET");
      if (config.features?.kaiProductionAllowance !== true) throw new Error("Koin Vault needs its production-allowance update before this approval can be sent. Your wallet permissions have not changed.");
    }
    if (input?.action === "burn" && input.allowFullVhp === true) {
      const config = await this.request("config", null, "GET");
      if (config.features?.kaiBurnFullVhp !== true) throw new Error("Koin Vault needs its burn-and-allow update. Nothing was burned; retry after the wallet updates.");
    }
    const draft = await this.custody.operations(input);
    this.assertContext(draft.summary);
    this.draft = { ...clone(draft), id: randomBytes(16).toString("hex"), expiresAt: this.now() + 5 * 60000 };
    return { id: this.draft.id, summary: draft.summary, expiresAt: this.draft.expiresAt };
  }
  async send({ confirm, draftId } = {}) {
    const assertActive = require("./operation-lifetime").captureOperation();
    assertActive();
    if (confirm !== true) throw new Error("Review and confirm the operation before requesting wallet approval.");
    if (this.hasPending()) throw new Error("A Koin Vault approval is already pending.");
    const draft = this.draft;
    if (!draft || draft.id !== draftId || draft.expiresAt <= this.now()) throw new Error("Prepare a fresh Koin Vault transaction.");
    await this.status(); this.assertContext(draft.summary);
    const pair = this.pair();
    const active = () => this.draft === draft && draft.expiresAt > this.now() && this.session?.sessionId === pair.sessionId && this.session?.secret === pair.secret && this.session.expiresAt > this.now();
    if (!active()) throw new Error("Prepare a fresh Koin Vault transaction.");
    const reservation = this.recovery ? await this.recovery.begin(draft, () => { this.assertContext(draft.summary); return active(); }) : null;
    this.assertContext(draft.summary);
    if (!active()) { this.restorePending(); throw new Error("Wallet request stopped; recover the retained approval."); }
    assertActive();
    this.draft = null;
    this.pending = { ...draft, ...(reservation ? { nonceReservation: reservation } : {}), status: "sending", expiresAt: Math.min(this.session.expiresAt, this.now() + 10 * 60000) };
    try {
      const result = await this.request("dapp/request", { ...pair, operations: draft.operations, summary: { network: this.chain.network().id } });
      if (!/^[A-Za-z0-9_-]{24}$/.test(result.requestId) || !Number.isSafeInteger(result.expiresAt)) throw new Error("Invalid approval response.");
      this.pending.requestId = result.requestId; this.pending.expiresAt = Math.min(this.pending.expiresAt, result.expiresAt); this.pending.status = "pending";
      return this.view();
    } catch (e) { this.pending.status = "unknown"; this.pending.note = this.recovery ? "Request delivery is uncertain. Recover the original transaction from wallet history; the wallet remains reserved." : "Request delivery is uncertain. Check Koin Vault, or disconnect before retrying."; throw e; }
  }
  async disconnect() {
    if (this.session && this.session.expiresAt > this.now()) {
      try { await this.request("dapp/disconnect", this.pair()); } catch (e) { if (e.status !== 404) throw e; }
    }
    this.session = null; this.draft = null;
    if (this.pending) { this.pending.status = "disconnected"; this.pending.note = "Disconnected. An already submitted transaction cannot be cancelled; check wallet history."; }
    return this.view();
  }
  async verifySubmitted() {
    const p = this.pending;
    if (this.recovery && p?.nonceReservation) {
      this.requireNetwork();
      const r = await this.recovery.check(p.nonceReservation, p.txId);
      if (["finalized", "reverted", "consumed_elsewhere"].includes(r.state)) { p.status = r.state === "finalized" ? "confirmed" : r.state === "reverted" ? "reverted" : "conflicted"; p.txId = r.txId; p.note = r.state === "consumed_elsewhere" ? "Another irreversible transaction consumed this nonce. The original request did not complete." : "Original wallet transaction verified irreversible."; }
      return;
    }
    try {
      const provider = this.chain.provider(), result = await provider.getTransactionsById([p.txId]);
      const entry = result.transactions?.find(x => x.transaction?.id === p.txId), tx = entry?.transaction;
      if (!tx) return;
      const prepared = await Transaction.prepareTransaction(clone(tx));
      if (prepared.id !== p.txId || tx.header.chain_id !== await provider.getChainId() || tx.header.payee !== p.summary.producer || !isDeepStrictEqual(tx.operations, p.operations)) {
        p.status = "mismatch"; p.note = "Returned transaction does not match your request. Check wallet history; registration is not verified."; return;
      }
      // Inclusion in a block alone can refer to a fork. Confirm it is on the
      // current branch before reporting success.
      for (const id of entry.containing_blocks || []) {
        const blocks = await provider.getBlocksById([id], { returnBlock: false, returnReceipt: false });
        const block = blocks.block_items?.[0]; if (!block) continue;
        const canonical = await provider.getBlocks(Number(block.block_height));
        if (!canonical.some(b => b.block_id === id)) continue;
        p.status = "confirmed"; p.note = "Transaction verified on-chain."; return;
      }
    } catch { p.note = "Wallet submitted. Chain confirmation is not available yet; use Verify registration or check the explorer."; }
  }
  // Fixture-only read-only recovery after session loss. Never reconnects or resends.
  async recover({ reservationId, txId }) {
    if (!this.recovery) throw Error("Explicit isolated wallet recovery required");
    this.requireNetwork(); const saved = this.recovery.restore(reservationId);
    if (saved.summary.producer !== this.custody.config().address) throw Error("Wallet recovery owner changed");
    await this.recovery.check(reservationId, txId);
    this.pending = { ...saved, txId: txId || saved.txId }; await this.verifySubmitted(); return this.view();
  }
}
module.exports = { ProducerVault, walletRequest, ORIGIN, WALLET };
