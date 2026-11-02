"use strict";
const {test}=require("node:test"),assert=require("node:assert/strict"),fs=require("node:fs"),os=require("node:os"),path=require("node:path"),crypto=require("node:crypto");
const profile=require("../plugin/service/core/lib/koinos/profile-import");
const {Signer,utils}=require("../plugin/service/node_modules/koilib");
const {WalletService}=require("../plugin/service/core/lib/wallet");
const {JsonStore}=require("../plugin/service/core/lib/store");
const {DEFAULT_SETTINGS}=require("../plugin/service/core/lib/koinos/constants");
const {encryptKeystore}=require("../plugin/service/core/lib/keystore");
function fixture(t,{mode="external",wallet=false}={}){
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),"kai-profile-import-"))),core=path.join(root,"Master Koinos AI Node","core"),source={root:path.join(core,"koinos-node","node","mainnet")};source.basedir=path.join(source.root,"basedir");
  const dest=path.join(root,"plugin"),keyDir=path.join(dest,"koinos-node","node","mainnet","basedir","block_producer");
  const write=(file,bytes)=>{fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,bytes);};
  const owner=new Signer({privateKey:"1".padStart(64,"0")}),hot=new Signer({privateKey:"2".padStart(64,"0")}),address=owner.getAddress(),publicKey=utils.encodeBase64url(hot.publicKey);
  write(path.join(core,"koinos-node","settings.json"),JSON.stringify({network:"mainnet",producer:{mode,addresses:{mainnet:address}},customRpc:{mainnet:"https://example.com/rpc"},node:{autoRecover:true},rewards:{enabled:true},sessionToken:"DO NOT COPY"}));
  write(path.join(source.root,"config","config.yml"),`block_producer:\n  producer: ${address}\n`);
  write(path.join(source.basedir,"block_producer","private.key"),hot.getPrivateKey("wif")+"\n");write(path.join(source.basedir,"block_producer","public.key"),publicKey+"\n");
  if(wallet||mode==="local"){const ks=encryptKeystore({privateKeyHex:owner.getPrivateKey("hex"),address,password:"old-password"});ks.pwHint="INSECURE-HINT";write(path.join(core,"wallet","wallet.json"),JSON.stringify(ks));}
  const ctx={settings:new JsonStore(path.join(dest,"koinos-node","settings.json"),DEFAULT_SETTINGS),state:new JsonStore(path.join(dest,"koinos-node","state.json"),{}),wallet:new WalletService(path.join(dest,"wallet")),chain:{clearCache(){}}};
  const manager={dirs:()=>({producerKeyDir:keyDir}),autoRecover:true};
  const selection={chain:false,settings:true,signingKey:true,wallet:mode==="local"};
  const scan=()=>profile.inspect({source,network:"mainnet",manager,context:ctx,selection,profiles:[]});
  const preview=()=>{const found=scan();return{options:selection,components:found.components,producer:found.producer,profileReview:found.plan};};
  const record=()=>({id:crypto.randomUUID(),source,network:"mainnet",preview:preview()});
  const apply=(r,save=()=>{})=>profile.apply({record:r,manager,context:ctx,profiles:[],save});
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));return{root,core,source,dest,keyDir,ctx,manager,selection,scan,preview,record,apply,write,address,publicKey,hot};
}
test("external profile copies same hot key and custody while never reading the cold wallet",t=>{
 const f=fixture(t);const wallet=path.join(f.core,"wallet","wallet.json");f.write(wallet,"not even a wallet");const r=f.record();
 assert.equal(r.preview.components.settings.available,true);assert.equal(r.preview.components.signingKey.available,true);assert.equal(r.preview.components.wallet.available,false);profile.validate(r.preview,f.ctx);
 f.apply(r);assert.equal(f.ctx.settings.get("producer.mode"),"external");assert.equal(f.ctx.settings.get("producer.addresses.mainnet"),f.address);assert.equal(f.ctx.settings.get("rewards.enabled"),false);assert.equal(f.ctx.settings.get("node.autoRecover"),false);
 assert.equal(f.ctx.settings.get("sessionToken"),undefined);assert.equal(f.ctx.wallet.exists(),false);assert.equal(fs.readFileSync(path.join(f.keyDir,"private.key"),"utf8"),f.hot.getPrivateKey("wif")+"\n");assert.equal(fs.readFileSync(path.join(f.source.basedir,"block_producer","private.key"),"utf8"),f.hot.getPrivateKey("wif")+"\n");
 assert.ok(!JSON.stringify(r).includes(f.hot.getPrivateKey("wif")));assert.ok(!JSON.stringify(r).includes("DO NOT COPY"));
});
test("local settings require their matching wallet and encrypted import remains locked",t=>{
 const f=fixture(t,{mode:"local"}),r=f.record();assert.equal(r.preview.components.wallet.available,true);
 assert.throws(()=>profile.validate({...r.preview,options:{...f.selection,wallet:false}},f.ctx),/matching|same wallet|encrypted local/);profile.validate(r.preview,f.ctx);f.apply(r);
 assert.equal(f.ctx.wallet.address,f.address);assert.equal(f.ctx.wallet.status().unlocked,false);assert.equal(f.ctx.wallet.readKeystore().pwHint,undefined);f.ctx.wallet.unlock("old-password");assert.equal(f.ctx.wallet.address,f.address);
});
test("an external producer can preserve a separate local Node wallet",t=>{
 const f=fixture(t);f.ctx.wallet.create({password:"different-password"});f.ctx.wallet.lock();const original=f.ctx.wallet.address,r=f.record();assert.equal(r.preview.components.settings.available,true);f.apply(r);assert.equal(f.ctx.wallet.address,original);assert.equal(f.ctx.settings.get("producer.addresses.mainnet"),f.address);
});
test("existing key files and wallet are never overwritten",t=>{
 const f=fixture(t,{mode:"local"});f.write(path.join(f.keyDir,"private.key"),"keep-existing");f.ctx.wallet.create({password:"different-password"});f.ctx.wallet.lock();const original=fs.readFileSync(f.ctx.wallet.keystorePath),r=f.record();
 assert.equal(r.preview.components.signingKey.available,false);assert.equal(r.preview.components.wallet.available,false);assert.throws(()=>profile.validate(r.preview,f.ctx));assert.equal(fs.readFileSync(path.join(f.keyDir,"private.key"),"utf8"),"keep-existing");assert.deepEqual(fs.readFileSync(f.ctx.wallet.keystorePath),original);
});
test("source changes and changed destination settings abort reviewed import",t=>{
 const f=fixture(t),r=f.record();f.write(path.join(f.source.basedir,"block_producer","public.key"),"changed");assert.throws(()=>f.apply(r),/key changed/);assert.equal(fs.existsSync(path.join(f.keyDir,"private.key")),false);
 const g=fixture(t),s=g.record();s.profilePrepared=true;s.profileTargetHash=s.preview.profileReview.targetSettings;g.ctx.settings.set("producer",{mode:"external",addresses:{mainnet:new Signer({privateKey:"3".padStart(64,"0")}).getAddress()}});assert.throws(()=>g.apply(s),/Destination Node settings changed/);
});
test("key pair mismatch and conflicting running producer are unavailable",t=>{
 const f=fixture(t);f.write(path.join(f.source.basedir,"block_producer","public.key"),utils.encodeBase64url(new Signer({privateKey:"3".padStart(64,"0")}).publicKey));assert.equal(f.scan().components.signingKey.available,false);
 f.write(path.join(f.source.root,"config","config.yml"),"block_producer:\n  producer: "+new Signer({privateKey:"3".padStart(64,"0")}).getAddress()+"\n");assert.equal(f.scan().components.settings.available,false);
});
test("interrupted no-replace wallet publication is recoverable without overwrite",t=>{
 const f=fixture(t,{mode:"local"}),r=f.record(),unlink=fs.unlinkSync;let interrupted=false;
 fs.unlinkSync=function(file,...args){if(!interrupted&&String(file).includes("wallet.json.kai-migration-")&&fs.existsSync(f.ctx.wallet.keystorePath)){interrupted=true;throw Error("simulated crash");}return unlink.call(this,file,...args);};
 try{assert.throws(()=>f.apply(r),/simulated crash/);}finally{fs.unlinkSync=unlink;}
 assert.equal(fs.lstatSync(f.ctx.wallet.keystorePath).nlink,2);profile.recoverPublished(f.ctx.wallet.keystorePath);assert.equal(fs.lstatSync(f.ctx.wallet.keystorePath).nlink,1);f.apply(r);assert.equal(f.ctx.wallet.address,f.address);assert.equal(r.profileSettingsComplete,true);
});
test("resumes a settings write after the journaled publication without changing identity",t=>{
 const f=fixture(t),r=f.record(),original=f.ctx.settings.set.bind(f.ctx.settings);let interrupted=false;
 f.ctx.settings.set=(key,value)=>{original(key,value);if(key==="producer"&&!interrupted){interrupted=true;throw Error("simulated settings crash");}};
 assert.throws(()=>f.apply(r),/simulated settings crash/);f.ctx.settings.set=original;f.apply(r);assert.equal(r.profileSettingsComplete,true);assert.equal(f.ctx.settings.get("producer.addresses.mainnet"),f.address);
});
test("invalid RPC blocks profile import before publishing any key",t=>{const f=fixture(t),file=path.join(f.core,"koinos-node","settings.json"),cfg=JSON.parse(fs.readFileSync(file));cfg.customRpc.mainnet="file:///etc/passwd";f.write(file,JSON.stringify(cfg));const r=f.record();assert.equal(r.preview.components.settings.available,false);assert.throws(()=>profile.validate(r.preview,f.ctx),/RPC/);assert.equal(fs.existsSync(path.join(f.keyDir,"private.key")),false);});
test("option payloads cannot import a signing key without its producer settings",()=>{assert.throws(()=>profile.options({chain:false,settings:false,signingKey:true,wallet:false}));assert.throws(()=>profile.options({chain:true,settings:false,signingKey:false,wallet:false,path:"/tmp"}));});

