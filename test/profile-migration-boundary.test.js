"use strict";
const { test } = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const { create } = require("../plugin/service/electron/plugin-services/koinos-node-full");
function fixture(t, { approved = true } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "kai-chain-review-"))), calls = [], reviews = [];
  const preview = { available: true, previewId: "reviewed-id", network: "mainnet", source: { root: "/old-node", basedir: "/old-node/basedir" }, destination: { root: "/plugin-node", basedir: "/plugin-node/basedir" }, detail: "Close the old application including its tray.", walletNotice: "Wallets, private keys, KOIN and VHP are not moved." };
  let state = { phase: "idle", resumable: false }, cancelled = 0, drained = 0;
  const migration = { status: () => state, preview: () => preview, review(network, id) { assert.equal(network,"mainnet"); if(id!==preview.previewId)throw Error("Review again");return preview; }, cancel() { cancelled++;return state; }, async dispose() { drained++; } };
  const manager = { profileMigration: () => migration, _profileMigration: migration, _profileMigrationActive: false, dirs: () => ({ root }), cancelQuickSync() {}, cancelMove() {}, _stopWatchdog() {} };
  const service = create({ dataDir: root, version: "0.3.1", wallet: { status: () => ({ address: "public-test-address", exists: true }) }, settings: { get() {} }, getWindow: () => null, electron: {}, withWalletSpend: run => run(), confirm: async (title, detail) => { reviews.push({ title, detail }); return approved; } }, { createEngine: () => ({ settings: { get: () => "mainnet" }, nodeMgr: manager, call: async (channel, payload) => { calls.push({ channel, payload }); if (channel === "node:profileMigrationPreview")return preview; if(channel === "node:profileMigrationCancel")return migration.cancel();if(channel === "node:profileMigrationStart"){state={phase:"running",resumable:false,preview};manager._profileMigrationActive=true;return state;} return {}; }, stop() {} }) });
  t.after(async()=>{await service.dispose();fs.rmSync(root,{recursive:true,force:true});});
  return { service, calls, reviews, manager, get cancelled(){return cancelled;}, get drained(){return drained;}, pause(){state={phase:"cancelled",resumable:true,preview};manager._profileMigrationActive=false;} };
}
test("migration native review uses private source/destination and cancellation never starts transfer",async t=>{
 const f=fixture(t,{approved:false});await f.service.call("node.read",{channel:"node:profileMigrationPreview"});const result=await f.service.call("node.manage",{channel:"node:profileMigrationStart",payload:{previewId:"reviewed-id"}});assert.equal(result.cancelled,true);assert.equal(result.phase,"idle");assert.equal(f.calls.length,1);assert.match(f.reviews[0].detail,/From: \/old-node\/basedir/);assert.match(f.reviews[0].detail,/To: \/plugin-node\/basedir/);assert.match(f.reviews[0].detail,/KOIN and VHP/);
});
test("renderer cannot inject migration paths or start without the reviewed ID",async t=>{
 const f=fixture(t);await assert.rejects(f.service.call("node.manage",{channel:"node:profileMigrationStart",payload:{previewId:"reviewed-id",source:"/other"}}),/Invalid Node migration/);await assert.rejects(f.service.call("node.manage",{channel:"node:profileMigrationStart",payload:{previewId:"forged"}}),/Review again/);assert.deepEqual(f.calls,[]);assert.deepEqual(f.reviews,[]);
});
test("active and paused migration block conflicting settings while pause needs no second review",async t=>{
 const f=fixture(t);await f.service.call("node.manage",{channel:"node:profileMigrationStart",payload:{previewId:"reviewed-id"}});assert.equal(f.reviews.length,1);await assert.rejects(f.service.call("node.manage",{channel:"settings:update",payload:{network:"harbinger"}}),/migration/);await f.service.call("node.manage",{channel:"node:profileMigrationCancel"});assert.equal(f.cancelled,1);assert.equal(f.reviews.length,1);f.pause();await assert.rejects(f.service.call("node.manage",{channel:"node:setDataDir",payload:{path:"/elsewhere"}}),/migration/);await f.service.dispose();assert.equal(f.drained,1);assert.ok(f.cancelled>=2);
});
