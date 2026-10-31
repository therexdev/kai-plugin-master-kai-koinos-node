"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path"), vm = require("node:vm");
const { createController, bytes } = require("../plugin/node-migration");
const review = changes => ({ available: true, previewId: "native-review-id", network: "mainnet", source: { root: "/alpha/node/mainnet", basedir: "/alpha/node/mainnet/basedir" }, destination: { root: "/plugin/node/mainnet", basedir: "/plugin/node/mainnet/basedir" }, bytes: 1024, files: 2, mode: "move", resumable: false, ...changes });
function fixture(options = {}) {
  const calls = [], renders = [], done = [], timers = new Map(); let next = 0, job = options.job || { phase: "idle" }, preview = options.preview || review();
  const controller = createController({ call: async (channel, input) => { calls.push([channel, input]); if (options.call) return options.call(channel, input); if (channel === "node:profileMigrationStatus") return structuredClone(job); if (channel === "node:profileMigrationPreview") return structuredClone(preview); if (channel === "node:profileMigrationStart") { job = { phase: "running", preview, progress: { completedBytes: 0, totalBytes: 1024 } }; return structuredClone(job); } if (channel === "node:profileMigrationCancel") { job = { phase: "cancelled", resumable: true, preview, result: { summary: "Completed files stay transferred." } }; return structuredClone(job); } throw Error(channel); }, render: (state, view) => renders.push({ state, view }), onComplete: result => done.push(result), setTimer: fn => { timers.set(++next, fn); return next; }, clearTimer: id => timers.delete(id) });
  return { controller, calls, renders, done, timers, setJob(value) { job = value; }, setPreview(value) { preview = value; } };
}
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };

