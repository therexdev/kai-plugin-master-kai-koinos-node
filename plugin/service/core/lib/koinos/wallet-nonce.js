"use strict";
// Explicit rehearsal or Foundation Test configuration; never loads a wallet or key.
const fs = require("fs"), path = require("path"), { DatabaseSync } = require("node:sqlite");
const { sqlitePath } = require("../sqlite-path");
const { isDeepStrictEqual } = require("node:util");
const { Transaction, Signer, utils } = require("koilib");
const { KoinChain } = require("../koin-network/chain");
const { hash, digest, integer } = require("../koin-network/job-protocol");
const { uint } = require("../koin-network/policy");
const { assertPaymentMode } = require("../koin-network/payment-mode");
const Cancel = require("../koin-network/funding-cancel");
const { JournalSet } = require("../koin-network/journal-set");
const terminal = state => ["finalized", "reverted", "consumed_elsewhere"].includes(state);
const purposes = ["funding", "send", "burn", "register", "external", "sponsored", "vault", "credits"];
const ownerOf = tx => tx.header.payee || tx.header.payer;
const objectId = v => { if (typeof v !== "string" || !/^0x1220[a-f0-9]{64}$/.test(v)) throw Error("Invalid wallet transaction ID"); return v; };
const response = v => { if (!v || typeof v !== "object" || Array.isArray(v) || v.error || v.rpc_error) throw Error("Invalid wallet nonce RPC response"); return v; };
function nonce(value) {
  if (typeof value !== "string") throw Error("Canonical wallet nonce required");
  const b = Buffer.from(value, "base64url"); let n = 0n;
  if (b.length < 2 || b.length > 11 || b[0] !== 40) throw Error("Invalid wallet nonce");
  for (let i = 1; i < b.length; i++) n |= BigInt(b[i] & 127) << BigInt(7 * (i - 1));
  uint(n); if (!n) throw Error("Positive wallet nonce required");
  let rest = n; const canonical = [40];
  do { const byte = Number(rest & 127n); rest >>= 7n; canonical.push(byte | (rest ? 128 : 0)); } while (rest);
  if (utils.encodeBase64url(Uint8Array.from(canonical)) !== value) throw Error("Noncanonical wallet nonce");
  return n;
}
function unsigned(tx) { return { id: tx.id, header: structuredClone(tx.header), operations: structuredClone(tx.operations), signatures: [] }; }