test("corrupted WIF checksum is refused even when the private scalar is unchanged",t=>{const f=fixture(t),file=path.join(f.source.basedir,"block_producer","private.key"),wif=f.hot.getPrivateKey("wif");f.write(file,wif.slice(0,-1)+(wif.endsWith("1")?"2":"1"));assert.equal(f.scan().components.signingKey.available,false);});

test("full migration service binds selections, copies profile and chain, and keeps production off",async t=>{
 const f=fixture(t),{NodeManager}=require("../plugin/service/core/lib/koinos/node-manager"),{createProfileMigration,MARKER}=require("../plugin/service/core/lib/koinos/profile-migration"),{NETWORKS}=require("../plugin/service/core/lib/koinos/constants");
 const templateRoot=path.resolve(__dirname,"../plugin/service/core/koinos-node-template"),dataRoot=path.join(f.dest,"koinos-node","node");
 f.write(path.join(f.source.root,"config","genesis_data.json"),fs.readFileSync(path.join(templateRoot,"mainnet","genesis_data.json")));f.write(path.join(f.source.basedir,"chain","one.sst"),"chain-bytes");f.write(path.join(f.source.basedir,"block_store","two.sst"),"block-bytes");
 const manager=new NodeManager({templateRoot,dataRoot,autoRecover:false});manager.profileContext=f.ctx;let rows=["chain","block_store"].map((service,i)=>({id:String(i+1).repeat(64),project:NETWORKS.mainnet.composeProject,root:f.source.root,service,image:"koinos/koinos-"+service.replaceAll("_","-")+":latest",running:true,paused:false,mounts:[{Type:"bind",Source:f.source.basedir,Destination:"/koinos",RW:true}]}));
 const commands=[],ok=stdout=>({ok:true,stdout:stdout||""});const exec=async(_bin,args)=>{commands.push(args);if(args[0]==="context")return ok(JSON.stringify("unix:///var/run/docker.sock"));if(args[0]==="ps")return ok(rows.map(r=>r.id.slice(0,12)).join("\n"));if(args[0]==="inspect")return ok(rows.map(r=>JSON.stringify(r)).join("\n"));if(args[0]==="update")return ok();if(args[0]==="stop"){rows.forEach(r=>r.running=false);return ok();}if(args[0]==="rm"){rows=[];return ok();}throw Error("Unexpected Docker mutation");};
 const service=createProfileMigration({manager},{exec,claim:()=>()=>{},profileRoots:[]});t.after(()=>manager.dispose());
 const preview=await service.preview("mainnet",{chain:true,settings:true,signingKey:true,wallet:false});assert.equal(preview.available,true);assert.equal(preview.profileReview,undefined);assert.equal(preview.producer.address,f.address);assert.equal(commands.some(c=>c[0]==="stop"),false);
 service.start("mainnet",preview.previewId);while(service.running)await new Promise(r=>setTimeout(r,5));const result=service.status("mainnet");assert.equal(result.phase,"complete",result.error);assert.equal(result.result.copiedFiles,2);assert.equal(result.result.deletedFiles,0);assert.equal(f.ctx.settings.get("producer.mode"),"external");assert.equal(manager._desiredRunning,false);
 assert.equal(fs.readFileSync(path.join(manager.dirs("mainnet").producerKeyDir,"private.key"),"utf8"),f.hot.getPrivateKey("wif")+"\n");assert.equal(fs.readFileSync(path.join(f.source.basedir,"chain","one.sst"),"utf8"),"chain-bytes");assert.equal(fs.existsSync(path.join(f.source.basedir,MARKER)),true);assert.equal(fs.existsSync(path.join(manager.dirs("mainnet").basedir,MARKER)),false);
 const journal=fs.readFileSync(path.join(dataRoot,".profile-migrations","mainnet.json"),"utf8");assert.ok(!journal.includes(f.hot.getPrivateKey("wif")));assert.ok(!journal.includes("DO NOT COPY"));assert.equal(commands.some(c=>c.includes("up")),false);await service.dispose();
});
test("malformed public-key text is refused rather than silently decoded",t=>{const f=fixture(t);f.write(path.join(f.source.basedir,"block_producer","public.key"),f.publicKey+"!!");assert.equal(f.scan().components.signingKey.available,false);});