test("migration review requires the old-app acknowledgement and sends only native preview identity", async () => {
  const f = fixture(); await f.controller.open(); assert.equal(f.controller.view().canStart, false);
  await f.controller.start(); assert.equal(f.calls.filter(([c]) => c.endsWith("Start")).length, 0);
  f.controller.acknowledge(true); assert.equal(f.controller.view().canStart, true); await f.controller.start();
  assert.deepEqual(f.calls.find(([c]) => c.endsWith("Start")), ["node:profileMigrationStart", { previewId: "native-review-id" }]);
  assert.equal(f.controller.snapshot().job.phase, "running"); assert.equal(f.controller.close(), false); assert.equal(f.controller.snapshot().open, true);
  f.controller.dispose();
});
test("unavailable or unbound previews cannot stop a node", async () => {
  for (const value of [review({ available: false }), review({ previewId: null })]) { const f = fixture({ preview: value }); await f.controller.open(); f.controller.acknowledge(true); await f.controller.start(); assert.equal(f.controller.view().canStart, false); assert.ok(!f.calls.some(([c]) => c.endsWith("Start"))); f.controller.dispose(); }
});
test("pause retains completed work and resume requires a fresh review and acknowledgement", async () => {
  const f = fixture(); await f.controller.open(); f.controller.acknowledge(true); await f.controller.start(); await f.controller.pause();
  assert.equal(f.controller.snapshot().job.phase, "cancelled"); assert.equal(f.controller.snapshot().preview, null); assert.equal(f.controller.snapshot().acknowledged, false); assert.equal(f.controller.view().canStart, false);
  f.setPreview(review({ previewId: "resume-review", resumable: true })); await f.controller.preview(); assert.equal(f.controller.view().resumable, true); assert.equal(f.controller.view().canStart, false);
  f.controller.acknowledge(true); await f.controller.start(); assert.deepEqual(f.calls.at(-1), ["node:profileMigrationStart", { previewId: "resume-review" }]); f.controller.dispose();
});
test("an active transfer is restored after renderer reload without discovering another source", async () => {
  const f = fixture({ job: { phase: "running", preview: review(), progress: { completedBytes: 600, totalBytes: 1024 } } }); await f.controller.open();
  assert.equal(f.controller.snapshot().job.progress.completedBytes, 600); assert.equal(f.controller.close(), false); assert.ok(!f.calls.some(([c]) => c.endsWith("Preview"))); f.controller.dispose();
});
test("failed resumable transfer persists across close and reopening with a reviewable recovery", async () => {
  const f = fixture({ job: { phase: "failed", resumable: true, error: "Destination unavailable" }, preview: review({ resumable: true }) }); await f.controller.open();
  assert.equal(f.controller.view().hasTransfer, true); assert.equal(f.controller.view().resumable, true); assert.equal(f.controller.snapshot().job.error, "Destination unavailable");
  assert.equal(f.controller.close(), true); await f.controller.open(); assert.equal(f.controller.snapshot().acknowledged, false); f.controller.dispose();
});
test("completed migration refreshes the original screens once and never starts production", async () => {
  const f = fixture({ job: { phase: "complete", result: { summary: "Done", warnings: ["Check funding separately"] } } });
  await f.controller.open(); await f.controller.poll(); assert.equal(f.done.length, 1); assert.equal(f.done[0].summary, "Done"); assert.ok(f.calls.every(([c]) => c === "node:profileMigrationStatus")); assert.equal(f.controller.view().canStart, false); f.controller.dispose();
});
test("native confirmation cancellation leaves the review actionable", async () => {
  const f = fixture({ call: async channel => channel.endsWith("Status") ? { phase: "idle" } : channel.endsWith("Preview") ? review() : { phase: "idle", cancelled: true, preview: review() } });
  await f.controller.open(); f.controller.acknowledge(true); await f.controller.start(); assert.equal(f.controller.snapshot().job.phase, "idle"); assert.match(f.controller.snapshot().error, /not started/); assert.equal(f.controller.view().canStart, true); f.controller.dispose();
});
test("lost start reply checks native state and never enables a second transfer blindly", async () => {
  let active = false;
  const f = fixture({ call: async channel => { if (channel.endsWith("Preview")) return review(); if (channel.endsWith("Start")) { active = true; throw Error("Transport disconnected"); } if (channel.endsWith("Status")) { if (active) throw Error("Status disconnected"); return { phase: "idle" }; } } });
  await f.controller.open(); f.controller.acknowledge(true); await f.controller.start(); assert.equal(f.controller.snapshot().job.phase, "running"); assert.equal(f.controller.snapshot().job.unconfirmed, true); assert.equal(f.controller.close(), false); assert.equal(f.controller.view().canStart, false); f.controller.dispose();
});
test("an older in-flight status response cannot overwrite a started transfer", async () => {
  const pending = deferred(); let reads = 0;
  const f = fixture({ call: async channel => { if (channel.endsWith("Status")) return ++reads === 2 ? pending.promise : { phase: "idle" }; if (channel.endsWith("Preview")) return review(); if (channel.endsWith("Start")) return { phase: "running", preview: review() }; } });
  await f.controller.open(); const poll = f.controller.poll(); f.controller.acknowledge(true); await f.controller.start(); pending.resolve({ phase: "idle" }); await poll;
  assert.equal(f.controller.snapshot().job.phase, "running"); f.controller.dispose();
});
test("closing while discovery is pending cannot reopen a modal or apply a late source", async () => {
  const pending = deferred(); const f = fixture({ call: async () => pending.promise }); const opening = f.controller.open(); assert.equal(f.controller.close(), true);
  pending.resolve({ phase: "idle" }); await opening; assert.equal(f.controller.snapshot().open, false); assert.equal(f.controller.snapshot().preview, null); assert.equal(f.calls.length, 1); f.controller.dispose();
});
test("polling cannot replace a fresh resume review with an older journal preview", async () => {
  const f = fixture({ job: { phase: "cancelled", resumable: true, preview: review({ previewId: "old", resumable: true }) }, preview: review({ previewId: "new", resumable: true }) });
  await f.controller.open(); await f.controller.poll(); assert.equal(f.controller.snapshot().preview.previewId, "new"); f.controller.dispose();
});
test("renderer assets retain all nine Master Node menus, safe text rendering and pause/recovery controls", () => {
  const rootDir = path.join(__dirname, "../plugin"), html = fs.readFileSync(path.join(rootDir, "index.html"), "utf8"), script = fs.readFileSync(path.join(rootDir, "node-migration.js"), "utf8"), bridge = fs.readFileSync(path.join(rootDir, "bridge.js"), "utf8");
  assert.deepEqual([...html.matchAll(/data-view="([^"]+)"/g)].map(m => m[1]), ["dashboard", "wallet", "fund", "burn", "node", "distribution", "master-api", "returns", "settings"]);
  new vm.Script(script); assert.match(html, /<dialog id="node-migration-dialog"/); assert.match(html, /I have closed Master Koinos AI Node, including its tray icon/); assert.match(html, /Master Node chain data/); assert.match(script, /Migrate from Master Koinos AI Node/); assert.match(script, /KOIN and VHP manually/); assert.match(script, /Pause migration/); assert.match(script, /Resume migration/);
  assert.ok(!/innerHTML|fetch\(|window\.open\(/.test(script)); assert.match(bridge, /"node:profileMigrationPreview","node:profileMigrationStatus"/);
  assert.equal(bytes(1024), "1 KB"); assert.equal(bytes(-1), "Unknown size");
});

test("a pause request can keep polling until the native worker finishes safely", async () => {
  let paused = false;
  const f = fixture({ call: async channel => {
    if (channel.endsWith("Preview")) return review();
    if (channel.endsWith("Cancel")) { paused = true; return { phase: "running", preview: review() }; }
    if (channel.endsWith("Start")) return { phase: "running", preview: review() };
    return paused ? { phase: "cancelled", resumable: true, result: { summary: "Paused safely" } } : { phase: "idle" };
  } });
  await f.controller.open(); f.controller.acknowledge(true); await f.controller.start(); await f.controller.pause();
  assert.equal(f.controller.snapshot().pausing, true); assert.equal(f.controller.close(), false);
  await f.controller.poll(); assert.equal(f.controller.snapshot().job.phase, "cancelled"); assert.equal(f.controller.snapshot().pausing, false); assert.equal(f.controller.close(), true); f.controller.dispose();
});

test("background status cannot bypass a new paused review or resubmit a completed transfer", async () => {
  const f = fixture(); await f.controller.open(); f.controller.acknowledge(true); await f.controller.start(); await f.controller.pause();
  await f.controller.poll(); f.controller.acknowledge(true); assert.equal(f.controller.view().canStart, false);
  f.setPreview(review({ resumable: true })); await f.controller.preview(); f.controller.acknowledge(true); await f.controller.start();
  f.setJob({ phase: "complete", preview: review(), result: { summary: "Done" } }); await f.controller.poll();
  assert.equal(f.controller.view().canStart, false); f.controller.dispose();
});

test("a rejected preview settles all pending labels and keeps retry and review available", async () => {
  const { mount } = require("../plugin/node-migration");
  const nodes = new Map();
  function element() { return { textContent: "", hidden: false, disabled: false, checked: false, open: false, dataset: {}, isConnected: true, addEventListener() {}, removeAttribute() {}, focus() {}, showModal() { this.open = true; }, close() { this.open = false; } }; }
  const document = { activeElement: element(), addEventListener() {}, querySelector: () => null,
    getElementById(id) { if (id.startsWith("view-")) return null; if (!nodes.has(id)) nodes.set(id, element()); return nodes.get(id); } };
  const pending = deferred(); let fail = true;
  const controller = mount(document, async channel => {
    if (channel === "node:profileMigrationStatus") return { ok: true, data: { phase: "idle" } };
    if (fail) return pending.promise;
    return { ok: true, data: review() };
  });
  const get = suffix => nodes.get(`node-migration-${suffix}`);
  try {
    const opening = controller.open(); await new Promise(resolve => setImmediate(resolve));
    assert.equal(get("destination").textContent, "Checking the plugin location…");
    assert.equal(get("size").textContent, "Checking chain files…");
    pending.resolve({ ok: false, error: "The stopped containers were not recognized." }); await opening;
    assert.equal(controller.snapshot().loading, false);
    assert.equal(get("destination").textContent, "Plugin location unavailable.");
    assert.equal(get("size").textContent, "Chain size unavailable.");
    assert.equal(get("network").textContent, "Not identified");
    assert.equal(get("source").textContent, "No Master node source was identified.");
    assert.equal(get("error").textContent, "The stopped containers were not recognized.");
    assert.equal(get("recheck").hidden, false); assert.equal(get("close").disabled, false); assert.equal(get("review").hidden, false); assert.equal(get("submit").disabled, true);
    fail = false; await controller.preview();
    assert.equal(get("destination").textContent, "/plugin/node/mainnet/basedir"); assert.equal(get("network").textContent, "mainnet");
    assert.equal(get("error").hidden, true); controller.acknowledge(true); assert.equal(get("submit").disabled, false);
  } finally { controller.dispose(); }
});
