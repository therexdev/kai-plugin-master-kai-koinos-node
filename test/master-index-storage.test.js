"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const { GuardedStore } = require("../plugin/service/electron/plugin-services/guarded-store");

test("settings retain their original size and backup protections", t => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),"master-store-limit-"));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const file=path.join(root,"settings.json"),store=new GuardedStore(file);
  store.set("enabled",true);const original=fs.readFileSync(file);
  assert.throws(()=>store.set("oversized","x".repeat(2*1024*1024)),/size limit/);
  assert.deepEqual(fs.readFileSync(file),original);assert.doesNotThrow(()=>store.assert());
  store.set("enabled",false);
  const backups=fs.readdirSync(root).filter(name=>name.includes(".core-backup-"));
  assert.equal(backups.length,1);assert.deepEqual(fs.readFileSync(path.join(root,backups[0])),original);
});

test("the public cache keeps size and external-change guards without per-refresh backups", t => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),"master-cache-limit-"));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const file=path.join(root,"cache.json"),store=new GuardedStore(file,{maxBytes:4096,backup:false});
  store.set("index",{height:1});store.set("index",{height:2});const original=fs.readFileSync(file);
  assert.throws(()=>store.set("index","x".repeat(4096)),/size limit/);
  assert.deepEqual(fs.readFileSync(file),original);
  fs.writeFileSync(file,JSON.stringify({index:{height:3}}));
  assert.throws(()=>store.set("index",{height:4}),/changed outside Core/);
  assert.deepEqual(JSON.parse(fs.readFileSync(file)),{index:{height:3}});
  assert.deepEqual(fs.readdirSync(root),["cache.json"]);
});
