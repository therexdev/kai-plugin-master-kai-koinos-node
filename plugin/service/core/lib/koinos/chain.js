"use strict";

const { Contract, Transaction, utils } = require("koilib");
const { createProvider, rpcUrlsForNetwork } = require("../koinos-rpc");
const { NETWORKS, POB_ABI, TOKEN_ABI, BURN_MANA_CUSHION } = require("./constants");
const { cmpSats, subSats, formatAmount } = require("./format");
const { hash } = require("../koin-network/job-protocol");

const RC_LIMIT_CAP = 1000000000n; // never ask for more than 10 KOIN of mana
const MIN_MANA = 5000000n;        // refuse to send with < 0.05 KOIN of mana
const WAIT_TIMEOUT_MS = 60000;

function rpcError(e) {
  let msg = String(e?.message ?? e ?? "RPC error");
  // koilib sometimes surfaces raw JSON errors; extract the useful part.
  try {
    const parsed = JSON.parse(msg);
    if (typeof parsed?.error === "string") {
      msg = parsed.error;
      if (Array.isArray(parsed.logs) && parsed.logs.length > 0) {
        msg += ` — ${parsed.logs[0]}`;
      }
    } else {
      msg = parsed?.error?.message ?? parsed?.message ?? msg;
    }
  } catch {
    /* not JSON */
  }
  return new Error(msg);
}

const CONTRACT_NAMES = ["koin", "vhp", "pob"];
const RESOLVE_TTL_MS = 60 * 60 * 1000;

class ChainService {
  constructor(settings, { nonceCoordinator = null } = {}) {
    if (nonceCoordinator !== null) {
      const { WalletNonceCoordinator } = require("./wallet-nonce");
      if (!(nonceCoordinator instanceof WalletNonceCoordinator)) throw Error("Isolated wallet nonce coordinator required");
    }
    this.settings = settings;
    this.nonceCoordinator = nonceCoordinator;
    this._resolved = {}; // { [networkId]: { addrs, at } }
  }

  clearCache() {
    this._resolved = {};
  }

  // The canonical KOIN/VHP/PoB addresses can change (the token contracts have
  // migrated on mainnet before), so ask the chain via the
  // get_contract_address system call and fall back to the vendored addresses.
  async resolveContracts() {
    const net = this.network();
    const cached = this._resolved[net.id];
    if (cached && Date.now() - cached.at < RESOLVE_TTL_MS) return cached.addrs;
    const provider = this.provider();
    const addrs = { ...net.contracts };
    await Promise.all(
      CONTRACT_NAMES.map(async (name) => {
        try {
          const r = await provider.invokeGetContractAddress(name);
          const a = r?.value?.address;
          if (a && this.isValidAddress(a)) addrs[name] = a;
        } catch {
          /* keep fallback address */
        }
      })
    );
    this._resolved[net.id] = { addrs, at: Date.now() };
    return addrs;
  }

  // KCS-4 tokens (the current mainnet KOIN) only let another contract pull
  // funds through an allowance, so burning via PoB needs an approve operation
  // in the same transaction. Legacy tokens (older deployments, testnets) have
  // no allowance method at all — probe once per network and cache.
  async _isAllowanceToken(provider) {
    const net = this.network();
    const cached = this._allowanceStyle?.[net.id];
    if (cached && Date.now() - cached.at < RESOLVE_TTL_MS) return cached.val;
    let val;
    try {
      const koin = await this._contract("koin", { provider });
      const probe = net.contracts.pob;
      await koin.functions.allowance({ owner: probe, spender: probe });
      val = true;
    } catch {
      val = false;
    }
    (this._allowanceStyle ??= {})[net.id] = { val, at: Date.now() };
    return val;
  }

  network() {
    return NETWORKS[this.settings.get("network", "mainnet")] ?? NETWORKS.mainnet;
  }

  rpcUrls() {
    const net = this.network();
    const custom = this.settings.get(`customRpc.${net.id}`, "");
    return rpcUrlsForNetwork(net, custom);
  }

  provider(urls) {
    return require("./operation-lifetime").guardKoinosProvider(createProvider(urls ?? this.rpcUrls()));
  }

  isValidAddress(address) {
    try {
      return utils.isChecksumAddress(String(address).trim());
    } catch {
      return false;
    }
  }

