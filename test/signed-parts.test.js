"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path"), os = require("node:os"), crypto = require("node:crypto");
const { assemble } = require("../scripts/assemble-signed-package");
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kai-signed-parts-")); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, "plugin")); fs.mkdirSync(path.join(root, "dist"));
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "fixture" })); fs.writeFileSync(path.join(root, "plugin/manifest.json"), JSON.stringify({ version: "1.0.0" }));
  const data = Buffer.from([0, 255, 13, 10, 128, 42, 0, 99]), asset = "fixture-1.0.0.kaiplugin", hash = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
  const manifest = { format: 1, asset, bytes: data.length, sha256: hash(data), parts: [data.subarray(0, 4), data.subarray(4)].map((bytes, index) => { const file = asset + ".part" + String(index + 1).padStart(3, "0"); fs.writeFileSync(path.join(root, "dist", file), bytes); return { file, bytes: bytes.length, sha256: hash(bytes) }; }) };
  const save = () => fs.writeFileSync(path.join(root, "dist", asset + ".parts.json"), JSON.stringify(manifest)); save();
  return { root, data, manifest, save, output: path.join(root, "dist", asset) };
}
test("signed parts retain exact binary bytes and repeat safely", t => { const f = fixture(t); assemble(f.root); assert.deepEqual(fs.readFileSync(f.output), f.data); assemble(f.root); });
test("tampered part cannot produce an installable output", t => { const f = fixture(t); fs.writeFileSync(path.join(f.root, "dist", f.manifest.parts[0].file), Buffer.alloc(4)); assert.throws(() => assemble(f.root), /hash differs/); assert.equal(fs.existsSync(f.output), false); });
test("part metadata cannot redirect reads outside its asset", t => { const f = fixture(t); f.manifest.parts[0].file = "../package.json"; f.save(); assert.throws(() => assemble(f.root), /Unexpected part/); });
test("a different existing output is preserved", t => { const f = fixture(t); fs.writeFileSync(f.output, "keep"); assert.throws(() => assemble(f.root), /Existing output differs/); assert.equal(fs.readFileSync(f.output, "utf8"), "keep"); });
function sourceFixture(t) {
  const f = fixture(t), { signingPayload } = require('../scripts/package-format-v3');
  const manifest = { schema: 2, apiVersion: 3, id: 'test.fixture', version: '1.0.0', name: 'Fixture', runtime: 'sandboxed', entry: 'index.html', permissions: [] };
  const files = { 'index.html': '<h1>Verified source</h1>' }, pair = crypto.generateKeyPairSync('ed25519');
  const publicKey = pair.publicKey.export({format:'der',type:'spki'}).toString('base64');
  const signature = crypto.sign(null,Buffer.from(signingPayload(manifest,files)),pair.privateKey).toString('base64');
  const hash = data => crypto.createHash('sha256').update(data).digest('hex');
  const data = Buffer.from(JSON.stringify({manifest,files,publicKey,signature}));
  fs.writeFileSync(path.join(f.root,'plugin/manifest.json'),JSON.stringify(manifest));
  fs.writeFileSync(path.join(f.root,'plugin/index.html'),files['index.html']);
  fs.writeFileSync(path.join(f.root,'publisher.json'),JSON.stringify({publicKey,fingerprint:hash(pair.publicKey.export({format:'der',type:'spki'}))}));
  const record={format:1,asset:path.basename(f.output),bytes:data.length,sha256:hash(data),publicKey,signature};
  fs.writeFileSync(f.output+'.signature.json',JSON.stringify(record));
  return {...f,data};
}
test('detached publisher signature rebuilds identical immutable bytes without a private key',t=>{const f=sourceFixture(t);assemble(f.root);assert.deepEqual(fs.readFileSync(f.output),f.data);assemble(f.root);});
test('modified source fails detached signature verification before creating output',t=>{const f=sourceFixture(t);fs.appendFileSync(path.join(f.root,'plugin/index.html'),'tamper');assert.throws(()=>assemble(f.root),/signature verification failed/);assert.equal(fs.existsSync(f.output),false);});
test('detached assembly never overwrites a different output',t=>{const f=sourceFixture(t);fs.writeFileSync(f.output,'keep');assert.throws(()=>assemble(f.root),/Existing output differs/);assert.equal(fs.readFileSync(f.output,'utf8'),'keep');});
