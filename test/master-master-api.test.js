"use strict";
const test=require("node:test"),assert=require("node:assert/strict"),fs=require("node:fs"),os=require("node:os"),path=require("node:path"),http=require("node:http");
const {JsonStore}=require("../plugin/service/core/lib/store"),{Signer}=require("koilib");
const {ProducerIndex,MasterNodeApi,validateConfig,rpc}=require("../plugin/service/core/lib/koinos/master-api");
const ADDRESS=new Signer({privateKey:"1".padStart(64,"0")}).address;
test("API listener recovers after a temporary port conflict and honors explicit disable", async t => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),"master-listener-"));
  const occupied=http.createServer(); await new Promise(r=>occupied.listen(0,"127.0.0.1",r));
  const port=occupied.address().port;
  const settings=new JsonStore(path.join(root,"settings.json"),{network:"mainnet",masterApi:{enabled:true,port}});
  const api=new MasterNodeApi({root,settings,fetchImpl:async()=>{throw Error("fixture offline");}});
  t.after(async()=>{await api.stop();occupied.close();fs.rmSync(root,{recursive:true,force:true});});
  await assert.rejects(api.start(),/could not listen/); assert.equal(api.status().listening,false);
  await new Promise(r=>occupied.close(r)); await api.maintain(); assert.equal(api.status().listening,true);
  await api.configure({enabled:false}); await api.maintain(); assert.equal(api.status().listening,false);
});
function fixture(t,n=3){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),"master-index-"));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const f={root,n,now:Date.now(),chainId:"fixture",fork:"",calls:[]};
  f.call=async(method,p)=>{f.calls.push({method,p});if(method==="chain.get_chain_id")return{chain_id:f.chainId};if(method==="chain.get_head_info")return{head_topology:{height:String(f.n),id:"head"},last_irreversible_block:String(f.n)};
    return{block_items:Array.from({length:p.num_blocks},(_,i)=>{const h=Number(p.ancestor_start_height)+i;return{block_height:String(h),block_id:`b${h}${f.fork}`,block:{header:{previous:`b${h-1}${f.fork}`,signer:ADDRESS,timestamp:String(f.now-(f.n-h)*3000)}}};})};};
  f.index=new ProducerIndex({store:new JsonStore(path.join(root,"index.json")),call:f.call,now:()=>f.now});return f;
}
test("finalized window resumes with canonical validation, not unverified cached success",async t=>{
  const f=fixture(t),s=await f.index.refresh();assert.equal(s.available,true);assert.equal(s.producers[0].blocks_24h,3);
  const reopened=new ProducerIndex({store:new JsonStore(path.join(f.root,"index.json")),call:f.call,now:()=>f.now});assert.equal(reopened.snapshot().available,false);assert.equal((await reopened.refresh()).available,true);
  f.fork="new";assert.equal((await f.index.refresh()).total_blocks,3);assert.equal(f.index.blocks[0].id,"b1new");
  f.chainId="foreign";assert.equal((await f.index.refresh()).available,false);assert.match(f.index.error,/chain ID changed/);
});
test("bounded backfill, stale data and missing history cannot report ready",async t=>{
  const f=fixture(t,501);assert.equal((await f.index.refresh()).available,false);assert.equal(f.index.blocks.length,500);assert.equal((await f.index.refresh()).available,true);
  assert.ok(f.calls.filter(c=>c.p).every(c=>c.p.num_blocks<=100));f.now+=100000;assert.equal(f.index.snapshot().available,false);
  const call=f.call;f.index.call=async(m,p)=>m.startsWith("block_store")?{block_items:[]}:call(m,p);assert.equal((await f.index.refresh()).available,false);assert.match(f.index.error,/incomplete history/);
});
test("API serves cached public data and refuses writes, arbitrary routes and nonlocal upstreams",async t=>{
  for(const rpcUrl of ["https://example.com","http://localhost:8085","http://127.0.0.1/path","http://user:pass@127.0.0.1"])assert.throws(()=>validateConfig({rpcUrl}));
  assert.throws(()=>validateConfig({port:41101}));await assert.rejects(rpc("http://127.0.0.1","chain.submit_transaction"),/allowlisted/);
  const f=fixture(t),probe=http.createServer();await new Promise(r=>probe.listen(0,"127.0.0.1",r));const port=probe.address().port;await new Promise(r=>probe.close(r));
  const settings=new JsonStore(path.join(f.root,"settings.json"),{network:"mainnet",masterApi:{enabled:true,port}});
  const api=new MasterNodeApi({root:f.root,settings,fetchImpl:async(_,o)=>{const req=JSON.parse(o.body);return new Response(JSON.stringify({result:await f.call(req.method,req.params)}));}});
  t.after(()=>api.stop());await api.start();for(let i=0;i<50&&!api.payload;i++)await new Promise(r=>setTimeout(r,10));
  const url=`http://127.0.0.1:${port}`;assert.equal((await fetch(url+"/healthz")).status,200);assert.equal((await(await fetch(url+"/v1/token-tracker/producers")).json()).total_blocks,3);
  assert.equal((await fetch(url+"/core/koinos/rpc")).status,404);assert.equal((await fetch(url+"/v1/status",{method:"POST"})).status,405);
  settings.set("network","harbinger");assert.equal((await fetch(url+"/healthz")).status,503);await api.stop();assert.equal(api.status().listening,false);
});

test("producer dashboard uses only fresh local observations, including after an outage", async t => {
  const f=fixture(t),settings=new JsonStore(path.join(f.root,"settings.json"),{network:"mainnet"});
  const api=new MasterNodeApi({root:f.root,settings});
  api.active=true;api.payload=await f.index.refresh();
  assert.equal(api.producerSummary().activeApprox24h,1);
  assert.equal(api.producerSummary().trackedScope,"producers-in-finalized-window");
  api.payload.updated_at=Date.now()-100000;
  assert.equal(api.producerSummary().available,false);
  api.payload=await f.index.refresh();settings.set("network","harbinger");
  assert.equal(api.producerSummary().available,false);
});

test("rewinds rebuild the canonical index; broken parent links cannot report success", async t => {
  const f=fixture(t,4);await f.index.refresh();f.n=2;
  assert.equal((await f.index.refresh()).total_blocks,2);
  const call=f.call;f.index.call=async(m,p)=>{const r=await call(m,p);if(r.block_items?.length>1)r.block_items[1].block.header.previous="wrong";return r;};
  f.fork="replacement";assert.equal((await f.index.refresh()).available,false);
  assert.match(f.index.error,/inconsistent/);
});

test("disposing during API listen startup cannot resurrect the listener or hang teardown", async t => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),"master-listen-close-"));
  const probe=http.createServer();await new Promise(r=>probe.listen(0,"127.0.0.1",r));const port=probe.address().port;await new Promise(r=>probe.close(r));
  const settings=new JsonStore(path.join(root,"settings.json"),{network:"mainnet",masterApi:{enabled:true,port}});
  const api=new MasterNodeApi({root,settings,fetchImpl:async()=>{throw Error("fixture offline");}});
  t.after(async()=>{await api.dispose();fs.rmSync(root,{recursive:true,force:true});});
  const starting=api.start(), closing=api.dispose();
  let timer;try{await Promise.race([Promise.allSettled([starting,closing]),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error("API shutdown hung")),1000);})]);}finally{clearTimeout(timer);}
  assert.equal(api.server,null);assert.equal(api.active,false);await assert.rejects(api.start(),/closing/);
});
