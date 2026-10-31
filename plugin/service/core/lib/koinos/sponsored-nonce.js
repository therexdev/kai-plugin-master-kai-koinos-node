"use strict";
// Called only by explicitly injected isolated builders; no submission capability.
async function signSponsored(tx, nonces) {
  const { WalletNonceCoordinator } = require("./wallet-nonce");
  const { hash } = require("../koin-network/job-protocol");
  if (!(nonces instanceof WalletNonceCoordinator)) throw Error("Isolated sponsored nonce coordinator required");
  nonces.assertProvider(tx.provider);
  await tx.prepare();
  const id = hash("wallet:sponsored:" + tx.transaction.id);
  const decision = await nonces.reserve(id, "sponsored", tx.transaction);
  if (decision.action !== "sign_original") throw Error("Recover the existing sponsored transaction before retrying");
  await tx.sign(); await nonces.stage(id, tx.transaction);
  return tx.transaction;
}
module.exports = { signSponsored };