  async _contract(kind, { signer, provider } = {}) {
    const p = provider ?? this.provider();
    const addrs = await this.resolveContracts();
    if (signer) signer.provider = p;
    // TOKEN_ABI/POB_ABI are vendored from the chain's contract meta store —
    // koilib's bundled tokenAbi trips protobufjs 7.x extension resolution.
    return new Contract({
      id: addrs[kind],
      abi: kind === "pob" ? POB_ABI : TOKEN_ABI,
      provider: p,
      signer,
    });
  }

  async balances(address) {
    const provider = this.provider();
    try {
      const [koin, vhp] = await Promise.all([
        this._contract("koin", { provider }),
        this._contract("vhp", { provider }),
      ]);
      const [k, v, rc] = await Promise.all([
        koin.functions.balance_of({ owner: address }),
        vhp.functions.balance_of({ owner: address }),
        /*
         * No .catch(() => "0") here, deliberately (field bug, 2026-08-27):
         * a flaky public RPC made this read time out and the dashboard
         * showed "0 mana" as if it were true — and maxBurn computed against
         * a mana of zero. "Couldn't read it" must FAIL like the balance
         * reads above, never impersonate a value. A genuinely empty account
         * is the ?? "0" below, on a SUCCESSFUL call.
         */
        provider.getAccountRc(address),
      ]);
      return {
        koin: k?.result?.value ?? "0",
        vhp: v?.result?.value ?? "0",
        mana: rc ?? "0",
      };
    } catch (e) {
      throw rpcError(e);
    }
  }

  async headInfo(urls) {
    try {
      const head = await this.provider(urls).getHeadInfo();
      return {
        height: Number(head.head_topology?.height ?? 0),
        lastIrreversible: Number(head.last_irreversible_block ?? 0),
        headBlockTimeMs: Number(head.head_block_time ?? 0),
      };
    } catch (e) {
      throw rpcError(e);
    }
  }

  // Compares the local node's head with public RPC (when available) and with
  // wall-clock time to report sync progress.
  async syncStatus() {
    const net = this.network();
    const [local, remote] = await Promise.all([
      this.headInfo([net.localRpcUrl]).catch((e) => ({ error: String(e.message) })),
      net.rpcUrls.length > 0
        ? this.headInfo(net.rpcUrls).catch(() => null)
        : Promise.resolve(null),
    ]);
    const out = { local, remote, inSync: false, progressPct: null };
    if (!local.error) {
      out.inSync = Date.now() - local.headBlockTimeMs < 60000;
      if (remote && remote.height > 0) {
        out.progressPct = Math.min(100, (local.height / remote.height) * 100);
      } else if (out.inSync) {
        out.progressPct = 100;
      }
    }
    return out;
  }

  async _rcLimit(provider, address) {
    let rc = 0n;
    try {
      rc = BigInt((await provider.getAccountRc(address)) || "0");
    } catch {
      /* treated as zero */
    }
    if (rc < MIN_MANA) {
      throw new Error(
        "Not enough mana to send a transaction. Keep some liquid KOIN in the wallet and let mana recharge."
      );
    }
    return (rc < RC_LIMIT_CAP ? rc : RC_LIMIT_CAP).toString();
  }

  async _finalize(transaction) {
    const out = { txId: transaction.id, confirmed: false, blockNumber: null };
    try {
      const { blockNumber } = await transaction.wait("by_block", WAIT_TIMEOUT_MS);
      out.confirmed = true;
      out.blockNumber = blockNumber ?? null;
    } catch {
      out.note = "Transaction submitted; confirmation timed out. Check the explorer.";
    }
    return out;
  }

  async _finalizeTx(tx) {
    const out = { txId: tx.transaction?.id ?? null, confirmed: false, blockNumber: null };
    try {
      const { blockNumber } = await tx.wait("by_block", WAIT_TIMEOUT_MS);
      out.confirmed = true;
      out.blockNumber = blockNumber ?? null;
    } catch {
      out.note = "Transaction submitted; confirmation timed out. Check the explorer.";
    }
    return out;
  }

