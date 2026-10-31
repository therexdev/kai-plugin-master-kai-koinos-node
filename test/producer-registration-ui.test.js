"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path"), vm = require("node:vm");
const renderer = fs.readFileSync(path.join(__dirname, "../plugin/renderer.js"), "utf8");
const between = (start, end) => {
  const from = renderer.indexOf(start), to = renderer.indexOf(end, from);
  assert.ok(from >= 0 && to > from);
  return renderer.slice(from, to);
};
function fixture() {
  const nodes = new Map(["#n-register", "#n-reg-hint", "#uw-pass"].map(id => [id, { textContent: "", disabled: false, focus() { this.focused = true; } }]));
  const calls = [], notices = [], views = [], transactions = [];
  const S = { walletStage: "locked", registeringKey: false, node: { isRunning: true },
    producer: { mode: "local", address: "synthetic-address", filePublicKey: "current-key", registeredPublicKey: "old-key", matches: false } };
  const context = vm.createContext({ S, $: selector => nodes.get(selector),
    KaiI18n: { setText: (node, text) => { node.textContent = text; } },
    switchView: view => views.push(view), renderWalletView() {}, renderBurnView() {},
    refreshNode: async () => {}, txToast: (...args) => transactions.push(args), toast: (...args) => notices.push(args),
    call: async (...args) => { calls.push(args); return { exists: true, unlocked: false }; },
  });
  vm.runInContext(between("async function refreshWallet()", "async function refreshBalances(") + between("function registrationState()", "async function loadLogs()"), context);
  return { context, S, calls, notices, views, transactions, button: nodes.get("#n-register"), hint: nodes.get("#n-reg-hint"), password: nodes.get("#uw-pass") };
}

test("an imported locked wallet with a different registered key offers an actionable unlock route", async () => {
  const f = fixture(); f.context.patchRegistration();
  assert.equal(f.button.disabled, false); assert.equal(f.button.textContent, "Unlock wallet to register");
  assert.match(f.hint.textContent, /different key.*Unlock this plugin's wallet/);
  await f.context.onRegisterKey();
  assert.deepEqual(f.views, ["wallet"]); assert.equal(f.password.focused, true);
  assert.deepEqual(f.calls.map(call => call[0]), ["wallet:status"]);
  assert.equal(f.transactions.length, 0);
});

test("wallet refresh updates the registration action immediately after unlock or relock", async () => {
  const f = fixture();
  f.context.call = async () => ({ exists: true, unlocked: true });
  await f.context.refreshWallet();
  assert.equal(f.button.disabled, false); assert.equal(f.button.textContent, "Register signing key");
  assert.match(f.hint.textContent, /Register the current node key to replace it/);
  f.context.call = async () => ({ exists: true, unlocked: false });
  await f.context.refreshWallet(); assert.equal(f.button.textContent, "Unlock wallet to register");
});

test("a pending registration stays disabled through refreshes and repeated clicks", async () => {
  const f = fixture(); f.S.walletStage = "unlocked";
  let resolve; const pending = new Promise(yes => { resolve = yes; });
  f.context.call = async (...args) => { f.calls.push(args); return pending; };
  f.context.refreshNode = async () => { f.S.producer.matches = true; f.context.patchRegistration(); };
  const first = f.context.onRegisterKey();
  f.context.patchRegistration(); await f.context.onRegisterKey();
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0][0], "producer:register");
  assert.equal(f.button.disabled, true); assert.equal(f.button.textContent, "Registering…");
  resolve({ transactionId: "synthetic-transaction" }); await first;
  assert.equal(f.transactions.length, 1); assert.equal(f.S.registeringKey, false);
  assert.equal(f.button.disabled, true); assert.equal(f.button.textContent, "Signing key registered");
});

test("cancelled or failed registration restores the action without reporting success", async () => {
  for (const message of ["Action cancelled", "Insufficient mana"]) {
    const f = fixture(); f.S.walletStage = "unlocked";
    f.context.call = async () => { throw Error(message); };
    await f.context.onRegisterKey();
    assert.equal(f.S.registeringKey, false); assert.equal(f.button.disabled, false);
    assert.equal(f.button.textContent, "Register signing key");
    assert.deepEqual(f.notices, [[message, "bad"]]); assert.equal(f.transactions.length, 0);
  }
});

test("external, unknown custody, missing keys, node operations and already registered keys never send local registration", async () => {
  for (const update of [
    f => { f.S.producer.mode = "external"; },
    f => { f.S.producer.mode = "unresolved"; },
    f => { delete f.S.producer.mode; },
    f => { f.S.producer.filePublicKey = null; },
    f => { f.S.node.op = { running: true }; },
    f => { f.S.producer.matches = true; },
  ]) {
    const f = fixture(); f.S.walletStage = "unlocked"; update(f);
    f.context.patchRegistration(); assert.equal(f.button.disabled, true);
    await f.context.onRegisterKey(); assert.equal(f.calls.length, 0);
  }
});

test("unknown on-chain status offers a read-only retry and missing wallet offers setup", async () => {
  for (const producer of [null, { mode: "local", address: "synthetic-address", filePublicKey: "current-key", verificationError: "RPC unavailable" }]) {
    const f = fixture(); f.S.walletStage = "unlocked"; f.S.producer = producer;
    let refreshed = 0; f.context.refreshNode = async () => { refreshed++; };
    f.context.patchRegistration(); assert.equal(f.button.textContent, "Check registration");
    await f.context.onRegisterKey(); assert.equal(refreshed, 1); assert.equal(f.calls.length, 0);
  }
  const f = fixture(); f.S.walletStage = "none"; f.context.patchRegistration();
  assert.equal(f.button.textContent, "Set up Node wallet"); await f.context.onRegisterKey();
  assert.deepEqual(f.views, ["wallet"]); assert.equal(f.transactions.length, 0);
});

test("wallet refresh failure is visible without registering or losing the unlock action", async () => {
  const f = fixture(); f.context.call = async () => { throw Error("Wallet status unavailable"); };
  await f.context.onRegisterKey();
  assert.deepEqual(f.notices, [["Wallet status unavailable", "bad"]]);
  assert.equal(f.transactions.length, 0); assert.equal(f.context.registrationState().action, "wallet");
});
