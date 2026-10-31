"use strict";
const fs=require("node:fs"),path=require("node:path"),crypto=require("node:crypto");
const plain = value => value && typeof value === "object" && !Array.isArray(value);
function safePath(target, file = false, max = 2 * 1024 * 1024) {
  const absolute = path.resolve(target), root = path.parse(absolute).root; let current = root;
  for (const part of absolute.slice(root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part); let st; try { st = fs.lstatSync(current); } catch(e) { if (e.code === "ENOENT") continue; throw e; }
    const isFile = file && current === absolute;
    if (st.isSymbolicLink() || (isFile ? !st.isFile() || st.nlink !== 1 || st.size > max : !st.isDirectory())) throw Error("Node storage is unsafe or too large; original data was preserved");
  }
}
function readFile(file, max) { safePath(file,true,max); try { return fs.readFileSync(file); } catch(e) { if(e.code==="ENOENT")return null;throw e; } }
const hash = bytes => bytes ? crypto.createHash("sha256").update(bytes).digest("hex") : null;
function redact(value) {
  return String(value ?? "").replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/g,"[private key redacted]")
    .replace(/\b[5KL][1-9A-HJ-NP-Za-km-z]{50,51}\b/g,"[private key redacted]")
    .replace(/((?:password|passwd|secret|token|private[_ -]?key|authorization)\s*[=:]\s*)([^\s,;]+)/gi,"$1[redacted]")
    .replace(/\b(?:[a-f\d]{64,}|[A-Za-z\d+/]{80,}={0,2})\b/gi,"[long value redacted]").slice(-64000);
}
// Unlike the legacy JsonStore constructor, this never restores or rewrites a
// corrupt primary merely because a plugin was opened. Unrelated fields survive.
class GuardedStore {
  constructor(file) { this.file=file;this.filePath=file; const bytes=readFile(file); this.digest=hash(bytes); try { this.data=bytes ? JSON.parse(bytes) : {}; } catch { throw Error("Saved node settings are unreadable; original data was preserved"); }
    if(!plain(this.data))throw Error("Saved node settings need recovery");
    if(!bytes && readFile(file+".last-good"))throw Error("Node settings primary is missing. Restore its backup deliberately before using Node");
  }
  assert() { if(hash(readFile(this.file))!==this.digest)throw Error("Node settings changed outside Core. Close and reopen this plugin before editing"); }
  get(key,fallback) { const value=key.split(".").reduce((o,k)=>plain(o)&&Object.hasOwn(o,k)?o[k]:undefined,this.data);return value===undefined?fallback:value; }
  set(key,value) { this.assert();const next=structuredClone(this.data),parts=key.split("."); if(parts.some(k=>["__proto__","constructor","prototype"].includes(k)))throw Error("Invalid node settings key");let row=next;for(const k of parts.slice(0,-1)){if(!plain(row[k]))row[k]={};row=row[k];}row[parts.at(-1)]=value;
    fs.mkdirSync(path.dirname(this.file),{recursive:true,mode:0o700});const previous=readFile(this.file); if(previous){ const backup=this.file+".core-backup-"+Date.now()+"-"+crypto.randomBytes(4).toString("hex");fs.writeFileSync(backup,previous,{flag:"wx",mode:0o600});if(!fs.readFileSync(backup).equals(previous))throw Error("Node configuration backup failed"); }
    const bytes=Buffer.from(JSON.stringify(next,null,2)),temp=this.file+"."+crypto.randomBytes(8).toString("hex")+".tmp";try{
      const fd=fs.openSync(temp,"wx",0o600);
      try{fs.writeFileSync(fd,bytes);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
      this.assert();fs.renameSync(temp,this.file);
      // POSIX needs the rename flushed as well as the contents. Windows does
      // not expose directory fsync; the file itself was flushed before rename.
      if(process.platform!=="win32") { const dir=fs.openSync(path.dirname(this.file),"r");try{fs.fsyncSync(dir);}finally{fs.closeSync(dir);} }
    }finally{fs.rmSync(temp,{force:true});}this.data=next;this.digest=hash(bytes);
  }
}

module.exports={GuardedStore};