  // Opt-in isolated adapter. Normal wallet construction does not install it.
  // Reserve before signing, persist the exact signature before transport, and
  // retain uncertain requests. There is no automatic retry or new signature.
  async _coordinatedSend(tx, purpose, assertContext = () => {}) {
    const nonces = this.nonceCoordinator; nonces.assertProvider(tx.provider);
    await tx.prepare();
    assertContext();
    const id = hash("wallet:" + purpose + ":" + tx.transaction.id);
    const decision = await nonces.reserve(id, purpose, tx.transaction);
    if (decision.action === "sign_original") {
      assertContext();
      await tx.sign(); await nonces.stage(id, tx.transaction);
      nonces.assertReservation(id, tx.transaction);
      assertContext();
      await tx.send();
    }
    const status = await nonces.reconcile(id);
    return { txId: status.txId, confirmed: status.state === "finalized", reverted: status.state === "reverted",
      nonceReservation: id, note: ["finalized", "reverted"].includes(status.state) ? "Irreversible wallet receipt verified." : "Saved transaction awaits irreversible confirmation. Recover this request before another wallet operation." };
  }

  // How much KOIN can actually be burned/sent right now given current mana.
  // On-chain, both operations require mana >= amount (mana recharges over
  // ~5 days); we keep a small cushion for the transaction's own resource cost.
  burnableFromMana(manaSat) {
    return cmpSats(manaSat, BURN_MANA_CUSHION) > 0 ? subSats(manaSat, BURN_MANA_CUSHION) : "0";
  }

  // Fail early with a clear, actionable message instead of letting the token /
  // PoB contract revert with the opaque "could not burn KOIN".
  _assertMana(amountSat, manaSat, verb) {
    const burnable = this.burnableFromMana(manaSat);
    if (cmpSats(amountSat, burnable) > 0) {
      const doing = verb === "burn" ? "Burning" : "Sending";
      throw new Error(
        `Not enough mana to ${verb} ${formatAmount(amountSat)} KOIN — about ${formatAmount(burnable)} KOIN ` +
          `is available now. ${doing} KOIN spends mana, which recharges over ~5 days; ` +
          `${verb} a smaller amount or wait for mana to refill.`
      );
    }
  }

  // Burn KOIN belonging to `signer` and credit VHP to the same address
  // (or `vhpAddress` when given) via the PoB contract. On KCS-4 KOIN the
  // PoB contract pulls the tokens, so the same transaction first approves
  // exactly the burn amount (the pull consumes the allowance).
  async burn(signer, amountSat, { vhpAddress, beforeBroadcast } = {}) {
    const address = signer.getAddress();
    if (cmpSats(amountSat, "0") <= 0) throw new Error("Burn amount must be positive");
    const { koin, mana } = await this.balances(address);
    if (cmpSats(amountSat, koin) > 0) throw new Error("Insufficient KOIN balance");
    this._assertMana(amountSat, mana, "burn");
    const provider = this.provider();
    const rcLimit = await this._rcLimit(provider, address);
    const addrs = await this.resolveContracts();
    const needsApprove = await this._isAllowanceToken(provider);
    try {
      const koinContract = await this._contract("koin", { signer, provider });
      const pob = await this._contract("pob", { signer, provider });
      const tx = new Transaction({ signer, provider, options: { rcLimit } });
      if (needsApprove) {
        await tx.pushOperation(koinContract.functions.approve, {
          owner: address,
          spender: addrs.pob,
          value: String(amountSat),
        });
      }
      await tx.pushOperation(pob.functions.burn, {
        token_amount: String(amountSat),
        burn_address: address,
        vhp_address: vhpAddress || address,
      });
      if (this.nonceCoordinator) return await this._coordinatedSend(tx, "burn");
      if (beforeBroadcast) await this._sendTracked(tx, beforeBroadcast);
      else await tx.send();
      return await this._finalizeTx(tx);
    } catch (e) {
      throw rpcError(e);
    }
  }