test("external producer account spending key cannot be disguised as a hot key",t=>{const f=fixture(t),owner=new Signer({privateKey:"1".padStart(64,"0")});f.write(path.join(f.source.basedir,"block_producer","private.key"),owner.getPrivateKey("wif"));f.write(path.join(f.source.basedir,"block_producer","public.key"),utils.encodeBase64url(owner.publicKey));assert.equal(f.scan().components.signingKey.available,false);});

test("uncompressed legacy production keys remain usable by custody verification",t=>{
 const f=fixture(t),signer=new Signer({privateKey:"2".padStart(64,"0"),compressed:false}),publicKey=utils.encodeBase64url(signer.publicKey);
 f.write(path.join(f.source.basedir,"block_producer","private.key"),signer.getPrivateKey("wif",false));f.write(path.join(f.source.basedir,"block_producer","public.key"),publicKey);
 const record=f.record();assert.equal(record.preview.components.signingKey.available,true);f.apply(record);
 const {ProducerCustody}=require("../plugin/service/core/lib/koinos/producer-custody"),custody=new ProducerCustody({settings:f.ctx.settings,wallet:f.ctx.wallet,chain:{network:()=>({id:"mainnet"})},nodeMgr:{dirs:()=>({producerKeyDir:f.keyDir}),readProducerPublicKey:()=>fs.readFileSync(path.join(f.keyDir,"public.key"),"utf8").trim()}});
 assert.equal(custody.hotPublicKey(),publicKey.replace(/=+$/,""));
});

test("Core and sibling plugin profiles cannot be imported as legacy Node identities",t=>{
 const f=fixture(t),saved=JSON.parse(fs.readFileSync(path.join(f.core,"koinos-node","settings.json")));const pluginCore=path.join(f.root,"foundation-v1","plugins","Koinos AI","core"),node=path.join(pluginCore,"koinos-node","node","mainnet");
 f.write(path.join(pluginCore,"koinos-node","settings.json"),JSON.stringify(saved));assert.throws(()=>profile.sourceCore({root:node},"mainnet",[pluginCore]),/matching legacy/);
 const arbitrary=path.join(f.root,"arbitrary","core");f.write(path.join(arbitrary,"koinos-node","settings.json"),JSON.stringify(saved));assert.throws(()=>profile.sourceCore({root:path.join(arbitrary,"koinos-node","node","mainnet")},"mainnet",[arbitrary]),/matching legacy/);
});

test("stored public-key format remains authoritative with a differently marked WIF",t=>{const f=fixture(t);f.write(path.join(f.source.basedir,"block_producer","private.key"),f.hot.getPrivateKey("wif",false));assert.equal(f.scan().components.signingKey.available,true);});
