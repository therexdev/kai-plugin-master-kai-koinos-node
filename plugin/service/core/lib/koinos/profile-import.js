"use strict";
// Explicit opt-in import of a verified legacy Node profile. Secret bytes never
// enter the renderer, progress events, or migration journal.
const fs = require("node:fs"), path = require("node:path"), os = require("node:os"), crypto = require("node:crypto");
const { Signer, utils } = require("koilib");
const sha = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
const plain = value => value && typeof value === "object" && !Array.isArray(value);
const exists = file => { try { return fs.lstatSync(file); } catch (e) { if (e.code === "ENOENT") return null; throw e; } };
const samePath = (a, b) => process.platform === "win32" ? path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase() : path.resolve(a) === path.resolve(b);
function safe(file, missing = false) {
  const absolute = path.resolve(file); let cursor = path.parse(absolute).root;
  for (const part of absolute.slice(cursor.length).split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, part); const st = exists(cursor);
    if (!st) { if (missing) continue; throw Error("Legacy Node profile file is missing."); }
    const alias = process.platform === "darwin" && ["/var", "/tmp", "/etc"].includes(cursor);
    if (st.isSymbolicLink() && !alias || cursor !== absolute && !st.isDirectory() && !alias) throw Error("Linked or unsafe Node profile paths cannot be imported.");
  }
}
function read(file, maximum = 1024 * 1024) {
  safe(file); const before = fs.lstatSync(file), identity = s => [s.dev,s.ino,s.size,s.mtimeMs,s.ctimeMs].join(":");
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > maximum) throw Error("Node profile file is linked, invalid or too large.");
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0)); let bytes;
  try {
    if (identity(fs.fstatSync(fd)) !== identity(before)) throw Error("Legacy Node profile changed. Close the old app and review again.");
    const buffer = Buffer.alloc(before.size + 1); let length = 0;
    while (length < buffer.length) { const n = fs.readSync(fd,buffer,length,buffer.length-length,length); if (!n) break; length += n; }
    safe(file);
    if (length !== before.size || identity(fs.fstatSync(fd)) !== identity(before) || identity(fs.lstatSync(file)) !== identity(before)) throw Error("Legacy Node profile changed. Close the old app and review again.");
    bytes = buffer.subarray(0,length);
  } finally { fs.closeSync(fd); }
  return { bytes, hash: sha(bytes) };
}
function json(file) { const value = read(file); try { value.value = JSON.parse(value.bytes.toString("utf8")); } catch { throw Error("Legacy Node profile is unreadable; its files were preserved."); } if (!plain(value.value)) throw Error("Legacy Node profile has an unsupported format."); return value; }
function knownProfiles() {
  const home = os.homedir(), appData = process.platform === "win32" ? process.env.APPDATA || path.join(home,"AppData","Roaming") : process.platform === "darwin" ? path.join(home,"Library","Application Support") : process.env.XDG_CONFIG_HOME || path.join(home,".config");
  return ["Koinos AI","Koinos AI Test","Master Koinos AI Node"].map(name => path.join(appData,name,"core")).concat([path.join(home,".koinos-ai"),path.join(home,".master-koinos-ai")]);
}
function sourceCore(source, network, profiles = knownProfiles()) {
  const candidates = [];
  const node = path.dirname(path.dirname(source.root));
  if (path.basename(node) === "koinos-node" && path.basename(path.dirname(source.root)) === "node") candidates.push(path.dirname(node));
  if (source.profile) candidates.push(path.basename(source.profile).startsWith(".") ? source.profile : path.join(source.profile,"core"));
  candidates.push(...profiles);
  const valid = [];
  for (const core of [...new Set(candidates)]) {
    const parts=path.resolve(core).split(path.sep).map(part=>part.toLowerCase()),base=path.basename(core).toLowerCase(),parent=path.basename(path.dirname(core)).toLowerCase();
    const legacy=(base==="core"&&["koinos ai","koinos ai test","master koinos ai node"].includes(parent))||[".koinos-ai",".master-koinos-ai"].includes(base);
    if(!legacy||parts.includes("foundation-v1")||parts.includes("plugins"))continue;
    const file = path.join(core,"koinos-node","settings.json"); if (!exists(file)) continue;
    const saved = json(file), configured = saved.value.node?.dataDir;
    const root = configured ? typeof configured === "string" && path.isAbsolute(configured) ? path.join(configured,network) : null : path.join(core,"koinos-node","node",network);
    if (root && samePath(root,source.root)) valid.push({ core, file, saved });
  }
  if (valid.length !== 1) throw Error(valid.length ? "More than one legacy profile claims this Node. Resolve the profile conflict before importing settings." : "The matching legacy settings profile was not found. Chain data can still be copied; keep the old profile for manual recovery.");
  return valid[0];
}
function walletValue(file) {
  const saved = json(file), value = saved.value, c = value.crypto, k = c?.kdfparams;
  const hex = (v,n) => typeof v === "string" && new RegExp(`^[a-f0-9]{${n}}$`,"i").test(v);
  if (value.type !== "koinos-ai-keystore" || value.version !== 1 || !utils.isChecksumAddress(value.address) || c?.kdf !== "scrypt" || c.cipher !== "aes-256-gcm" || k?.n !== 16384 || k.r !== 8 || k.p !== 1 || k.dklen !== 32 || !hex(k.salt,64) || !hex(c.cipherparams?.iv,24) || !hex(c.ciphertext,64) || !hex(c.mac,32) || typeof value.createdAt !== "string" || !Number.isFinite(Date.parse(value.createdAt)) || value.compressed !== undefined && typeof value.compressed !== "boolean") throw Error("The encrypted legacy Node wallet is damaged or unsupported.");
  return { ...saved, value: { type: value.type, version:1, address:value.address, createdAt:value.createdAt, crypto:{kdf:"scrypt",kdfparams:{n:16384,r:8,p:1,dklen:32,salt:k.salt},cipher:"aes-256-gcm",cipherparams:{iv:c.cipherparams.iv},ciphertext:c.ciphertext,mac:c.mac}, ...(value.compressed !== undefined ? {compressed:value.compressed}: {}) } };
}
function options(value) {
  if (value === undefined) return {chain:true,settings:false,signingKey:false,wallet:false};
  if (!plain(value) || Object.keys(value).some(k => !["chain","settings","signingKey","wallet"].includes(k)) || ["chain","settings","signingKey","wallet"].some(k => typeof value[k] !== "boolean") || !Object.values(value).some(Boolean) || value.signingKey && !value.settings) throw Error("Select items to import. Importing a signing key also requires its producer settings.");
  return {...value};
}
function inspect({source,network,manager,context,selection,profiles}) {
  const components = {settings:{available:false,detail:"The legacy producer settings are unavailable."},signingKey:{available:false,detail:"No verified production signing key was found."},wallet:{available:false,detail:"No encrypted legacy Node wallet was found."}};
  const producer = {mode:null,address:null,publicKey:null};
  let plan = null;
  if (!context?.settings || !context?.wallet) return {components,producer,plan};
  try {
    const located = sourceCore(source,network,profiles), cfg = located.saved.value;
    const mode = cfg.producer?.mode || "local";
    const rpc=cfg.customRpc?.[network];
    if(rpc!==undefined && (typeof rpc!=="string" || rpc && !/^https?:\/\/\S+$/.test(rpc))) throw Error("Legacy RPC setting is unsupported.");
    if (!["local","external"].includes(mode)) throw Error("Legacy producer custody is unresolved. Confirm it in the old app before migrating.");
    let savedWallet = null, walletError = null;
    const walletFile = path.join(located.core,"wallet","wallet.json");
    // External custody does not read or copy the cold account's wallet file.
    if (mode === "local") try { if (exists(walletFile)) savedWallet = walletValue(walletFile); } catch (e) { walletError = e.message; }
    const address = mode === "external" ? cfg.producer?.addresses?.[network] : savedWallet?.value.address;
    if (!utils.isChecksumAddress(address)) throw Error("The legacy producer address could not be verified from its custody settings and wallet.");
    const config = read(path.join(source.root,"config","config.yml"));
    const producers = [...config.bytes.toString("utf8").matchAll(/^\s*producer:\s*["']?([1-9A-HJ-NP-Za-km-z]+)["']?\s*(?:#.*)?$/gm)].map(m=>m[1]);
    if (producers.length > 1 || producers.length && producers[0] !== address) throw Error("The legacy running configuration and saved producer address disagree. Keep the old node stopped and resolve this before importing.");
    producer.mode=mode;producer.address=address;
    const existingProducer=context.settings.get("producer",null);
    const existingAddress=existingProducer?.mode === "external" ? existingProducer.addresses?.[network] : context.wallet.address;
    const conflicting=mode === "external" ? !!existingProducer && existingAddress!==address : !!existingAddress && existingAddress!==address;
    components.settings={available:!conflicting,detail:conflicting?"This plugin already has a different producer or wallet. Existing settings will not be replaced.":"Keeps the producer address and local/external custody mode. Node auto-start and automatic rewards stay off."};
    const targetKey=path.join(manager.dirs(network).producerKeyDir,"private.key"), targetPublic=path.join(manager.dirs(network).producerKeyDir,"public.key");
    let privateKey=null, publicKey=null;
    try {
      privateKey=read(path.join(source.basedir,"block_producer","private.key"),4096);publicKey=read(path.join(source.basedir,"block_producer","public.key"),4096);
      const wif=privateKey.bytes.toString("utf8").trim();
      if(!utils.isChecksumWif(wif))throw Error("Invalid legacy production key encoding.");
      const publicText=publicKey.bytes.toString("utf8").trim(),decoded=Buffer.from(publicText,"base64");
      if(!/^[A-Za-z0-9+/_-]+={0,2}$/.test(publicText)||![33,65].includes(decoded.length)||![decoded.toString("base64"),decoded.toString("base64").replace(/=+$/, ""),decoded.toString("base64url"),decoded.toString("base64").replace(/\+/g,"-").replace(/\//g,"_")].includes(publicText))throw Error("Invalid legacy production public key encoding.");
      const signer=Signer.fromWif(wif,decoded.length===33), expected=Buffer.from(signer.publicKey).toString("base64url"), actual=decoded.toString("base64url");
      if (expected!==actual) throw Error("The legacy production key pair is inconsistent; it will not be imported.");
      if(mode === "external" && [Signer.fromWif(wif,true).getAddress(),Signer.fromWif(wif,false).getAddress()].includes(address))throw Error("An external account spending key cannot be imported as a production hot key.");
      producer.publicKey=expected;
      components.signingKey={available:!exists(targetKey)&&!exists(targetPublic),detail:exists(targetKey)||exists(targetPublic)?"This plugin already has producer key files. They will not be overwritten.":"Copies the existing production key pair without generating or registering a replacement key."};
    } catch(e) { components.signingKey.detail="Both legacy production key files must be present, safe and consistent."; }
    const targetWallet=context.wallet.keystorePath;
    if(mode === "external") components.wallet={available:false,detail:"External custody keeps the cold account key on its signing device. Only the watch-only address and production hot key can be imported."};
    else components.wallet={available:!!savedWallet&&!!targetWallet&&!exists(targetWallet)&&!exists(path.join(path.dirname(targetWallet),"session.bin"))&&!context.wallet.status().unlocked,address:savedWallet?.value.address||null,detail:walletError||(targetWallet&&exists(targetWallet)?"This plugin already has a wallet. It will not be overwritten.":"Copies the encrypted local producer wallet and keeps it locked. Use the same wallet password to unlock it.")};
    plan={core:located.core,settingsHash:located.saved.hash,configHash:config.hash,walletHash:savedWallet?.hash||null,privateHash:privateKey?.hash||null,publicHash:publicKey?.hash||null,producer:{...producer},targetSettings:sha(JSON.stringify(context.settings.all())),targetWallet:targetWallet||null};
  } catch(e) { components.settings.detail=e.message; }
  return {components,producer,plan};
}
function validate(preview,context) {
  for (const name of ["settings","signingKey","wallet"]) if (preview.options[name] && !preview.components[name]?.available) throw Error(preview.components[name]?.detail || "Selected legacy profile item is unavailable.");
  if(preview.options.settings && preview.producer.mode === "local" && !preview.options.wallet && context.wallet.address !== preview.producer.address) throw Error("Import the encrypted local producer wallet with these settings, or first restore that same wallet in this plugin.");
}
function syncDirectory(directory) {
  let fd;try{fd=fs.openSync(directory,"r");fs.fsyncSync(fd);}catch(e){if(!(process.platform==="win32"&&["EPERM","EISDIR","EINVAL","EACCES"].includes(e.code)))throw e;}finally{if(fd!==undefined)fs.closeSync(fd);}
}
function recoverPublished(file) {
  const marker=file+".kai-profile-copy.json";if(!exists(marker))return;
  const saved=json(marker).value;
  if(!/^[a-f0-9-]{36}$/.test(saved.id)||saved.name!==path.basename(file)||!['wallet.json','private.key','public.key'].includes(saved.name)||!/^([a-f0-9]{64})$/.test(saved.hash))throw Error("Profile copy recovery record is invalid; files were preserved.");
  const temp=file+".kai-migration-"+saved.id+".tmp",target=exists(file),staged=exists(temp);
  safe(file,true);safe(temp,true);
  if(target && staged && target.isFile() && staged.isFile() && !target.isSymbolicLink() && !staged.isSymbolicLink() && target.dev===staged.dev && target.ino===staged.ino && target.nlink===2 && staged.nlink===2){
    if(target.size>65536||sha(fs.readFileSync(file))!==saved.hash)throw Error("Interrupted profile copy differs from its recovery record.");
    fs.unlinkSync(temp);syncDirectory(path.dirname(file));
  }
  if(exists(file) && read(file,65536).hash===saved.hash){if(exists(temp)){if(read(temp,65536).hash!==saved.hash)throw Error("Staged profile copy changed.");fs.unlinkSync(temp);}fs.unlinkSync(marker);syncDirectory(path.dirname(file));}
}
function publish(file,bytes,id) {
  safe(file,true);fs.mkdirSync(path.dirname(file),{recursive:true,mode:0o700});safe(path.dirname(file));
  recoverPublished(file);
  const temporary=file+".kai-migration-"+id+".tmp",marker=file+".kai-profile-copy.json",expected=sha(bytes);
  if(exists(temporary)){if(read(temporary,65536).hash!==expected)throw Error("Staged profile copy differs; it was preserved.");}else{const fd=fs.openSync(temporary,"wx",0o600);try{fs.writeFileSync(fd,bytes);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}}
  if(!exists(marker)){const fd=fs.openSync(marker,"wx",0o600);try{fs.writeFileSync(fd,JSON.stringify({id,name:path.basename(file),hash:expected}));fs.fsyncSync(fd);}finally{fs.closeSync(fd);}syncDirectory(path.dirname(file));}
  // Atomic no-replace publication; startup repairs only the exact journaled
  // same-inode staging link if the process exits between link and unlink.
  fs.linkSync(temporary,file);syncDirectory(path.dirname(file));fs.unlinkSync(temporary);syncDirectory(path.dirname(file));fs.unlinkSync(marker);syncDirectory(path.dirname(file));
}
function verify({record,context,profiles}) {
  const selected=record.preview.options;if(!selected||!["settings","signingKey","wallet"].some(k=>selected[k]))return null;
  const plan=record.preview.profileReview;if(!plan)throw Error("The reviewed legacy profile is missing. Reopen migration.");
  const located=sourceCore(record.source,record.network,profiles),config=read(path.join(record.source.root,"config","config.yml"));
  if(located.core!==plan.core||located.saved.hash!==plan.settingsHash||config.hash!==plan.configHash)throw Error("Legacy Node settings changed after review. Original files were preserved.");
  if(selected.signingKey)for(const[name,expected]of[["private.key",plan.privateHash],["public.key",plan.publicHash]])if(read(path.join(record.source.basedir,"block_producer",name),4096).hash!==expected)throw Error("Legacy production key changed after review.");
  if(selected.wallet && walletValue(path.join(plan.core,"wallet","wallet.json")).hash!==plan.walletHash)throw Error("Legacy encrypted wallet changed after review.");
  const current=sha(JSON.stringify(context.settings.all())),expected=record.profileTargetHash||plan.targetSettings;
  if(current!==expected && current!==record.profileSettingsStep?.after)throw Error("Destination Node settings changed after review. Existing settings were preserved.");
  return located;
}
function apply({record,manager,context,save,profiles}) {
  const selected=record.preview.options;if(!selected||!["settings","signingKey","wallet"].some(k=>selected[k]))return;
  const plan=record.preview.profileReview,located=verify({record,context,profiles});
  const copies=[];
  if(selected.signingKey) for(const [name,expected] of [["private.key",plan.privateHash],["public.key",plan.publicHash]]) {const source=read(path.join(record.source.basedir,"block_producer",name),4096);if(source.hash!==expected)throw Error("Legacy production key changed after review.");copies.push({file:path.join(manager.dirs(record.network).producerKeyDir,name),bytes:source.bytes});}
  if(selected.wallet){if(plan.producer.mode!=="local"||context.wallet.keystorePath!==plan.targetWallet)throw Error("External account keys cannot be imported.");const source=walletValue(path.join(plan.core,"wallet","wallet.json"));if(source.hash!==plan.walletHash)throw Error("Legacy encrypted wallet changed after review.");copies.push({file:context.wallet.keystorePath,bytes:Buffer.from(JSON.stringify(source.value,null,2))});}
  // Persist expected output hashes before publishing. Recovery accepts only
  // exact copies belonging to this reviewed operation; no existing file is replaced.
  if(!record.profilePrepared){for(const copy of copies)if(exists(copy.file))throw Error("Destination wallet or producer key appeared after review. It was preserved.");record.profileOutputs=copies.map(copy=>({file:copy.file,hash:sha(copy.bytes)}));record.profilePrepared=true;record.profileTargetHash=plan.targetSettings;save(record);}
  if(JSON.stringify(record.profileOutputs)!==JSON.stringify(copies.map(copy=>({file:copy.file,hash:sha(copy.bytes)}))))throw Error("Saved profile import does not match its reviewed outputs.");
  context.wallet.lock();
  for(const copy of copies){recoverPublished(copy.file);if(exists(copy.file)){if(read(copy.file).hash!==sha(copy.bytes))throw Error("A destination wallet or producer key differs from this import. Both copies were preserved.");}else publish(copy.file,copy.bytes,record.id);}
  if(!record.profileSettingsComplete){
    const cfg=located.saved.value;
    // Preserve unrelated plugin configuration; never adopt old data directories,
    // session credentials, pending transactions, funding or distribution journals.
    const setReviewed=(key,value)=>{
      const current=context.settings.all(),before=sha(JSON.stringify(current));
      if(record.profileSettingsStep){
        const step=record.profileSettingsStep;
        if(before===step.after){record.profileTargetHash=step.after;record.profileSettingsStep=null;save(record);}
        else if(before!==step.before)throw Error("Destination Node settings changed during recovery. They were preserved.");
      }
      if(before!==record.profileTargetHash)throw Error("Destination Node settings changed during migration. They were preserved.");
      const next=structuredClone(current),parts=key.split(".");let row=next;for(const part of parts.slice(0,-1)){if(!plain(row[part]))row[part]={};row=row[part];}row[parts.at(-1)]=value;
      const after=sha(JSON.stringify(next));record.profileSettingsStep={before,after};save(record);
      context.settings.set(key,value);record.profileTargetHash=after;record.profileSettingsStep=null;save(record);
    };
    setReviewed("rewards.enabled",false);
    setReviewed("node.autoRecover",false);manager.autoRecover=false;
    context.disableAutomations?.(setReviewed);
    if(selected.settings){
      const rpc=cfg.customRpc?.[record.network];if(rpc!==undefined){if(typeof rpc!=="string"||rpc&&!/^https?:\/\/\S+$/.test(rpc))throw Error("Legacy RPC setting is unsupported.");setReviewed("customRpc."+record.network,rpc);}
      setReviewed("producer",{mode:plan.producer.mode,addresses:{...(context.settings.get("producer.addresses",{})),[record.network]:plan.producer.address}});
    }
    context.state?.set("producerDraft",null);context.chain?.clearCache();
    record.profileSettingsComplete=true;save(record);
  }
}
module.exports={options,inspect,validate,verify,apply,sourceCore,read,recoverPublished};