  async transfer(signer, { to, amountSat, token = "koin", assertContext: reviewedContext, beforeBroadcast }) {
    if (reviewedContext !== undefined && typeof reviewedContext !== "function") throw new Error("Invalid wallet transfer context");
    const assertContext = reviewedContext || (() => {});
    assertContext();
    const address = signer.getAddress();
    if (!["koin", "vhp"].includes(token)) throw new Error(`Unknown token: ${token}`);
    if (!this.isValidAddress(to)) throw new Error("Invalid recipient address");
    if (cmpSats(amountSat, "0") <= 0) throw new Error("Amount must be positive");
    const balances = await this.balances(address);
    assertContext();
    if (cmpSats(amountSat, balances[token]) > 0) {
      throw new Error(`Insufficient ${token.toUpperCase()} balance`);
    }
    // KOIN transfers also require mana >= amount on-chain (VHP does not).
    if (token === "koin") this._assertMana(amountSat, balances.mana, "send");
    const provider = this.provider();
    const rcLimit = await this._rcLimit(provider, address);
    assertContext();
    const contract = await this._contract(token, { signer, provider });
    assertContext();
    try {
      if (this.nonceCoordinator || reviewedContext || beforeBroadcast) {
        const tx = new Transaction({ signer, provider, options: { rcLimit } });
        await tx.pushOperation(contract.functions.transfer, { from: address, to: String(to).trim(), value: String(amountSat) });
        assertContext();
        if (this.nonceCoordinator) return await this._coordinatedSend(tx, "send", assertContext);
        if (beforeBroadcast) await this._sendTracked(tx, beforeBroadcast, assertContext);
        else {
          await tx.prepare(); assertContext();
          await tx.sign(); assertContext();
          await tx.send();
        }
        return await this._finalizeTx(tx);
      }
      const { transaction } = await contract.functions.transfer(
        { from: address, to: String(to).trim(), value: String(amountSat) },
        { rcLimit }
      );
      return await this._finalize(transaction);
    } catch (e) {
      throw rpcError(e);
    }
  }

  // Distribution must distinguish a local/preflight failure from an uncertain
  // broadcast. Persist the exact transaction identity BEFORE any transport.
  // The callback is internal native code, never a renderer-supplied function.
  async _sendTracked(tx, beforeBroadcast, assertContext = () => {}) {
    if (typeof beforeBroadcast !== "function") throw new Error("Invalid distribution journal callback");
    await tx.prepare(); assertContext();
    await tx.sign(); assertContext();
    if (!tx.transaction.id || !tx.transaction.signatures?.length) throw new Error("Distribution transaction was not signed");
    await beforeBroadcast({ txId: tx.transaction.id, chainId: tx.transaction.header.chain_id,
      nonce: tx.transaction.header.nonce });
    assertContext();
    // With signatures present, koilib sends this envelope without signing a
    // replacement. Neither keys nor signatures are returned to the renderer.
    const receipt = await tx.send();
    if (receipt?.reverted) throw new Error("Distribution transaction reverted. Verify its recorded transaction ID before retrying.");
  }

  async submitDistribution(signer, action, beforeBroadcast) {
    let broadcastAttempted = false;
    try {
      if (this.nonceCoordinator) throw new Error("Distribution requires its own tracked submission path");
      if (typeof beforeBroadcast !== "function") throw new Error("Distribution journal is required");
      const record = async identity => {
        await beforeBroadcast(identity);
        // Any failure after this boundary remains uncertain. An RPC error,
        // timeout, or rejected response is never proof that nothing was sent.
        broadcastAttempted = true;
      };
      if (action.kind === "reburn") return await this.burn(signer, action.amountSat, { beforeBroadcast: record });
      if (action.kind === "payout") return await this.transfer(signer, {
        to: action.address, amountSat: action.amountSat, token: "koin", beforeBroadcast: record,
      });
      throw new Error("Unknown distribution action");
    } catch (error) {
      const result = rpcError(error);
      // Set from the actual transport boundary, never from error-message text.
      result.distributionNotBroadcast = !broadcastAttempted;
      throw result;
    }
  }

  async submitAirdrop(signer, action, beforeBroadcast) {
    let journaled = false;
    try {
      if (this.nonceCoordinator || typeof beforeBroadcast !== "function") throw Error("Airdrop journal is required.");
      if (!["koin", "vhp"].includes(action.token)) throw Error("Choose KOIN or VHP.");
      return await this.transfer(signer, { to: action.address, amountSat: action.amountSat, token: action.token,
        beforeBroadcast: async identity => { await beforeBroadcast(identity); journaled = true; } });
    } catch (error) {
      const result = rpcError(error); result.airdropNotBroadcast = !journaled; throw result;
    }
  }

