"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), vm = require("node:vm");
const source = fs.readFileSync(require.resolve("../plugin/airdrops.js"), "utf8");
const i18n = require("./i18n-fixture");
function fixture() {
  const nodes = new Map(), calls = [], exports = [];
  const node = selector => { if (!nodes.has(selector)) nodes.set(selector, { value: "", innerHTML: "", textContent: "", disabled: false, listeners: {}, addEventListener(name, fn) { this.listeners[name] = fn; } }); return nodes.get(selector); };
  const context = vm.createContext({ KaiI18n: i18n, $: node, $$: () => [], toast() {}, esc: value => String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;"),
    call: async (channel, payload) => { calls.push({ channel, payload }); return { job: null, history: [], running: false }; },
    window: { kai: { call: async (method, payload) => { exports.push({ method, payload }); return { saved: true }; } } } });
  vm.runInContext(source, context); context.renderAirdropsView();
  return { context, node, calls, exports, setState: value => { context.nextState = value; vm.runInContext("airdropState = nextState; paintAirdrops()", context); } };
}
test("editing a reviewed recipient list invalidates its preview and changes total visibility", () => {
  const f = fixture(); vm.runInContext('airdropPreview = {fingerprint:"old"}', f.context);
  f.node("#ad-mode").value = "amounts"; f.node("#ad-mode").listeners.input();
  assert.equal(vm.runInContext("airdropPreview", f.context), null); assert.equal(f.node("#ad-save").disabled, true); assert.equal(f.node("#ad-total-field").hidden, true);
});
test("unknown payment disables resume and exposes check/export without interpreting user content as markup", () => {
  const f = fixture(); f.setState({ job: { id: "id", network: "mainnet", token: "koin", totalSat: "50000001", wallet: "<sender>", rows: [{ address: '<img src=x>', amountSat: "50000001", status: "unknown", txId: "<tx>", attempts: [{}] }] }, history: [], running: false });
  assert.equal(f.node("#ad-run").disabled, true); assert.equal(f.node("#ad-check").disabled, false); assert.equal(f.node("#ad-discard").disabled, true);
  assert.match(f.node("#ad-payments").innerHTML, /&lt;img/); assert.doesNotMatch(f.node("#ad-payments").innerHTML, /<img/); assert.match(f.node("#ad-payments").innerHTML, /0.50000001/);
});
test("CSV export uses the native save dialog and passes only the saved job ID", async () => {
  const f = fixture(); await f.context.copyAirdropReport("saved-job");
  assert.equal(f.exports.length, 1); assert.equal(f.exports[0].method, "node.exportAirdrop"); assert.equal(f.exports[0].payload.id, "saved-job"); assert.equal(f.calls.length, 0);
});
