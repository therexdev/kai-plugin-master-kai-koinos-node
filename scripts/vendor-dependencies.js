"use strict";
// Author-time vendoring only. Installations execute no npm/postinstall scripts.
const fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto");
const root = path.resolve(__dirname, ".."), packageJson = require(path.join(root, "package.json"));
const sourceRoot = process.env.KAI_PLUGIN_DEPENDENCY_ROOT ? path.resolve(process.env.KAI_PLUGIN_DEPENDENCY_ROOT) : root;
const output = path.join(root, "plugin/service/node_modules"), inventory = [], copied = new Map();
const allowed = /\.(?:js|cjs|mjs|json|wasm|node|txt|md|pem)$/i;
const omit = new Set(["node_modules", "test", "tests", "__tests__", "docs", "examples", "coverage", ".github", "src.ts", "token-proto copy.json"]);
function locate(name, from) {
  let current = from;
  while (true) {
    const candidate = path.join(current, "node_modules", name);
    if (fs.existsSync(path.join(candidate, "package.json"))) return fs.realpathSync(candidate);
    const parent = path.dirname(current); if (parent === current) throw Error(`Install locked dependency ${name} before building.`); current = parent;
  }
}
function copyDirectory(from, to) {
  for (const item of fs.readdirSync(from, { withFileTypes: true })) {
    if (item.isSymbolicLink()) throw Error("Dependency symlinks are not bundled: " + item.name);
    if (omit.has(item.name) || item.name.startsWith(".")) continue;
    const src = path.join(from, item.name), dest = path.join(to, item.name);
    if (item.isDirectory()) { fs.mkdirSync(dest, { recursive: true }); copyDirectory(src, dest); }
    else if (allowed.test(item.name)) { fs.mkdirSync(to, { recursive: true }); fs.copyFileSync(src, dest); }
    else if (/^(LICENSE|LICENCE|NOTICE|COPYING)(?:-|$)/i.test(item.name)) { fs.mkdirSync(to, { recursive: true }); fs.copyFileSync(src, dest + ".txt"); }
  }
}
function vendor(name, from, targetBase, exact = null) {
  const source = locate(name, from), meta = JSON.parse(fs.readFileSync(path.join(source, "package.json"), "utf8"));
  if (exact && meta.version !== exact) throw Error(`Expected ${name}@${exact}; found ${meta.version}. Use npm ci.`);
  const target = path.join(targetBase, name), identity = `${name}@${meta.version}`;
  if (copied.has(target)) { if (copied.get(target) !== identity) throw Error("Conflicting vendored dependency " + name); return; }
  copied.set(target, identity); copyDirectory(source, target);
  inventory.push({ name, version: meta.version, path: path.relative(path.join(root, "plugin"), target).split(path.sep).join("/") });
  for (const dependency of Object.keys(meta.dependencies || {})) vendor(dependency, source, path.join(target, "node_modules"));
}
fs.rmSync(output, { recursive: true, force: true }); fs.mkdirSync(output, { recursive: true });
for (const [name, version] of Object.entries(packageJson.dependencies || {})) vendor(name, sourceRoot, output, version);
const records = [];
function hashFiles(dir) { for (const item of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) { const file = path.join(dir, item.name); if (item.isDirectory()) hashFiles(file); else records.push({ path: path.relative(path.join(root, "plugin"), file).split(path.sep).join("/"), sha256: crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex") }); } }
hashFiles(output);
fs.writeFileSync(path.join(root, "plugin/service/dependencies.json"), JSON.stringify({ schema: 1, packages: inventory, files: records }, null, 2) + "\n");
console.log(`Bundled ${inventory.length} locked production dependency instances; ${records.length} files.`);
