"use strict";
// Injected fixture adapter only. No wallet sessions, secrets, keys or transport.
const { WalletNonceCoordinator } = require("./wallet-nonce");
const { hash } = require("../koin-network/job-protocol");
const { uint } = require("../koin-network/policy");
const { utils } = require("koilib");
class VaultRecovery {
  constructor({ mode, nonces, payer, maxRc }) {
    if (mode !== "isolated-rehearsal" || !(nonces instanceof WalletNonceCoordinator) || !utils.isChecksumAddress(payer) || typeof maxRc !== "string" || !uint(maxRc)) throw Error("Explicit isolated vault recovery policy required");
    Object.assign(this, { nonces, payer, maxRc });
  }
  assertChain(chain) {
    if (chain.network().id !== "isolated") throw Error("Vault recovery requires an isolated fixture chain");
    this.nonces.assertProvider(chain.provider());
  }
  pending(owner) {
    const [r] = this.nonces.pending(owner, "vault");
    return r ? this.restore(r.id) : null;
  }
  restore(id) {
    const r = this.nonces.remoteRequest(id);
    if (r.payer !== this.payer || r.maxRc !== this.maxRc) throw Error("Vault recovery policy changed");
    return { id, nonceReservation: id, operations: r.operations, txId: r.txId,
      summary: { action: "walletApproval", producer: r.owner, network: "isolated" }, expiresAt: null,
      status: r.state === "finalized" ? "confirmed" : r.state === "reverted" ? "reverted" : r.state === "consumed_elsewhere" ? "conflicted" : "unknown",
      note: "Approval retained. Recover the original transaction from wallet history; expiry and disconnection do not release it." };
  }
  async begin(draft, active) {
    const id = hash("wallet:vault:" + draft.id);
    const r = await this.nonces.reserveRemote(id, { owner: draft.summary.producer, payer: this.payer,
      operations: draft.operations, maxRc: this.maxRc }, active);
    if (r.action !== "sign_original") throw Error("Recover the existing Koin Vault request before retrying");
    return id;
  }
  async check(id, txId) {
    this.restore(id);
    return txId ? this.nonces.observeRemote(id, txId) : this.nonces.reconcile(id);
  }
}
module.exports = { VaultRecovery };