class WalletNonceCoordinator {
  #db; #client; #clock; #identity; #guard;
  #confirmations = new Map();
  constructor(directory, { mode, client, clock = Date.now }) {
    assertPaymentMode(mode, client);
    this.#client = client; this.#clock = clock;
    this.#identity = JSON.stringify({ schema: 1, mode, chainId: client.d.chainId, rpc: client.d.rpc });
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.#guard = new JournalSet(directory);
    try {
      const file = path.join(directory, "wallet-nonces.sqlite"); this.#db = new DatabaseSync(sqlitePath(file)); fs.chmodSync(file, 0o600);
      this.#db.exec(`PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
        CREATE TABLE IF NOT EXISTS identity(id INTEGER PRIMARY KEY CHECK(id=1), data TEXT NOT NULL, clock INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS reservations(id TEXT PRIMARY KEY, owner TEXT NOT NULL, state TEXT NOT NULL, tx_id TEXT NOT NULL, hash TEXT NOT NULL, data TEXT NOT NULL);
        CREATE UNIQUE INDEX IF NOT EXISTS active_wallet ON reservations(owner) WHERE state IN ('signing','signed');`);
      this.#guard.attach(this.#db);
      const existing = this.#db.prepare("SELECT data FROM identity WHERE id=1").get();
      if (existing && existing.data !== this.#identity) throw Error("Wallet nonce chain identity changed");
      if (!existing) this.#guard.write(this.#db, () => {
        const saved = this.#db.prepare("SELECT data FROM identity WHERE id=1").get();
        if (saved && saved.data !== this.#identity) throw Error("Wallet nonce chain identity changed");
        if (!saved) {
          if (this.#db.prepare("SELECT 1 FROM reservations LIMIT 1").get()) throw Error("Missing wallet nonce identity");
          this.#db.prepare("INSERT INTO identity VALUES(1,?,?)").run(this.#identity, integer(clock()));
        }
      });
      if (this.#db.prepare("PRAGMA quick_check").get().quick_check !== "ok") throw Error("Corrupt wallet nonce journal");
    } catch (e) { this.#db?.close(); this.#guard.close(); throw e; }
  }
  assertClient(client) { if (client !== this.#client) throw Error("Wallet nonce client mismatch"); }
  assertProvider(provider) { if (provider !== this.#client.provider) throw Error("Wallet nonce provider mismatch"); }
  #now() {
    const r = this.#db.prepare("SELECT * FROM identity WHERE id=1").get(), now = integer(this.#clock());
    if (r?.data !== this.#identity || now < r.clock) throw Error("Wallet nonce identity or clock changed");
    return now;
  }
  #tx(fn) {
    return this.#guard.write(this.#db, () => { this.#db.prepare("UPDATE identity SET clock=? WHERE id=1").run(this.#now()); return fn(); });
  }
  #save(r) {
    r.updatedAt = this.#now(); const data = JSON.stringify(r);
    this.#db.prepare("INSERT INTO reservations VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET state=excluded.state,hash=excluded.hash,data=excluded.data")
      .run(r.id, r.owner, r.state, r.draft.id, hash(data), data);
  }
  #row(id) {
    digest(id); this.#now(); const saved = this.#db.prepare("SELECT * FROM reservations WHERE id=?").get(id);
    if (!saved || saved.hash !== hash(saved.data)) throw Error("Missing or damaged wallet nonce reservation");
    const r = JSON.parse(saved.data);
    if (r.id !== id || r.owner !== saved.owner || r.state !== saved.state || r.draft.id !== saved.tx_id ||
        r.owner !== ownerOf(r.draft) || r.draft.header.chain_id !== this.#client.d.chainId ||
        !purposes.includes(r.purpose) || (r.remote !== undefined && r.remote !== true) || (r.remote && r.purpose !== "vault") ||
        !["signing", "signed", "finalized", "reverted", "consumed_elsewhere"].includes(r.state) || r.draftHash !== hash(JSON.stringify(r.draft)) ||
        (r.transaction && (r.transactionHash !== hash(JSON.stringify(r.transaction)) || !this.#matches(r, r.transaction))) ||
        (!r.transaction && !["signing", "consumed_elsewhere"].includes(r.state))) throw Error("Damaged wallet nonce binding");
    nonce(r.draft.header.nonce); objectId(r.draft.id); integer(r.createdAt); integer(r.updatedAt, r.createdAt);
    if (r.correction !== undefined) this.#validateCorrection(r);
    if (r.cancellation !== undefined) this.#validateCancellation(r);
    return r;
  }
  status(id) {
    const r = this.#row(id), c = r.correction;
    return { id, owner: r.owner, payer: r.draft.header.payer, purpose: r.purpose, state: r.state,
      txId: r.transaction?.id || (r.remote ? null : r.draft.id), nonce: r.draft.header.nonce, finality: structuredClone(r.finality),
      ...(r.cancellation ? { cancellation: { state: r.cancellation.state, txId: r.cancellation.draft.id, attempts: r.cancellation.submissions.length, finality: structuredClone(r.cancellation.finality) } } : {}),
      ...(c ? { correction: { state: c.state, txId: c.draft.id, rcLimit: c.draft.header.rc_limit,
        nonce: c.draft.header.nonce, attempts: c.submissions.length, finality: structuredClone(c.finality) } } : {}) };
  }
  // Display-only observations do not release nonce reservations or credit a
  // payment. Reversible inclusion must remain distinct from finality.
  confirmation(id) {
    const r = this.#row(id), values = [r.transaction, r.correction?.transaction, r.cancellation?.transaction]
      .filter(Boolean).map(tx => this.#confirmations.get(tx.id))
      .filter(v => v && this.#now() >= v.checkedAt && this.#now() - v.checkedAt < 30000);
    const observed = values.find(v => ["finalized", "reverted"].includes(v.state)) || values.find(v => v.state === "included") || values[0];
    return observed ? structuredClone(observed) : null;
  }
  #confirmation(value) {
    this.#confirmations.delete(value.txId);
    this.#confirmations.set(value.txId, value);
    while (this.#confirmations.size > 32) this.#confirmations.delete(this.#confirmations.keys().next().value);
  }
  pending(owner, purpose) {
    if (!utils.isChecksumAddress(owner) || !purposes.includes(purpose)) throw Error("Invalid pending wallet request");
    return this.#db.prepare("SELECT id FROM reservations WHERE owner=? AND state IN ('signing','signed')").all(owner)
      .map(r => this.status(r.id)).filter(r => r.purpose === purpose);
  }
  remoteRequest(id) {
    const r = this.#row(id); if (!r.remote) throw Error("Remote wallet reservation required");
    return { ...this.status(id), operations: structuredClone(r.draft.operations), maxRc: r.draft.header.rc_limit };
  }
  #matches(r, tx) {
    const draft = unsigned(tx);
    if (r.remote) {
      if (!uint(tx.header.rc_limit) || uint(tx.header.rc_limit) > uint(r.draft.header.rc_limit)) return false;
      draft.header.rc_limit = r.draft.header.rc_limit; draft.id = r.draft.id;
      return isDeepStrictEqual(draft, r.draft);
    }
    return isDeepStrictEqual(draft, r.draft);
  }
  envelope(id) { return structuredClone(this.#row(id).transaction); }
  draft(id) { return structuredClone(this.#row(id).draft); }
  correction(id) { return structuredClone(this.#row(id).correction ?? null); }
  cancellation(id) { return structuredClone(this.#row(id).cancellation ?? null); }
  #validateCancellation(r) {
    const c = r.cancellation;
    if (r.purpose !== "funding" || r.remote || !r.transaction || !c ||
        !["signing", "signed", "finalized", "reverted", "superseded"].includes(c.state) ||
        !Cancel.matches(this.#client.d, r.draft, c.draft) || c.draftHash !== hash(JSON.stringify(c.draft)) ||
        !Array.isArray(c.submissions) || c.submissions.length > 3 ||
        (!c.transaction && !["signing", "superseded"].includes(c.state)) ||
        (c.transaction && (c.transactionHash !== hash(JSON.stringify(c.transaction)) ||
          !isDeepStrictEqual(unsigned(c.transaction), c.draft)))) throw Error("Damaged payment cancellation");
    integer(c.createdAt, r.createdAt); integer(c.updatedAt, c.createdAt, r.updatedAt);
    for (const a of c.submissions) {
      integer(a.at, c.createdAt, c.updatedAt);
      if (a.day !== String(Math.floor(a.at / 86400000))) throw Error("Damaged cancellation attempt");
    }
    if (c.submissions.length && (!c.submissionPolicy || c.submissions.length > c.submissionPolicy.maxAttempts)) throw Error("Missing cancellation resource policy");
    if (c.submissionPolicy) {
      integer(c.submissionPolicy.maxAttempts, 1, 3); integer(c.submissionPolicy.minRetryMs, 1000, 3600000);
      if (uint(c.submissionPolicy.maxRcPerDay) < uint(c.draft.header.rc_limit) ||
          !isDeepStrictEqual(c.submissionPolicy, r.submissionPolicy)) throw Error("Cancellation resource policy changed");
    }
    if ((r.state === "signed" && !["signing", "signed"].includes(c.state)) ||
        (["finalized", "reverted"].includes(r.state) && c.state !== "superseded") ||
        (r.state === "consumed_elsewhere" && !["finalized", "reverted", "superseded"].includes(c.state))) throw Error("Cancellation finality changed");
  }
  async reserveCancellation(id, transaction, active = () => true) {
    const draft = structuredClone(transaction); await this.#verify(draft);
    const initial = this.#row(id);
    if (initial.purpose !== "funding" || initial.remote || !initial.transaction ||
        !Cancel.matches(this.#client.d, initial.draft, draft)) throw Error("Exact zero-transfer cancellation required");
    if (await this.#client.provider.getChainId() !== this.#client.d.chainId ||
        await this.#client.provider.getNextNonce(initial.owner) !== draft.header.nonce) throw Error("Wallet chain or nonce changed");
    return this.#tx(() => {
      if (!active()) throw Error("Payment cancellation stopped");
      const r = this.#row(id);
      if (r.cancellation) {
        if (!isDeepStrictEqual(r.cancellation.draft, draft)) throw Error("Cannot replace saved cancellation");
        return { action: "recover_existing", ...this.status(id) };
      }
      if (r.state !== "signed") throw Error("Unresolved signed payment required");
      const now = this.#now();
      r.cancellation = { draft, draftHash: hash(JSON.stringify(draft)), transaction: null, transactionHash: null,
        state: "signing", createdAt: now, updatedAt: now, submissions: [], finality: null };
      this.#save(r); return { action: "sign_original", ...this.status(id) };
    });
  }
  async stageCancellation(id, transaction) {
    const tx = structuredClone(transaction); await this.#verify(tx); this.#signatures(tx, true);
    return this.#tx(() => {
      const r = this.#row(id), c = r.cancellation;
      if (!c || !isDeepStrictEqual(unsigned(tx), c.draft)) throw Error("Original cancellation envelope required");
      if (c.transaction) {
        if (c.transactionHash !== hash(JSON.stringify(tx))) throw Error("Cannot replace cancellation signature");
        return this.status(id);
      }
      if (!["signing", "superseded"].includes(c.state)) throw Error("Missing cancellation signing fence");
      c.transaction = tx; c.transactionHash = hash(JSON.stringify(tx));
      if (c.state === "signing") c.state = "signed";
      c.updatedAt = this.#now(); this.#save(r); return this.status(id);
    });
  }
  authorizeCancellationSubmission(id, { maxRcPerDay, maxAttempts = 3, minRetryMs = 1000 }) {
    const budget = uint(maxRcPerDay); integer(maxAttempts, 1, 3); integer(minRetryMs, 1000, 3600000);
    if (!budget) throw Error("Positive wallet resource budget required");
    return this.#tx(() => {
      const r = this.#row(id), c = r.cancellation, now = this.#now(), day = String(Math.floor(now / 86400000));
      if (r.state !== "signed" || c?.state !== "signed" || !c.transaction) throw Error("Unresolved signed cancellation required");
      const policy = { maxRcPerDay, maxAttempts, minRetryMs };
      if ((r.submissionPolicy && !isDeepStrictEqual(r.submissionPolicy, policy)) ||
          (c.submissionPolicy && !isDeepStrictEqual(c.submissionPolicy, policy))) throw Error("Cancellation resource policy changed");
      if (c.submissions.length >= maxAttempts || (c.submissions.length && now < c.submissions.at(-1).at + minRetryMs)) throw Error("Cancellation retry limit reached");
      const existing = [r, r.correction, c].filter(Boolean).reduce((used, record) => {
        const cost = (record.submissions || []).some(a => a.day === day) ? uint(record.draft.header.rc_limit) : 0n;
        return cost > used ? cost : used;
      }, 0n), rc = uint(c.draft.header.rc_limit);
      if (this.#dailyUsed(r.owner, day) + (rc > existing ? rc - existing : 0n) > budget) throw Error("Daily wallet resource budget exhausted");
      c.submissionPolicy = policy; c.submissions.push({ at: now, day }); c.updatedAt = now;
      if (!r.submissionPolicy) r.submissionPolicy = policy;
      this.#save(r); return structuredClone(c.transaction);
    });
  }
  #correctionMatches(r, draft) {
    if (r.purpose !== "funding" || r.remote || !r.transaction || r.draft.header.payee !== undefined ||
        !draft || draft.header?.payee !== undefined || !uint(draft.header?.rc_limit) ||
        uint(draft.header.rc_limit) <= uint(r.draft.header.rc_limit) || draft.id === r.draft.id) return false;
    const originalTerms = structuredClone(draft);
    originalTerms.header.rc_limit = r.draft.header.rc_limit; originalTerms.id = r.draft.id;
    return isDeepStrictEqual(originalTerms, r.draft);
  }
  #validateCorrection(r) {
    const c = r.correction;
    if (!c || !["signing", "signed", "finalized", "reverted", "superseded"].includes(c.state) ||
        !this.#correctionMatches(r, c.draft) || c.draftHash !== hash(JSON.stringify(c.draft)) ||
        !Array.isArray(c.submissions) || c.submissions.length > 3 ||
        (!c.transaction && !["signing", "superseded"].includes(c.state)) ||
        (c.transaction && (c.transactionHash !== hash(JSON.stringify(c.transaction)) ||
          !isDeepStrictEqual(unsigned(c.transaction), c.draft)))) throw Error("Damaged wallet Mana correction");
    integer(c.createdAt, r.createdAt); integer(c.updatedAt, c.createdAt, r.updatedAt);
    for (const a of c.submissions) {
      integer(a.at, c.createdAt, c.updatedAt);
      if (a.day !== String(Math.floor(a.at / 86400000))) throw Error("Damaged correction submission history");
    }
    if (c.submissions.length && (!c.submissionPolicy || c.submissions.length > c.submissionPolicy.maxAttempts)) throw Error("Missing correction submission policy");
    if (c.submissionPolicy) {
      integer(c.submissionPolicy.maxAttempts, 1, 3); integer(c.submissionPolicy.minRetryMs, 1000, 3600000);
      if (uint(c.submissionPolicy.maxRcPerDay) < uint(c.draft.header.rc_limit)) throw Error("Damaged correction resource policy");
    }
    if (c.submissionPolicy && r.submissionPolicy && !isDeepStrictEqual(c.submissionPolicy, r.submissionPolicy)) throw Error("Correction wallet policy changed");
    if ((r.state === "signed" && !["signing", "signed"].includes(c.state)) ||
        (["finalized", "reverted"].includes(r.state) && c.state !== "superseded") ||
        (r.state === "consumed_elsewhere" && !["finalized", "reverted", "superseded"].includes(c.state))) throw Error("Damaged correction finality binding");
  }
  // One exact alternative for the same owner nonce. The original remains intact
  // and owns the wallet until either envelope is irreversibly included.
  async reserveCorrection(id, transaction, active = () => true) {
    const draft = structuredClone(transaction); await this.#verify(draft);
    if (draft.signatures?.length) throw Error("Reserve the Mana correction before signing");
    const initial = this.#row(id);
    if (!this.#correctionMatches(initial, unsigned(draft))) throw Error("Mana correction must preserve the exact funding transaction and nonce");
    if (await this.#client.provider.getChainId() !== this.#client.d.chainId ||
        await this.#client.provider.getNextNonce(initial.owner) !== draft.header.nonce) throw Error("Wallet chain or nonce changed");
    return this.#tx(() => {
      if (!active()) throw Error("Wallet Mana correction stopped");
      const r = this.#row(id);
      if (r.cancellation) throw Error("Use the saved cancellation; a Mana correction cannot replace it");
      if (r.correction) {
        if (!isDeepStrictEqual(r.correction.draft, unsigned(draft))) throw Error("Cannot replace the saved Mana correction");
        return { action: "recover_existing", ...this.status(id) };
      }
      if (r.state !== "signed" || !this.#correctionMatches(r, unsigned(draft))) throw Error("Unresolved signed funding transaction required");
      if (r.submissionPolicy && uint(draft.header.rc_limit) > uint(r.submissionPolicy.maxRcPerDay)) throw Error("Mana correction exceeds the existing daily budget");
      const now = this.#now();
      r.correction = { draft: unsigned(draft), draftHash: hash(JSON.stringify(unsigned(draft))), transaction: null,
        transactionHash: null, state: "signing", createdAt: now, updatedAt: now, submissions: [], finality: null };
      this.#save(r); return { action: "sign_original", ...this.status(id) };
    });
  }
  async stageCorrection(id, transaction) {
    const tx = structuredClone(transaction); await this.#verify(tx); this.#signatures(tx, true);
    return this.#tx(() => {
      const r = this.#row(id), c = r.correction;
      if (!c || !isDeepStrictEqual(unsigned(tx), c.draft)) throw Error("Original Mana correction envelope required");
      if (c.transaction) {
        if (c.transactionHash !== hash(JSON.stringify(tx))) throw Error("Cannot replace the saved Mana correction signature");
        return this.status(id);
      }
      // Preserve a late signature even if the original has won in the meantime.
      if (!["signing", "superseded"].includes(c.state)) throw Error("Missing Mana correction signing fence");
      c.transaction = tx; c.transactionHash = hash(JSON.stringify(tx));
      if (c.state === "signing") c.state = "signed";
      c.updatedAt = this.#now(); this.#save(r); return this.status(id);
    });
  }
  #dailyUsed(owner, day, except = null) {
    let spent = 0n;
    for (const row of this.#db.prepare("SELECT id FROM reservations WHERE owner=?").all(owner)) {
      if (row.id === except) continue;
      const other = this.#row(row.id), original = (other.submissions || []).some(a => a.day === day) ? uint(other.draft.header.rc_limit) : 0n;
      const corrected = other.correction?.submissions.some(a => a.day === day) ? uint(other.correction.draft.header.rc_limit) : 0n;
      // These envelopes use one identical owner nonce; only one can execute.
      const cancelled = other.cancellation?.submissions.some(a => a.day === day) ? uint(other.cancellation.draft.header.rc_limit) : 0n;
      const reserved = [original, corrected, cancelled].reduce((a, b) => a > b ? a : b);
      const f = other.finality;
      // Only an exact saved envelope's canonical irreversible receipt can
      // release unused headroom. Older proofs and unknown consuming envelopes
      // retain their ceiling. Earlier submission days remain conservative.
      const winner = [other, other.correction, other.cancellation].filter(Boolean).find(record =>
        ["finalized", "reverted"].includes(record.state) && record.transaction?.id === f?.txId &&
        record.finality?.txId === f.txId && record.finality?.blockId === f.blockId);
      const actual = terminal(other.state) && winner && typeof f.actualRc === "string" &&
        /^(0|[1-9]\d*)$/.test(f.actualRc) && uint(f.actualRc) <= uint(winner.draft.header.rc_limit) &&
        /^(0|[1-9]\d*)$/.test(f.resourceDay || "") && f.resourceDay === day
        ? uint(f.actualRc) : null;
      spent += actual === null ? reserved : actual;
    }
    return spent;
  }
  availableSubmissionRc(owner, maxRcPerDay) {
    if (!utils.isChecksumAddress(owner)) throw Error("Valid payment wallet required");
    const budget = uint(maxRcPerDay), day = String(Math.floor(this.#now() / 86400000));
    if (!budget) throw Error("Positive wallet resource budget required");
    const used = this.#dailyUsed(owner, day);
    return String(used < budget ? budget - used : 0n);
  }
  availableCorrectionRc(id, maxRcPerDay) {
    const r = this.#row(id), budget = uint(maxRcPerDay), day = String(Math.floor(this.#now() / 86400000));
    if (!budget || r.purpose !== "funding" || r.remote || r.state !== "signed" || r.cancellation)
      throw Error("Unresolved funding transaction required for a Mana review");
    if (r.submissionPolicy && r.submissionPolicy.maxRcPerDay !== maxRcPerDay)
      throw Error("Wallet submission policy changed");
    // Replacing this nonce shares its reservation, but earlier payments and
    // cancellations still count against today's unchanged wallet limit.
    const used = this.#dailyUsed(r.owner, day, id);
    return String(used < budget ? budget - used : 0n);
  }
  authorizeCorrectionSubmission(id, { maxRcPerDay, maxAttempts = 3, minRetryMs = 1000 }) {
    const budget = uint(maxRcPerDay); integer(maxAttempts, 1, 3); integer(minRetryMs, 1000, 3600000);
    if (!budget) throw Error("Positive wallet resource budget required");
    return this.#tx(() => {
      const r = this.#row(id), c = r.correction, now = this.#now(), day = String(Math.floor(now / 86400000));
      if (r.cancellation) throw Error("Use the saved cancellation; the Mana correction cannot be resubmitted");
      if (r.state !== "signed" || c?.state !== "signed" || !c.transaction) throw Error("Unresolved signed Mana correction required");
      const policy = { maxRcPerDay, maxAttempts, minRetryMs };
      if ((r.submissionPolicy && !isDeepStrictEqual(r.submissionPolicy, policy)) ||
          (c.submissionPolicy && !isDeepStrictEqual(c.submissionPolicy, policy))) throw Error("Wallet submission policy changed");
      const attempts = c.submissions;
      if (attempts.length >= maxAttempts || (attempts.length && now < attempts.at(-1).at + minRetryMs)) throw Error("Wallet correction retry limit reached");
      const rc = uint(c.draft.header.rc_limit), originalToday = (r.submissions || []).some(a => a.day === day) ? uint(r.draft.header.rc_limit) : 0n;
      const current = attempts.some(a => a.day === day) ? rc : originalToday;
      if (this.#dailyUsed(r.owner, day) + rc - current > budget) throw Error("Daily wallet resource budget exhausted");
      c.submissionPolicy = policy; c.submissions = [...attempts, { at: now, day }]; c.updatedAt = now;
      if (!r.submissionPolicy) r.submissionPolicy = policy;
      this.#save(r); return structuredClone(c.transaction);
    });
  }
  // Called immediately before transport. Persist attempts even if the caller
  // crashes before sending; an uncertain acknowledgment never resets a budget.
  authorizeSubmission(id, { maxRcPerDay, maxAttempts = 3, minRetryMs = 1000 }) {
    const budget = uint(maxRcPerDay); integer(maxAttempts, 1, 20); integer(minRetryMs, 1000, 3600000);
    if (!budget) throw Error("Positive wallet resource budget required");
    return this.#tx(() => {
      const r = this.#row(id), now = this.#now(), day = String(Math.floor(now / 86400000));
      if (r.state !== "signed") throw Error("Unresolved signed envelope required");
      if (r.cancellation) throw Error("Use the saved cancellation; the original cannot be resubmitted");
      if (r.correction) throw Error("Use the saved Mana correction; the original cannot be resubmitted");
      const policy = { maxRcPerDay, maxAttempts, minRetryMs };
      if (r.submissionPolicy && JSON.stringify(r.submissionPolicy) !== JSON.stringify(policy)) throw Error("Wallet submission policy changed");
      const attempts = r.submissions || [];
      if (attempts.length >= maxAttempts || (attempts.length && now < attempts.at(-1).at + minRetryMs)) throw Error("Wallet retry limit reached");
      const spent = this.#dailyUsed(r.owner, day);
      if (!attempts.some(a => a.day === day) && spent + uint(r.draft.header.rc_limit) > budget) throw Error("Daily wallet resource budget exhausted");
      r.submissionPolicy = policy; r.submissions = [...attempts, { at: now, day }]; this.#save(r);
      return structuredClone(r.transaction);
    });
  }
  list() { return this.#db.prepare("SELECT id FROM reservations ORDER BY rowid DESC LIMIT 200").all().map(r => this.status(r.id)); }
  assertReservation(id, tx) {
    const r = this.#row(id);
    if (!this.#matches(r, tx)) throw Error("Wallet reservation requires the original transaction");
    return this.status(id);
  }
  async #verify(tx) {
    if (!tx || Object.keys(tx).some(k => !["id", "header", "operations", "signatures"].includes(k)) ||
        !tx.header || !["chain_id,nonce,operation_merkle_root,payer,rc_limit", "chain_id,nonce,operation_merkle_root,payee,payer,rc_limit"].includes(Object.keys(tx.header).sort().join()) ||
        tx.header.chain_id !== this.#client.d.chainId || !utils.isChecksumAddress(tx.header.payer) ||
        (tx.header.payee !== undefined && (!utils.isChecksumAddress(tx.header.payee) || tx.header.payee === tx.header.payer)) ||
        typeof tx.header.rc_limit !== "string" || !uint(tx.header.rc_limit) ||
        !Array.isArray(tx.operations) || !tx.operations.length || tx.operations.length > 16 ||
        tx.operations.some(o => !o || Object.keys(o).join() !== "call_contract" || !o.call_contract ||
          Object.keys(o.call_contract).sort().join() !== "args,contract_id,entry_point" || !utils.isChecksumAddress(o.call_contract.contract_id) ||
          !Number.isInteger(o.call_contract.entry_point) || o.call_contract.entry_point < 0 || o.call_contract.entry_point > 4294967295 ||
          typeof o.call_contract.args !== "string" || o.call_contract.args.length > 65536) ||
        (tx.signatures !== undefined && !Array.isArray(tx.signatures))) throw Error("Exact wallet transaction required");
    nonce(tx.header.nonce); objectId(tx.id);
    if ((await Transaction.prepareTransaction(structuredClone(tx))).id !== tx.id) throw Error("Wallet transaction commitment changed");
  }
  async reserve(id, purpose, transaction, active = () => true) {
    if (purpose === "vault") throw Error("Use the remote wallet reservation boundary");
    return this.#reserve(id, purpose, transaction, active, false);
  }
  async reserveRemote(id, { owner, payer, operations, maxRc }, active = () => true) {
    const p = this.#client.provider;
    const tx = new Transaction({ provider: p, options: { payer, payee: owner, rcLimit: maxRc } });
    for (const op of structuredClone(operations)) await tx.pushOperation(op);
    await tx.prepare({ chainId: this.#client.d.chainId, nonce: await p.getNextNonce(owner) });
    return this.#reserve(id, "vault", tx.transaction, active, true);
  }
  async #reserve(id, purpose, transaction, active, remote) {
    digest(id); if (!purposes.includes(purpose)) throw Error("Unknown wallet purpose");
    const tx = structuredClone(transaction); await this.#verify(tx);
    if (purpose === "funding" && tx.header.payee !== undefined) throw Error("Funding requires owner-paid transactions");
    if (tx.signatures?.length) throw Error("Reserve the wallet nonce before exposing a signing request");
    const draft = unsigned(tx), owner = ownerOf(tx);
    if (await this.#client.provider.getChainId() !== this.#client.d.chainId || await this.#client.provider.getNextNonce(owner) !== tx.header.nonce) throw Error("Wallet chain or nonce changed");
    return this.#tx(() => {
      if (!active()) throw Error("Wallet signing request stopped");
      if (this.#db.prepare("SELECT 1 FROM reservations WHERE id=?").get(id)) {
        const r = this.#row(id); this.assertReservation(id, draft);
        if (r.purpose !== purpose || !!r.remote !== remote || r.draftHash !== hash(JSON.stringify(draft))) throw Error("Cannot replace wallet transaction purpose or policy");
        return { action: "recover_existing", ...this.status(id) };
      }
      if (this.#db.prepare("SELECT 1 FROM reservations WHERE owner=? AND state IN ('signing','signed')").get(owner)) throw Error("Another transaction owns this wallet nonce; recover it first");
      for (const prior of this.#db.prepare("SELECT id FROM reservations WHERE owner=?").all(owner))
        if (nonce(tx.header.nonce) <= nonce(this.#row(prior.id).draft.header.nonce)) throw Error("Wallet nonce did not advance");
      this.#save({ id, owner, purpose, state: "signing", draft, draftHash: hash(JSON.stringify(draft)), transaction: null,
        transactionHash: null, createdAt: this.#now(), finality: null, ...(remote ? { remote: true } : {}) });
      return { action: "sign_original", ...this.status(id) };
    });
  }
  async stage(id, transaction) {
    const tx = structuredClone(transaction); await this.#verify(tx); this.assertReservation(id, tx);
    this.#signatures(tx, this.#row(id).remote);
    return this.#tx(() => {
      const r = this.#row(id);
      if (r.transaction) {
        if (r.transactionHash === hash(JSON.stringify(tx))) return this.status(id);
        if (terminal(r.state) || r.remote || r.transaction.id !== tx.id || r.transaction.signatures.length >= tx.signatures.length ||
            r.transaction.signatures.some(sig => !tx.signatures.includes(sig))) throw Error("Cannot replace wallet signature");
      }
      if (terminal(r.state)) throw Error("Resolved wallet reservations cannot receive new signatures");
      r.transaction = tx; r.transactionHash = hash(JSON.stringify(tx)); r.state = "signed"; this.#save(r); return this.status(id);
    });
  }
  #signatures(tx, complete = false) {
    const owner = ownerOf(tx), allowed = new Set([owner, tx.header.payer]), signers = new Set();
    if (!tx.signatures?.length || tx.signatures.length > allowed.size) throw Error("Original wallet owner signature required");
    for (const sig of tx.signatures) {
      if (typeof sig !== "string" || Buffer.from(sig, "base64url").length !== 65 || utils.encodeBase64url(Buffer.from(sig, "base64url")) !== sig) throw Error("Invalid wallet signature");
      const address = Signer.recoverAddress(Buffer.from(tx.id.slice(6), "hex"), Buffer.from(sig, "base64url"));
      if (!allowed.has(address) || signers.has(address)) throw Error("Unexpected or duplicate wallet signature");
      signers.add(address);
    }
    if (!signers.has(owner) || (complete && signers.size !== allowed.size)) throw Error("Original wallet owner and payer signatures required");
  }
  async observeRemote(id, txId) {
    objectId(txId); const r = this.#row(id);
    if (!r.remote) throw Error("Remote wallet reservation required");
    if (r.transaction && r.transaction.id !== txId) throw Error("Cannot replace remote wallet transaction");
    const p = this.#client.provider;
    if (await p.getChainId() !== this.#client.d.chainId) throw Error("Wallet nonce chain changed");
    const records = response(await p.getTransactionsById([txId])).transactions ?? [];
    if (!Array.isArray(records)) throw Error("Invalid wallet transaction lookup");
    const matching = records.filter(v => v.transaction?.id === txId);
    if (matching.length > 1) throw Error("Ambiguous wallet transaction lookup");
    if (matching.length) await this.stage(id, matching[0].transaction);
    return this.reconcile(id);
  }
  // Read-only reconciliation. Only this observer can release a reservation;
  // elapsed time, acknowledgments, user Stop and a later tip nonce cannot.
  async reconcile(id) {
    return this.#client.withVerificationScope(() => this.#reconcile(id));
  }
  async #reconcile(id) {
    const r = this.#row(id); if (terminal(r.state) || !r.transaction) return this.status(id);
    for (const tx of [r.transaction, r.correction?.transaction, r.cancellation?.transaction].filter(Boolean)) this.#confirmations.delete(tx.id);
    const original = await this.#inspectFinality(r.transaction);
    const corrected = !original && r.correction?.transaction ? await this.#inspectFinality(r.correction.transaction) : null;
    const cancelled = !original && !corrected && r.cancellation?.transaction ? await this.#inspectFinality(r.cancellation.transaction) : null;
    const proof = original || corrected || cancelled;
    if (!proof) return this.status(id);
    return this.#tx(() => {
      this.#fresh(proof); const current = this.#row(id);
      if (!terminal(current.state)) {
        current.state = corrected || cancelled ? "consumed_elsewhere" : proof.state; current.finality = proof.finality;
        if (current.correction) {
          current.correction.state = corrected ? proof.state : "superseded";
          current.correction.finality = proof.finality; current.correction.updatedAt = this.#now();
        }
        if (current.cancellation) {
          current.cancellation.state = cancelled ? proof.state : "superseded";
          current.cancellation.finality = proof.finality; current.cancellation.updatedAt = this.#now();
        }
        this.#save(current);
      }
      return this.status(id);
    });
  }
  #fresh(proof) { if (this.#now() < proof.checkedAt || this.#now() - proof.checkedAt > 5000) throw Error("Stale wallet finality evidence"); }
  async #inspectFinality(tx) {
    const p = this.#client.provider;
    this.#confirmations.delete(tx.id);
    const [chainId, found] = await Promise.all([p.getChainId(), p.getTransactionsById([tx.id])]);
    if (chainId !== this.#client.d.chainId) throw Error("Wallet nonce chain changed");
    const lookup = response(found).transactions ?? [];
    if (!Array.isArray(lookup)) throw Error("Invalid wallet transaction lookup");
    const records = lookup.filter(v => v.transaction?.id === tx.id);
    if (!records.length) { this.#confirmation({ state: "waiting", txId: tx.id, checkedAt: this.#now() }); return null; }
    if (records.length !== 1) throw Error("Ambiguous wallet transaction lookup");
    const verify = async v => { await this.#verify(v); this.#signatures(v, true); if (v.id !== tx.id) throw Error("Wallet finality transaction changed"); };
    await verify(records[0].transaction);
    const containing = records[0].containing_blocks ?? [];
    if (!Array.isArray(containing) || containing.length > 100) throw Error("Invalid wallet containing blocks");
    containing.forEach(objectId);
    if (!containing.length) { this.#confirmation({ state: "waiting", txId: tx.id, checkedAt: this.#now() }); return null; }
    const [observedHead, observedBlocks] = await Promise.all([p.getHeadInfo(), p.getBlocksById(containing, { returnBlock: false, returnReceipt: false })]);
    const head = response(observedHead), height = uint(head.head_topology?.height), lib = uint(head.last_irreversible_block), time = uint(head.head_block_time);
    const headId = objectId(head.head_topology.id), now = this.#now();
    if (!height || height > BigInt(Number.MAX_SAFE_INTEGER) || lib > height || time > BigInt(now) + 60000n || time + 120000n < BigInt(now)) throw Error("Stale wallet nonce head");
    const blocks = response(observedBlocks).block_items ?? [];
    if (!Array.isArray(blocks)) throw Error("Invalid wallet blocks");
    for (const b of blocks) {
      if (!containing.includes(b.block_id)) throw Error("Unexpected wallet block");
      const h = uint(b.block_height); if (!h || h > height) continue;
      const [main] = await p.getBlocks(Number(h), 1, headId, { returnBlock: true, returnReceipt: true });
      if (!main || main.block_id !== b.block_id) continue;
      if (main.block?.id !== b.block_id || uint(main.block_height) !== h || uint(main.block.header?.height) !== h ||
          main.receipt?.id !== b.block_id || uint(main.receipt.height) !== h) throw Error("Inconsistent irreversible wallet block");
      const included = main.block.transactions?.filter(v => v.id === tx.id), receipts = main.receipt.transaction_receipts?.filter(v => v.id === tx.id);
      if (included?.length !== 1 || receipts?.length !== 1) throw Error("Missing irreversible wallet receipt");
      await verify(included[0]); const receipt = receipts[0];
      if (receipt.rpc_error || receipt.payer !== tx.header.payer || ![undefined, false, true].includes(receipt.reverted) || uint(receipt.rc_used ?? "0") > uint(tx.header.rc_limit)) throw Error("Invalid wallet receipt");
      if (await p.getChainId() !== this.#client.d.chainId) throw Error("Wallet chain changed during finality");
      const checkedAt = this.#now();
      if (checkedAt < now) throw Error("Wallet clock moved backwards during finality");
      this.#confirmation({ state: h > lib ? "included" : receipt.reverted ? "reverted" : "finalized", txId: tx.id,
        blockHeight: h.toString(), irreversibleHeight: lib.toString(), checkedAt, ...(receipt.reverted ? { reverted: true } : {}) });
      if (h > lib) return null;
      const blockTime = main.block.header.timestamp;
      const cost = typeof receipt.rc_used === "string" && /^(0|[1-9]\d*)$/.test(receipt.rc_used) &&
        typeof blockTime === "string" && /^(0|[1-9]\d*)$/.test(blockTime) &&
        uint(blockTime) <= time && uint(blockTime) <= BigInt(checkedAt)
        ? { actualRc: receipt.rc_used, resourceDay: String(uint(blockTime) / 86400000n) } : {};
      return { state: receipt.reverted ? "reverted" : "finalized", checkedAt,
        finality: { txId: tx.id, blockId: b.block_id, height: h.toString(), irreversibleHeight: lib.toString(), ...cost } };
    }
    return null;
  }
  async recoverOriginal(id, txId) {
    objectId(txId); const r = this.#row(id);
    if (r.remote) return this.observeRemote(id, txId);
    const correction = txId === r.correction?.draft.id, cancellation = txId === r.cancellation?.draft.id;
    if (!correction && !cancellation && txId !== r.draft.id) throw Error("Original transaction ID or saved Mana correction ID required");
    const records = response(await this.#client.provider.getTransactionsById([txId])).transactions ?? [];
    if (!Array.isArray(records)) throw Error("Invalid wallet transaction lookup");
    const found = records.filter(x => x.transaction?.id === txId);
    if (found.length !== 1) throw Error("Original transaction is not uniquely available");
    if (cancellation) await this.stageCancellation(id, found[0].transaction);
    else if (correction) await this.stageCorrection(id, found[0].transaction);
    else await this.stage(id, found[0].transaction);
    return this.reconcile(id);
  }
  async reviewConsumed(id, txId) {
    const r = this.#row(id); objectId(txId);
    if (terminal(r.state)) throw Error("Wallet reservation already resolved");
    const records = response(await this.#client.provider.getTransactionsById([txId])).transactions ?? [];
    if (!Array.isArray(records)) throw Error("Invalid repair lookup");
    const found = records.filter(x => x.transaction?.id === txId);
    if (found.length !== 1) throw Error("Consuming transaction is not uniquely available");
    const tx = found[0].transaction; await this.#verify(tx); this.#signatures(tx, true);
    if (ownerOf(tx) !== r.owner || tx.header.nonce !== r.draft.header.nonce || this.#matches(r, tx)) throw Error("Repair needs a different transaction consuming this exact owner nonce");
    const proof = await this.#inspectFinality(tx); if (!proof) throw Error("Repair requires irreversible nonce consumption");
    this.#fresh(proof);
    return { id, owner: r.owner, nonce: r.draft.header.nonce, originalTxId: r.transaction?.id || (r.remote ? null : r.draft.id),
      consumingTxId: txId, consumingState: proof.state, draftHash: r.draftHash, checkedAt: proof.checkedAt, finality: proof.finality };
  }
  async repairConsumed(review) {
    if (!review || this.#now() < review.checkedAt || this.#now() - review.checkedAt >= 180000) throw Error("Fresh recovery review required");
    const current = await this.reviewConsumed(review.id, review.consumingTxId);
    for (const key of ["owner", "nonce", "originalTxId", "draftHash"]) if (current[key] !== review[key]) throw Error("Recovery review changed");
    if (current.finality.blockId !== review.finality?.blockId) throw Error("Recovery finality changed");
    const repairRow = this.#row(review.id);
    if (repairRow.correction?.draft.id === current.consumingTxId && !repairRow.correction.transaction)
      throw Error("Recover the saved Mana correction envelope before recording its finality");
    if (repairRow.cancellation?.draft.id === current.consumingTxId && !repairRow.cancellation.transaction)
      throw Error("Recover the saved cancellation envelope before recording its finality");
    return this.#tx(() => {
      this.#fresh(current); const r = this.#row(review.id);
      if (!terminal(r.state)) {
        r.state = "consumed_elsewhere"; r.finality = current.finality;
        if (r.correction) {
          r.correction.state = current.consumingTxId === r.correction.draft.id ? current.consumingState : "superseded";
          r.correction.finality = current.finality; r.correction.updatedAt = this.#now();
        }
        if (r.cancellation) {
          r.cancellation.state = current.consumingTxId === r.cancellation.draft.id ? current.consumingState : "superseded";
          r.cancellation.finality = current.finality; r.cancellation.updatedAt = this.#now();
        }
        this.#save(r);
      }
      return this.status(review.id);
    });
  }
  close() { this.#db.close(); this.#guard.close(); }
}
module.exports = { WalletNonceCoordinator, nonce };
