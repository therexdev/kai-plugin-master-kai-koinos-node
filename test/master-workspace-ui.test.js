"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path"), vm = require("node:vm");
const read = name => fs.readFileSync(path.join(__dirname, "../plugin", name), "utf8");
const distribution = read("distribution.js"), apiView = read("master-api.js"), bridge = read("bridge.js");
const tick = () => new Promise(setImmediate);
const element = (value = "") => ({ value, checked: false, disabled: false, textContent: "", innerHTML: "", style: {}, listeners: {}, addEventListener(name, fn) { this.listeners[name] = fn; } });

test("Master feature reads and mutations use their scoped native channel groups", async () => {
  const calls = [], context = vm.createContext({ window: { kai: { call: async (...args) => { calls.push(args); return { available: true }; } } } });
  const start = bridge.indexOf("  const READ_CHANNELS"), end = bridge.indexOf("  window.koinosShell", start);
  assert.ok(start >= 0 && end > start);
  vm.runInContext(bridge.slice(start, end), context);
  for (const channel of ["distribution:status", "masterApi:status", "masterApi:checkHistory"]) {
    const result = await context.rpc(channel, {});
    assert.equal(result.ok, true); assert.equal(calls.at(-1)[0], "node.read"); assert.equal(calls.at(-1)[1].channel, channel);
  }
  for (const channel of ["distribution:configure", "distribution:runNow", "distribution:distributeNow", "distribution:resetStats"]) {
    await context.rpc(channel, { enabled: false });
    assert.equal(calls.at(-1)[0], "node.wallet"); assert.equal(calls.at(-1)[1].channel, channel);
  }
  await context.rpc("masterApi:configure", { enabled: true });
  assert.equal(calls.at(-1)[0], "node.manage"); assert.equal(calls.at(-1)[1].payload.enabled, true);
});

function distributionContext() {
  const nodes = new Map(), calls = [], notices = [], busy = [], state = { distribution: { last: { outcome: "watching" } } };
  let modal = null, patched = 0;
  const context = vm.createContext({
    S: state, $: selector => { if (!nodes.has(selector)) nodes.set(selector, element()); return nodes.get(selector); },
    showModal: value => { modal = value; }, busyButton: (button, value) => { button.disabled = value; busy.push(value); },
    toast: (...args) => notices.push(args),
    call: async (...args) => { calls.push(args); return { config: { enabled: false }, last: { outcome: "reset" } }; },
  });
  vm.runInContext(distribution, context);
  context.patchDistributionView = () => { patched++; };
  return { context, nodes, calls, notices, busy, state, modal: () => modal, patched: () => patched };
}

test("Reset Stats requires the styled confirmation and preserves a cancelled distribution", async () => {
  const f = distributionContext();
  f.context.onResetDistributionStats();
  assert.equal(f.calls.length, 0);
  const review = f.modal();
  assert.equal(review.title, "Reset distribution stats?");
  assert.match(review.body, /Wallet balances and completed blockchain transactions are unchanged/);
  assert.match(review.body, /unknown result.*Wallet History/);
  let closed = false;
  review.actions.find(action => action.label === "Cancel").onClick(() => { closed = true; });
  assert.equal(closed, true); assert.equal(f.calls.length, 0); assert.equal(f.state.distribution.last.outcome, "watching");
  f.context.onResetDistributionStats();
  await f.modal().actions.find(action => action.label === "Reset Stats").onClick(() => {});
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0][0], "distribution:resetStats"); assert.equal(f.calls[0][1].confirmed, true);
  assert.equal(f.nodes.get("#di-enabled").checked, false); assert.equal(f.state.distribution.config.enabled, false);
  assert.deepEqual(f.busy, [true, false]); assert.equal(f.patched(), 1);
});

test("failed Reset Stats leaves the prior distribution visible and releases the button", async () => {
  const f = distributionContext(), original = f.state.distribution;
  f.context.call = async () => { throw Error("A payout is still pending"); };
  f.context.onResetDistributionStats();
  await f.modal().actions.find(action => action.label === "Reset Stats").onClick(() => {});
  assert.equal(f.state.distribution, original); assert.equal(f.patched(), 0);
  assert.equal(f.notices.at(-1)[0], "A payout is still pending"); assert.equal(f.notices.at(-1)[1], "bad");
  assert.equal(f.nodes.get("#di-reset").disabled, false);
});

test("Distribute now does not close or send a cycle until its review is accepted", async () => {
  const f = distributionContext();
  f.context.onDistributeNow();
  assert.equal(f.calls.length, 0);
  f.modal().actions.find(action => action.label === "Cancel").onClick(() => {});
  assert.equal(f.calls.length, 0);
  f.context.onDistributeNow();
  await f.modal().actions.find(action => action.label === "Distribute now").onClick(() => {});
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0][0], "distribution:distributeNow");
});

test("an uncertain distribution transaction shows a reconciliation warning without alarming during an active submission", () => {
  const status = element(), S = { distribution: { config: { enabled: false, sharePct: {}, recipients: [] }, derived: { inFlight: { active: false } } } };
  const context = vm.createContext({ S, $: selector => selector === "#di-status" ? status : null, esc: String, sym: () => "KOIN", fmtTime: String, fmtSat: String, shortTx: String });
  vm.runInContext(distribution, context);
  context.patchDistributionView(); assert.match(status.innerHTML, /unknown result.*Automatic payouts are paused/);
  S.distribution.derived.inFlight.active = true;
  context.patchDistributionView(); assert.doesNotMatch(status.innerHTML, /unknown result/);
});

test("Node API settings preserve unsaved inputs on failure and apply only the accepted service configuration", async () => {
  const nodes = new Map(), calls = [], notices = [], previous = { enabled: false, extendedIndexes: false };
  let fail = true;
  const context = vm.createContext({
    S: { appInfo: { settings: { masterApi: previous } } }, esc: String, fmtTime: String,
    $: selector => { if (!nodes.has(selector)) nodes.set(selector, element()); return nodes.get(selector); },
    toast: (...args) => notices.push(args),
    call: async (channel, payload) => {
      if (channel === "masterApi:configure") { calls.push([channel, payload]); if (fail) throw Error("API port is already in use"); return { config: { ...payload } }; }
      return { config: { rpcEnabled: false }, listening: false, rpcUrl: "http://127.0.0.1:41110", producerUrl: "/api/producers", publicRpcUrl: "" };
    },
  });
  vm.runInContext(apiView, context); context.renderMasterApiView(); await tick();
  context.$("#ma-enabled").checked = true; context.$("#ma-indexes").checked = true;
  context.$("#ma-rpc-enabled").checked = true; context.$("#ma-metadata-backups").checked = false;
  context.$("#ma-public").value = " https://node.example.com "; context.$("#ma-rpc").value = "http://127.0.0.1:8085"; context.$("#ma-port").value = "41110";
  await context.$("#ma-save").listeners.click();
  assert.equal(context.S.appInfo.settings.masterApi, previous); assert.equal(notices.at(-1)[0], "API port is already in use");
  assert.equal(context.$("#ma-enabled").checked, true); assert.equal(context.$("#ma-public").value, " https://node.example.com ");
  fail = false; await context.$("#ma-save").listeners.click();
  assert.equal(calls.length, 2); assert.equal(calls[1][1].port, 41110); assert.equal(calls[1][1].publicUrl, "https://node.example.com");
  assert.equal(calls[1][1].metadataFallback, false); assert.equal(context.S.appInfo.settings.masterApi.extendedIndexes, true);
  assert.match(notices.at(-1)[0], /Stop and start the node/);
});
