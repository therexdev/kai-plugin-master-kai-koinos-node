"use strict";
// The original Node engine and renderer retain their complete channel contract.
// This boundary adds only plugin scope, native review, plugin-owned spend coordination,
// guarded persistence, and transport for the isolated plugin window.
const fs = require("node:fs"), path = require("node:path");
const { deepMerge } = require("../../core/lib/store");
const { NETWORKS } = require("../../core/lib/koinos/constants");
const READ = new Set(["app:info","wallet:status","wallet:summary","wallet:history","producer:balances","chain:balances","chain:sync","chain:maxBurn","producer:status","producer:draft","producer:vaultStatus","node:status","node:profileMigrationPreview","node:profileMigrationStatus","setup:status","node:logs","node:dataDir","node:inspectDataDir","node:moveDataDirStatus","node:backups","node:quickSyncInfo","network:producers","dashboard:summary","rewards:status","distribution:status","masterApi:status","masterApi:checkHistory","fund:status","fund:ethBalance","fund:bridgeStatus","fund:routeCStatus","fund:bridgeMax","fund:bridgeQuote","fund:routeCompare","fund:ethSendQuote","fund:ethSendMax","fund:cryptoBalances","fund:usdtSendQuote","fund:usdtSendMax","fund:usdtFundQuote","fund:vkoinSendQuote","fund:vkoinSendMax","fund:routeMaxEth","util:copy"]);
const WALLET = new Set(["wallet:create","wallet:import","wallet:unlock","wallet:lock","wallet:revealWif","wallet:remove","chain:burn","chain:send","producer:register","producer:configure","producer:key","producer:prepare","producer:broadcast","producer:vaultConnect","producer:vaultUse","producer:vaultPrepare","producer:vaultSend","producer:vaultDisconnect","rewards:configure","rewards:runNow","distribution:configure","distribution:runNow","distribution:distributeNow","distribution:resetStats"]);
const FUND = new Set(["fund:buyUrl","fund:bridgeReset","fund:bridgeAdvance","fund:bridgeStart","fund:routeCReset","fund:routeCAdvance","fund:routeCResume","fund:routeCStart","fund:ethSend","fund:usdtSend","fund:vkoinSend"]);
const MANAGE = new Set(["masterApi:configure","settings:update","setup:installWsl","setup:restart","setup:cancelRestart","setup:installDocker","setup:cancelInstallDocker","setup:startDocker","setup:markWslReady","setup:openDockerDocs","util:openExternal","util:openPath","node:start","node:stop","node:profileMigrationStart","node:profileMigrationCancel","node:repairServices","node:setAutoRecover","node:setDataDir","node:moveDataDir","node:moveDataDirCancel","node:deleteBackup","node:quickSync","node:quickSyncCancel"]);
const LOCAL = new Set(["app:info","wallet:status","wallet:create","wallet:import","wallet:unlock","wallet:lock","wallet:revealWif","wallet:remove","producer:draft","fund:status","fund:bridgeStatus","fund:routeCStatus","node:stop","node:logs","node:dataDir","node:inspectDataDir","node:moveDataDirStatus","node:moveDataDirCancel","node:backups","node:deleteBackup","node:quickSyncCancel","setup:status","setup:cancelRestart","setup:cancelInstallDocker","util:copy","util:openPath"]);
const MONEY = new Set([...FUND].filter(name => !["fund:buyUrl","fund:bridgeReset","fund:routeCReset"].includes(name)).concat(["chain:burn","chain:send","producer:register","producer:broadcast","producer:vaultSend","rewards:runNow","rewards:configure","distribution:configure","distribution:runNow","distribution:distributeNow","distribution:resetStats","wallet:create","wallet:import","wallet:remove"]));
const REVIEW = new Set([...MANAGE, ...WALLET, ...FUND].filter(name => !["wallet:unlock","wallet:lock","producer:vaultStatus","producer:vaultDisconnect","setup:cancelRestart","setup:cancelInstallDocker","node:quickSyncCancel","node:moveDataDirCancel","node:profileMigrationCancel"].includes(name)));
const permissions = Object.freeze({"node.read":"koinos-node.read","node.events":"koinos-node.read","node.language":"koinos-node.read","node.manage":"koinos-node.manage","node.pickFolder":"koinos-node.manage","node.wallet":"koinos-node.wallet","node.fund":"koinos-node.fund","node.exportDraft":"koinos-node.wallet"});
const groups = {"node.read":READ,"node.manage":MANAGE,"node.wallet":WALLET,"node.fund":FUND};
const plain = value => value && typeof value === "object" && !Array.isArray(value);
function safePath(target, file = false) {
  const absolute=path.resolve(target), root=path.parse(absolute).root; let current=root;
  for (const part of absolute.slice(root.length).split(path.sep).filter(Boolean)) { current=path.join(current,part); let st; try { st=fs.lstatSync(current); } catch (e) { if (e.code === "ENOENT") continue; throw e; }
    if (st.isSymbolicLink() || (file && current === absolute ? !st.isFile() || st.nlink !== 1 || st.size > 8*1024*1024 : !st.isDirectory())) throw Error("Node storage is unsafe; the original data was preserved");
  }
}
const { runOperation } = require("../../core/lib/koinos/operation-lifetime");
function create(ctx, { createEngine = require("../../core/lib/koinos-node").createKoinosNode, GuardedStore = require("./guarded-store").GuardedStore } = {}) {
  let closed=false, engine=null, serial=0, mutation=false, services=null, signingLease=null, disposing=null, cleaning=false, stoppingNetwork=null;
  const events=[], pending=new Set(), stores=[];
  const dataDir=fs.realpathSync(ctx.dataDir),root=path.join(dataDir,"koinos-node"); safePath(root);
  const assertActive=signal=>{ signal?.throwIfAborted(); if(closed)throw Error("Koinos Node is closing"); for(const store of stores)store.assert(); };
  // Original Node opt-in is independent of AI privacy. Installed/enabled
  // publisher scopes and explicit native reviews authorize these chain actions;
  // this broker never reads or changes the AI networking mode.
  const networkAllowed=()=>{try {assertActive();return true;}catch{return false;}};
  const redactSecrets=text=>String(text).replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/g,"[private key redacted]").replace(/\b[5KL][1-9A-HJ-NP-Za-km-z]{50,51}\b/g,"[private key redacted]").replace(/((?:password|passwd|secret|private[_ -]?key|authorization)\s*[=:]\s*)([^\s,;]+)/gi,"$1[redacted]");
  const event = value => {if(closed)return;const text=JSON.stringify(value,(key,item)=>/^(password|passwd|wif|private.?key|secret|authorization)$/i.test(key)?"[redacted]":typeof item==="string"?redactSecrets(item):item);if(text.length>128000)return;events.push({id:++serial,event:JSON.parse(text)});if(events.length>250)events.splice(0,events.length-250);};
  function storeFactory(file, defaults) {
    safePath(file,true);const store=new GuardedStore(file);store.data=deepMerge(structuredClone(defaults),store.data);
    store.all=()=>{store.assert();return structuredClone(store.data);};store.health=()=>{store.assert();return{ok:true,error:null,recoveredFromBackup:false,backupError:null};};
    store.reopen=()=>{store.assert();const fresh=new GuardedStore(file);fresh.health=()=>{fresh.assert();return{ok:true};};return fresh;};
    stores.push(store);return store;
  }
  function identity() {
    const file=path.join(root,"settings.json");safePath(file,true);
    const settings=engine?.settings?.all?.()||(fs.existsSync(file)?JSON.parse(fs.readFileSync(file,"utf8")):{});
    const address=ctx.wallet.status().address||null,network=settings.network||"mainnet";
    return {address,network,rpc:JSON.stringify(settings.customRpc||{}),producer:settings.producer?.mode==="external"?settings.producer.addresses?.[network]||null:address};
  }
  function assertIdentity(expected) {const next=identity();if(next.address!==expected.address||next.network!==expected.network||next.rpc!==expected.rpc||next.producer!==expected.producer)throw Error("Wallet or Node network changed during review. Review this action again.");}
  function assertSigning(lease) {assertActive();if(!lease||signingLease!==lease)throw Error("Node signing is outside the approved wallet operation");lease.signal?.throwIfAborted();assertIdentity(lease.identity);}
  const guardedSigner=signer=>{
    const lease=signingLease;
    return new Proxy(signer,{get(target,key,receiver){const value=Reflect.get(target,key,receiver);if(key==="provider"&&value)return new Proxy(value,{get(provider,method){const entry=Reflect.get(provider,method,provider);if(typeof entry!=="function")return entry;return(...args)=>{if(method==="sendTransaction")assertSigning(lease);return entry.apply(provider,args);};}});if(typeof value!=="function")return value;return function(...args){if(["signHash","signTransaction","signMessage","sign","sendTransaction","getPrivateKey"].includes(key))assertSigning(lease);return value.apply(receiver,args);};}});
  };
  const guardedWallet=()=>new Proxy(ctx.wallet,{get(target,key){const value=Reflect.get(target,key,target);if(key==="signer")return guardedSigner(value);if(key==="signerFor")return(...args)=>guardedSigner(value.apply(target,args));if(key==="ethPrivateKey")return(...args)=>{assertSigning(signingLease);return value.apply(target,args);};return typeof value==="function"?value.bind(target):value;}});
  async function spend(run,signal,expected=identity()) {
    if(typeof ctx.withWalletSpend!=="function")throw Error("Node wallet coordination is unavailable.");
    return ctx.withWalletSpend(async()=>{assertActive(signal);assertIdentity(expected);const lease={signal,identity:expected};signingLease=lease;try{return await runOperation(()=>assertSigning(lease),run);}finally{if(signingLease===lease)signingLease=null;}});
  }
  const track = promise => {pending.add(promise);promise.finally(()=>pending.delete(promise)).catch(()=>{});return promise;};
  function getEngine() {
    assertActive();if(engine)return engine;
    for(const name of ["settings.json","state.json","fund-bridge.json","fund-routec.json","node-supervisor.json"]) {
      const file=path.join(root,name);safePath(file,true);
      if(fs.existsSync(file)){let value;try{value=JSON.parse(fs.readFileSync(file,"utf8"));}catch{throw Error("Saved Node data is unreadable: "+name+". The original file was preserved.");}if(!plain(value))throw Error("Saved Node data needs recovery: "+name);}
    }
    engine=createEngine({dataDir,wallet:guardedWallet(),appVersion:ctx.version,onEvent:event,storeFactory,networkAllowed,
      runBackground:(_name,run)=>track(spend(run)),
      configureServices(value){
        services=value;
        value.setup.assertActive=()=>assertActive();
        value.nodeMgr.assertOperation=action=>{if(cleaning&&["down","stop","ps","logs","version","config"].includes(action))return;assertActive();};
        const settings=value.settings, dataRoot=settings.get("node.dataDir",null);
        if(dataRoot!==null&&(typeof dataRoot!=="string"||!path.isAbsolute(dataRoot)||/[\0\r\n$]/.test(dataRoot)))throw Error("Saved node data directory needs recovery");
        safePath(dataRoot||path.join(root,"node"));
        if(!Object.hasOwn(NETWORKS,settings.get("network","mainnet")))throw Error("Saved node network needs recovery");
        const intentStore=storeFactory(value.nodeMgr.intentPath,{});
        value.nodeMgr._persistIntent=()=>{if(!cleaning)assertActive();for(const [network,intent]of Object.entries(value.nodeMgr._intent))if(Object.hasOwn(NETWORKS,network))intentStore.set(network,intent);};
        const ensure=value.nodeMgr.ensureFiles.bind(value.nodeMgr);
        value.nodeMgr.ensureFiles=(network,...args)=>{
          assertActive();const dir=value.nodeMgr.dirs(network).root;safePath(dir);
          const originals=[];
          for(const name of ["docker-compose.yml",".env","config/config.yml","config/rabbitmq.conf","config/koinos_descriptors.pb","config/genesis_data.json"]){const file=path.join(dir,name);safePath(file,true);if(fs.existsSync(file))originals.push([name,fs.readFileSync(file)]);}
          if(originals.length){const backup=path.join(root,"core-config-backups",Date.now()+"-"+require("node:crypto").randomUUID());safePath(backup);for(const[name,bytes]of originals){const file=path.join(backup,name);fs.mkdirSync(path.dirname(file),{recursive:true,mode:0o700});fs.writeFileSync(file,bytes,{flag:"wx",mode:0o600});if(!fs.readFileSync(file).equals(bytes))throw Error("Node configuration backup failed");}}
          return ensure(network,...args);
        };
        for(const flow of [value.bridge,value.routeC])for(const action of ["start","advance","resume"]){
          if(typeof flow[action]!=="function")continue;const invoke=flow[action].bind(flow);
          flow[action]=async(...args)=>{
            assertActive();assertSigning(signingLease);
            if(action==="start"&&(!flow.status()||["done","error"].includes(flow.status().status)))flow.network=value.chain.network().id;
            if(value.chain.network().id!=="mainnet"||flow.network!=="mainnet")throw Error("Node funding uses Ethereum Mainnet and Koinos Mainnet. Select Mainnet before funding.");
            const job=flow.status();if(action!=="start"&&job?.koinosRecipient&&job.koinosRecipient!==ctx.wallet.status().address)throw Error("Restore the wallet that started this funding flow before continuing it. Its saved journal was preserved.");
            const ethAddress=ctx.wallet.ethAddress;
            if(action!=="start"&&job?.ethFrom&&String(job.ethFrom).toLowerCase()!==String(ethAddress).toLowerCase())throw Error("The Ethereum funding wallet changed. Restore the original wallet to continue this flow.");
            if(flow._ethWallet&&String(flow._ethWallet.address).toLowerCase()!==String(ethAddress).toLowerCase()){if(action!=="start")throw Error("The cached funding signer belongs to another wallet");flow._ethWallet=null;flow._ethProvider?.destroy?.();flow._ethProvider=null;}
            flow.provider=value.chain.provider();return invoke(...args);
          };
        }
        const watch=value.nodeMgr._watchTick.bind(value.nodeMgr);value.nodeMgr._watchTick=()=>networkAllowed()?track(Promise.resolve().then(()=>runOperation(()=>assertActive(),()=>watch()))):Promise.resolve();
        const tick=value.rewards.tick.bind(value.rewards);value.rewards.tick=trigger=>trigger==="timer"?track(spend(()=>tick(trigger))):tick(trigger);
        if(value.distribution){const distribute=value.distribution.tick.bind(value.distribution);value.distribution.tick=(trigger,options)=>trigger==="timer"?track(spend(()=>distribute(trigger,options))):distribute(trigger,options);}
      }
    });
    engine.nodeMgr?.profileMigration?.().status(engine.settings.get("network","mainnet"));
    return engine;
  }
  function displayPayload(payload) {
    const redact=(value,key="")=>/password|wif|private|secret|authorization|accessToken|apiKey/i.test(key)?"[not displayed]":Array.isArray(value)?value.map(v=>redact(v)):plain(value)?Object.fromEntries(Object.entries(value).map(([k,v])=>[k,redact(v,k)])):value;
    return JSON.stringify(redact(payload),null,2).slice(0,9000);
  }
  async function revealNative(result, signal) {
    const wif=result?.wif;if(typeof wif!=="string")throw Error("Wallet backup was unavailable");assertActive(signal);
    const answer=await ctx.electron.dialog.showMessageBox(ctx.getWindow(),{type:"warning",title:"Back up your private key",message:"Keep this private key offline. Never share it.",detail:wif,buttons:["Close","Copy private key"],defaultId:0,cancelId:0,noLink:true});
    assertActive(signal);if(answer.response===1)ctx.electron.clipboard.writeText(wif);
    return{address:result.address,nativeShown:true};
  }
  async function utility(channel,payload,signal) {
    if(channel==="util:copy"){if(typeof payload.text!=="string"||payload.text.length>200000)throw Error("Invalid clipboard text");ctx.electron.clipboard.writeText(payload.text);return true;}
    if(channel==="util:openExternal") {const u=new URL(payload.url);if(!["http:","https:"].includes(u.protocol)||u.username||u.password||u.href.length>12000)throw Error("Only HTTP(S) links can be opened");await ctx.electron.shell.openExternal(u.href);return{opened:true};}
    if(channel==="util:openPath"){const e=getEngine(),dir=payload.which==="userData"?root:payload.which==="nodeData"?e.nodeMgr.dirs(e.settings.get("network","mainnet")).root:null;if(!dir)throw Error("Choose the Node data or user data folder");safePath(dir);const error=await ctx.electron.shell.openPath(dir);if(error)throw Error(error);return{opened:dir};}
    return undefined;
  }
  async function call(method,input={},signal) {
    assertActive(signal);if(!plain(input))throw Error("Invalid Node request");
    if(method==="node.language"){if(Object.keys(input).some(key=>key!=="language"))throw Error("Invalid language preference");const i18n=require("../../../i18n");if(input.language!==undefined){const language=i18n.normalize(input.language);if(!language)throw Error("Choose a supported language");ctx.settings.set("interfaceLanguage",language);}const saved=i18n.normalize(ctx.settings.get("interfaceLanguage"));return{language:saved||i18n.detect(ctx.electron.app?.getPreferredSystemLanguages?.()||[ctx.electron.app?.getLocale?.()||"en"]),selected:!!saved};}
    if(method==="node.events"){const after=input.after??0;if(!Number.isSafeInteger(after)||after<0)throw Error("Invalid event cursor");return{cursor:serial,events:events.filter(e=>e.id>after)};}
    if(method==="node.exportDraft") {
      if(Object.keys(input).length)throw Error("Draft export takes no caller file path or contents");
      const draft=await getEngine().call("producer:draft",{});assertActive(signal);
      if(!draft||!plain(draft.transaction))throw Error("Prepare or resume an unsigned transaction first");
      const result=await ctx.electron.dialog.showSaveDialog(ctx.getWindow(),{title:"Download unsigned JSON",defaultPath:"kai-producer-unsigned.json",filters:[{name:"Unsigned transaction JSON",extensions:["json"]}]});assertActive(signal);
      if(result.canceled)return{cancelled:true};if(typeof result.filePath!=="string"||!result.filePath.toLowerCase().endsWith(".json"))throw Error("Choose a JSON filename");
      safePath(result.filePath,true);fs.writeFileSync(result.filePath,JSON.stringify(draft,null,2)+"\n",{mode:0o600,flag:"w"});return{saved:true};
    }
    if(method==="node.pickFolder") {if(Object.keys(input).some(k=>!["title","defaultPath"].includes(k)))throw Error("Invalid folder picker request");const result=await ctx.electron.dialog.showOpenDialog(ctx.getWindow(),{title:typeof input.title==="string"?input.title.slice(0,150):"Choose Node data folder",properties:["openDirectory","createDirectory"],...(typeof input.defaultPath==="string"&&path.isAbsolute(input.defaultPath)?{defaultPath:input.defaultPath}:{})});assertActive(signal);return result.canceled?{canceled:true}:{canceled:false,path:result.filePaths[0],filePaths:result.filePaths};}
    if(!groups[method]||!groups[method].has(input.channel)||Object.keys(input).some(k=>!["channel","payload"].includes(k)))throw Error("Unknown Node channel or channel outside this permission");
    const channel=input.channel,payload=input.payload??{};if(!plain(payload)||Buffer.byteLength(JSON.stringify(payload))>200000)throw Error("Invalid Node payload");
    const captured=structuredClone(payload), reviewedIdentity=identity();
    const isMutation=method!=="node.read";
    if(isMutation&&mutation)throw Error("Wait for the current Node operation to finish");
    if(isMutation)mutation=true;
    try {
      if (channel.startsWith("node:profileMigration") && Object.keys(captured).some(key => key !== "previewId" || channel !== "node:profileMigrationStart")) throw Error("Invalid Node migration request");
      const migrationReview=channel === "node:profileMigrationStart" ? getEngine().nodeMgr.profileMigration().review(reviewedIdentity.network,captured.previewId) : null;
      if (channel === "node:profileMigrationStart") {
        const detail="Network: "+migrationReview.network+"\nFrom: "+migrationReview.source.basedir+"\nTo: "+migrationReview.destination.basedir+"\n\n"+migrationReview.detail+"\n\nEach verified chain file is removed from its old location. On pause or failure, resume this migration before starting either node.\n\n"+migrationReview.walletNotice;
        if (!await ctx.confirm("Stop the old Node and migrate chain data?",detail)) return {phase:"idle",cancelled:true,preview:migrationReview};
        assertActive(signal);assertIdentity(reviewedIdentity);
      }
      if ((engine?.nodeMgr?._profileMigrationActive || engine?.nodeMgr?._profileMigration?.status(reviewedIdentity.network)?.resumable) && isMutation && !["node:profileMigrationCancel", "node:profileMigrationStart"].includes(channel)) throw Error("Pause or finish the chain migration before changing Node settings or wallet controls.");
      const hasStoredReview=["producer:vaultSend","producer:broadcast","rewards:runNow","distribution:runNow","distribution:distributeNow","distribution:resetStats"].includes(channel);
      const storedReview=hasStoredReview?getEngine().review(channel):null;
      if(channel==="producer:vaultSend"&&captured.draftId!==storedReview.draftId)throw Error("The Koin Vault draft changed. Prepare and review it again.");
      const assertReview=()=>{if(hasStoredReview&&JSON.stringify(getEngine().review(channel))!==JSON.stringify(storedReview))throw Error("The reviewed Node draft or return settings changed. Review this action again.");};
      if(REVIEW.has(channel)&&channel!=="node:profileMigrationStart") {const detail=channel+"\nNetwork: "+reviewedIdentity.network+"\nWallet: "+(reviewedIdentity.address||"none")+"\nProducer: "+(reviewedIdentity.producer||"none")+(channel.startsWith("fund:")?"\nFunding assets: Ethereum Mainnet":"")+"\n"+displayPayload(storedReview||captured)+"\n\n"+(channel==="node:start"?"Start this Node using Docker? Docker images may download. If Docker Desktop is missing, its original setup flow may download and open the installer. Windows may request administrator approval; the original setup may increase WSL memory limits. Saved chain data and producer keys are retained.":channel==="node:quickSync"?"Download and verify the chain snapshot, stop this node and replace its chain database? The prior database is retained as a backup. Wallet, producer keys and other data are retained.":channel==="node:moveDataDir"?"Move this node’s chain data to the selected folder? The original checked copy-and-verification flow runs before its location changes.":channel==="setup:restart"?"Restart this computer using the original setup flow? Save your other work before continuing.":channel==="masterApi:configure"?"Apply these Node API settings? When enabled, a loopback HTTP service exposes the allowed public blockchain RPC and producer data. It cannot access this plugin wallet or control the node. Public HTTPS access requires your separately configured proxy. Extended index services apply on the next node start.":channel==="distribution:configure"?"Apply these automatic distribution settings? When enabled, this plugin may reburn KOIN and send profit to these pools and saved recipients until you pause distribution. Verify every percentage, destination and the retained liquid balance.":channel==="distribution:resetStats"?"Pause distribution and reset its accounting, pending reburn and pending payouts to zero? If a transaction result is unknown, first check Wallet History and the blockchain explorer. Reset discards pending accounting and will not undo funds already sent or change lifetime mining statistics.":channel==="rewards:configure"?"Apply these automatic reward-return settings? When enabled, future rewards may be burned or sent according to these values until you disable returns. Verify the destination and limits.":MONEY.has(channel)?"Review the amount, destination and network. This action may move funds or alter your wallet.":"Apply this action to the Node on this computer?");if(!await ctx.confirm("Koinos Node — review action",detail))throw Error("Cancelled. No action was taken.");assertActive(signal);assertIdentity(reviewedIdentity);assertReview();}
      if(channel.startsWith("util:"))return await utility(channel,captured,signal);
      const e=getEngine();
      if(channel==="node:logs"){if(captured.tail!==undefined&&(!Number.isSafeInteger(captured.tail)||captured.tail<1||captured.tail>1000))throw Error("Choose between 1 and 1000 log lines");if(captured.service!==undefined&&captured.service!==""&&!/^[a-z][a-z0-9_]{0,40}$/.test(captured.service))throw Error("Choose a known node service");}
      if(channel==="settings:update"&&captured.network&&captured.network!==reviewedIdentity.network&&services&&[services.bridge,services.routeC].some(flow=>{const job=flow.status();return job&&!["done","error"].includes(job.status);}))throw Error("Finish the active Node funding flow before changing its network");
      if(channel==="wallet:create"&&ctx.wallet.status().exists)throw Error("Your existing wallet is preserved. Unlock it instead.");
      if(channel==="wallet:import"&&ctx.wallet.status().exists)throw Error("Remove the existing wallet deliberately before importing another wallet. Existing data was preserved.");
      if(channel==="chain:send"){if(captured.expectedAddress!==undefined&&captured.expectedAddress!==reviewedIdentity.address||captured.expectedNetwork!==undefined&&captured.expectedNetwork!==reviewedIdentity.network)throw Error("Transfer review does not match the current wallet and network");captured.expectedAddress=reviewedIdentity.address;captured.expectedNetwork=reviewedIdentity.network;}
      const run=async()=>{assertActive(signal);assertIdentity(reviewedIdentity);assertReview();const lease=signingLease;const guard=()=>{if(lease)return assertSigning(lease);assertActive(signal);assertIdentity(reviewedIdentity);};let result=await runOperation(guard,()=>e.call(channel,captured));if(channel==="node:logs")result=redactSecrets(result);if(channel==="wallet:create"||channel==="wallet:revealWif")return revealNative(result,signal);return result;};
      // Local wallet setup does not require network access, but shares the same
      // exclusive wallet gate as purchases, sends and background reward returns.
      const result=MONEY.has(channel)?await spend(run,signal,reviewedIdentity):await run();
      assertActive(signal);return result;
    } finally {if(isMutation)mutation=false;}
  }
  async function drainNative() {
    await services?.setup._installPending?.catch(()=>{});
    await services?.setup._installWatchPending?.catch(()=>{});
    await engine?.nodeMgr._supervisionPending?.catch(()=>{});
    await engine?.nodeMgr._restartPending?.catch(()=>{});
    await engine?.nodeMgr._commandPending?.catch(()=>{});
    await engine?.nodeMgr._quickSyncPending?.catch(()=>{});
    await engine?.nodeMgr._profileMigration?.dispose();
  }
  async function stopManaged() {
    if(!engine)return;
    const manager=engine.nodeMgr, network=stoppingNetwork||manager._watch?.networkId||engine.settings.get("network","mainnet");
    if(!stoppingNetwork&&!manager._desiredRunning&&!manager._control?.has(network))return;
    stoppingNetwork=network;
    cleaning=true;const disposed=manager._disposed;manager._disposed=false;
    try {await manager.stop(network);await manager._commandPending;const op=manager.currentOp?.();if(op?.name==="stop"&&op.code!==0)throw Error(op.error||"Docker did not stop this node. Stop it in Docker Desktop before disabling the plugin.");stoppingNetwork=null;}
    finally {manager._disposed=disposed;cleaning=false;}
  }
  function cancelNative() {
    services?.rewards.stop();services?.distribution?.stop();services?.setup.cancelInstallDocker?.();services?.setup.stopWatchers?.();
    engine?.nodeMgr._profileMigration?.cancel();
    engine?.nodeMgr.cancelQuickSync?.();engine?.nodeMgr.cancelMove?.();engine?.nodeMgr._stopWatchdog?.();
  }
  return {keepAliveOnWindowClose:true,startBackground(){getEngine();},call:(...args)=>track(Promise.resolve().then(()=>call(...args))),
    async privacyChanged() {
      // AI privacy changes cannot stop an explicitly enabled blockchain node,
      // its wallet actions or approved background returns (original behavior).
    },
    dispose({reason="quit"}={}){if(disposing)return disposing;closed=true;cancelNative();if(engine?.nodeMgr){engine.nodeMgr._disposed=true;clearInterval(engine.nodeMgr._supervisor);}
      const apiShutdown=Promise.resolve(services?.masterApi?.dispose());apiShutdown.catch(()=>{});
      disposing=(async()=>{await Promise.allSettled([...pending]);await drainNative();await apiShutdown;if(["disable","remove","uninstall","revoke"].includes(reason))await stopManaged();await engine?.stop();events.length=0;})().catch(error=>{disposing=null;throw error;});return disposing;}
  };
}
module.exports={create,permissions,READ,WALLET,FUND,MANAGE,LOCAL,MONEY,REVIEW,safePath};