  // Only a canonical irreversible receipt can release an uncertain payment.
  // Absence from a node/mempool is never evidence that it is safe to resend.
  async airdropOutcome(identity) {
    if (!identity?.txId || !identity.chainId) return null;
    const provider = this.provider();
    if (await provider.getChainId() !== identity.chainId) throw Error("Airdrop transaction belongs to another chain.");
    const lookup = await provider.getTransactionsById([identity.txId]);
    const records = (lookup?.transactions || []).filter(r => r.transaction?.id === identity.txId);
    if (records.length !== 1) return null;
    const candidates = records[0].containing_blocks || [];
    if (!Array.isArray(candidates) || candidates.length > 100) throw Error("Invalid transaction lookup.");
    if (!candidates.length) return null;
    const head = await provider.getHeadInfo(), lib = Number(head.last_irreversible_block);
    const height = Number(head.head_topology?.height), time = Number(head.head_block_time);
    if (!Number.isSafeInteger(lib) || lib <= 0 || !Number.isSafeInteger(height) || lib > height ||
        !Number.isFinite(time) || Math.abs(Date.now() - time) > 120000) throw Error("Wait for a current chain head before checking this transaction.");
    const blocks = await provider.getBlocksById(candidates, { returnBlock: false, returnReceipt: false });
    for (const item of blocks.block_items || []) {
      const h = Number(item.block_height);
      if (!candidates.includes(item.block_id) || !Number.isSafeInteger(h) || h <= 0 || h > lib) continue;
      const [canonical] = await provider.getBlocks(h, 1, head.head_topology.id, { returnBlock: true, returnReceipt: true });
      if (canonical?.block_id !== item.block_id) continue;
      if (canonical.block?.id !== item.block_id || canonical.receipt?.id !== item.block_id ||
          Number(canonical.block.header?.height) !== h || Number(canonical.receipt.height) !== h) throw Error("Inconsistent airdrop block receipt.");
      const included = canonical.block.transactions?.filter(tx => tx.id === identity.txId);
      const receipts = canonical.receipt.transaction_receipts?.filter(r => r.id === identity.txId);
      if (included?.length !== 1 || receipts?.length !== 1 || receipts[0].rpc_error ||
          ![undefined, false, true].includes(receipts[0].reverted)) throw Error("Missing airdrop transaction receipt.");
      if (included[0].header?.chain_id !== identity.chainId || included[0].header?.nonce !== identity.nonce ||
          await provider.getChainId() !== identity.chainId) throw Error("Airdrop transaction identity changed.");
      return { status: receipts[0].reverted ? "reverted" : "sent", blockNumber: h };
    }
    return null;
  }

  // Registers the node's block-signing public key (base64url, as written by
  // the block producer to public.key) to the producer address.
  async registerProducerKey(signer, publicKeyB64url) {
    const producer = signer.getAddress();
    if (!publicKeyB64url) throw new Error("Missing block producer public key");
    const provider = this.provider();
    const rcLimit = await this._rcLimit(provider, producer);
    const pob = await this._contract("pob", { signer, provider });
    try {
      if (this.nonceCoordinator) {
        const tx = new Transaction({ signer, provider, options: { rcLimit } });
        await tx.pushOperation(pob.functions.register_public_key, { producer, public_key: String(publicKeyB64url).trim() });
        return await this._coordinatedSend(tx, "register");
      }
      const { transaction } = await pob.functions.register_public_key(
        { producer, public_key: String(publicKeyB64url).trim() },
        { rcLimit }
      );
      return await this._finalize(transaction);
    } catch (e) {
      throw rpcError(e);
    }
  }

  // Account history (block-production records, transfers) from the configured
  // RPC. Requires the RPC to run the account_history microservice — the public
  // mainnet endpoint does; a bare local node does not.
  async getAccountHistory(address, { limit = 100, seqNum, ascending = true } = {}) {
    const provider = this.provider();
    const params = { address, limit, ascending, irreversible: false };
    if (seqNum !== undefined && seqNum !== null) params.seq_num = String(seqNum);
    try {
      const res = await provider.call("account_history.get_account_history", params);
      return res?.values ?? [];
    } catch (e) {
      throw rpcError(e);
    }
  }

  async registeredPublicKey(producer, { strict = false } = {}) {
    try {
      const pob = await this._contract("pob");
      // Reverts with "given address has no public key record" when unset.
      const res = await pob.functions.get_public_key({ producer });
      return res?.result?.value ?? null;
    } catch (e) {
      if (strict) throw rpcError(e);
      return null;
    }
  }
}

module.exports = { ChainService };
