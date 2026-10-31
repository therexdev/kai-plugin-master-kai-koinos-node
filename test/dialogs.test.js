"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path"), vm = require("node:vm");
const read = file => fs.readFileSync(path.join(__dirname, "../plugin", file), "utf8");
const bridge = read("bridge.js"), renderer = read("renderer.js");
const between = (source, start, end) => { const from = source.indexOf(start); assert.ok(from >= 0, start); const to = source.indexOf(end, from); assert.ok(to > from, end); return source.slice(from, to); };
const deferred = () => { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; };
const tick = () => new Promise(setImmediate);
class Element {
  constructor(tag = "div") { this.tag = tag; this.children = []; this.listeners = new Map(); this.attrs = {}; this.style = {}; this.className = ""; this.textContent = ""; this.value = ""; }
  appendChild(child) { this.children.push(child); child.parent = this; return child; }
  remove() { this.removed = true; if (this.parent) this.parent.children = this.parent.children.filter(child => child !== this); }
  setAttribute(key, value) { this.attrs[key] = value; }
  addEventListener(name, fn) { const rows = this.listeners.get(name) || []; rows.push(fn); this.listeners.set(name, rows); }
  emit(name, event = {}) { for (const fn of this.listeners.get(name) || []) fn(event); }
  focus() {}
  find(predicate) { if (predicate(this)) return this; for (const child of this.children) { const found = child.find(predicate); if (found) return found; } }
  set innerHTML(value) { this.html = value; if (value.includes('class="modal"')) { const modal = this.appendChild(new Element()); modal.className = "modal"; for (const cls of ["node-modal-heading", "actions"]) { const el = modal.appendChild(new Element()); el.className = cls; } } }
}
function dom() { const root = new Element(); return { root, document: { getElementById: id => id === "modal-root" ? root : null, createElement: tag => new Element(tag) } }; }

test("closing the wallet-password popup cancels without sending a financial RPC", async () => {
  const { root, document } = dom(), calls = [];
  const context = vm.createContext({ document, rpc: async (...args) => { calls.push(args); return { ok: true }; }, OUTBOUND: { "chain:send": "Send KOIN" } });
  vm.runInContext(between(bridge, "  function askPassword(", "  const READ_CHANNELS") + between(bridge, "  function invoke(", "  // ---- events:"), context);
  const result = context.invoke("chain:send", { to: "destination", amount: "1" });
  const password = root.find(el => el.tag === "input"); password.value = "synthetic-secret";
  root.find(el => el.className === "node-modal-close").emit("click");
  assert.equal((await result).ok, false); assert.equal(calls.length, 0); assert.equal(password.value, ""); assert.equal(root.children.length, 0);
  const approved = context.invoke("chain:send", { to: "destination", amount: "1" });
  const field = root.find(el => el.tag === "input"); field.value = "synthetic-secret";
  root.find(el => el.textContent === "Confirm").emit("click");
  assert.equal((await approved).ok, true); assert.equal(calls.length, 1); assert.equal(calls[0][1].password, "synthetic-secret"); assert.equal(calls[0][1].to, "destination"); assert.equal(field.value, "");
});

test("folder popup close and Escape settle as cancellation without changing a path", async () => {
  const { root, document } = dom();
  const context = vm.createContext({ document, shell: () => ({}), fmtBytes: String, invoke: () => { throw Error("Cancel cannot change the node"); } });
  vm.runInContext(between(bridge, "  function el(", "  /*\n   * Quick sync"), context);
  const result = context.askFolder({ path: "/node", freeBytes: 1 }, {});
  root.find(el => el.className === "node-modal-close").emit("click");
  assert.equal(await result, null); assert.equal(root.children.length, 0);
  const escape = context.askFolder({ path: "/node", freeBytes: 1 }, {});
  root.find(el => el.className === "modal").emit("keydown", { key: "Escape", preventDefault() {} });
  assert.equal(await escape, null); assert.equal(root.children.length, 0);
});

test("Node form close never approves an action and required backup acknowledgement remains required", () => {
  const { root, document } = dom(); let approved = false;
  const context = vm.createContext({ document, $: (selector, parent = root) => selector === "#modal-root" ? root : parent.find(el => el.className === selector.slice(1)), KaiI18n: { html: (parts, ...args) => typeof parts === "string" ? parts : parts.map((part, i) => part + (args[i] ?? "")).join(""), setText: (node, text) => { node.textContent = text; } }, esc: String });
  vm.runInContext(between(renderer, "function showModal(", "function busyButton("), context);
  context.showModal({ title: "Send KOIN", body: "Review recipient", actions: [{ label: "Send", onClick: () => { approved = true; } }] });
  root.find(el => el.className === "node-modal-close").emit("click");
  assert.equal(approved, false); assert.equal(root.children.length, 0);
  context.showModal({ title: "Save your private key", body: "Backup", actions: [{ label: "I saved my key", required: true, onClick: close => close() }] });
  assert.equal(root.find(el => el.className === "node-modal-close"), undefined);
  root.children[0].emit("keydown", { key: "Escape", preventDefault() {} }); assert.equal(root.children.length, 1);
  root.find(el => el.textContent === "I saved my key").emit("click"); assert.equal(root.children.length, 0);
});

test("failed data-folder change awaits the trusted alert and preserves its error", async () => {
  const pending = deferred(), alerts = [], calls = [];
  const context = vm.createContext({ window: { kai: { dialogs: { alert: (...args) => { alerts.push(args); return pending.promise; } } } }, askFolder: async () => "/new", invoke: async (channel, input) => { calls.push([channel, input]); return channel === "node:dataDir" ? { ok: true, data: { hasData: false, path: "/old" } } : { ok: false, error: "Folder is not writable" }; } });
  vm.runInContext(between(bridge, "  function onChangeDataFolder()", "  /** Run the move"), context);
  let settled = false;
  const result = context.onChangeDataFolder().then(() => { settled = true; });
  await tick(); assert.equal(settled, false); assert.equal(alerts.length, 1); assert.equal(alerts[0][0], "Folder is not writable"); assert.equal(alerts[0][1].title, "Could not change the data folder");
  pending.resolve(); await result; assert.equal(settled, true); assert.equal(calls.length, 2);
});

test("main Node renderer has no synchronous browser alerts or confirmations", () => {
  for (const source of [bridge, renderer]) assert.doesNotMatch(source, /(?<![\w.])(?:window\.)?(?:confirm|alert)\s*\(/);
});
