"use strict";
const fs = require("fs"), os = require("os"), path = require("path"), crypto = require("crypto"), zlib = require("zlib");
const { execFileSync, spawnSync } = require("child_process");
const { FILES, SOURCE_NAMES, RUNTIME_BYTES } = require("../plugin/service/core/lib/koinos/block-store-runtime");
const ROOT = path.join(__dirname, "..");
const UPSTREAM = "2bb94558df61c71eb241002635444cdddce0843c";
const PATCH = "missing-record-v1";
const VERSION = `2bb94558-kai-${PATCH}`;
const GO_VERSION = "go1.27.1";
const sha = p => crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex");
function compressBinary(bytes) {
  if (bytes.length !== RUNTIME_BYTES) throw new Error("Built block-store runtime size differs from the pinned release.");
  const compressed = zlib.gzipSync(bytes, { level: 9 });
  // No timestamp or source filename; normalize the gzip OS field for transport.
  compressed.writeUInt32LE(0, 4); compressed[9] = 255;
  return compressed;
}

function build(out = path.join(ROOT, "plugin/service/core/node-runtime")) {
  const go = process.env.KAI_GO || "go";
  const run = (bin, args, opts = {}) => execFileSync(bin, args, { stdio: "inherit", ...opts });
  const actualGo = execFileSync(go, ["version"], { encoding: "utf8" }).trim();
  if (!actualGo.includes(` ${GO_VERSION} `)) throw new Error(`Expected ${GO_VERSION}; got ${actualGo}`);
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "kai-block-store-build-"));
  try {
    run("git", ["clone", "--quiet", "--depth", "1", "--branch", "v1.1.0", "https://github.com/koinos/koinos-block-store.git", temp]);
    const actual = execFileSync("git", ["rev-parse", "HEAD"], { cwd: temp, encoding: "utf8" }).trim();
    if (actual !== UPSTREAM) throw new Error("Upstream source revision changed");
    const patchDir = path.join(ROOT, "patches/koinos-block-store");
    fs.copyFileSync(path.join(patchDir, "missing_record_test.go"), path.join(temp, "internal/bstore/missing_record_test.go"));
    const env = { ...process.env, GOTOOLCHAIN: "local", GOFLAGS: "-mod=readonly" };
    // Prove that our fixture reproduces the reported crash before fixing it.
    const before = spawnSync(go, ["test", "./internal/bstore", "-run", "^TestMissingHistoricalRecords$", "-count=1"], { cwd: temp, env, encoding: "utf8", maxBuffer: 8 * 1024 * 1024 });
    const output = String(before.stdout) + String(before.stderr);
    if (before.status === 0 || !/panic: runtime error: invalid memory address or nil pointer dereference/.test(output)) {
      process.stderr.write(output); throw new Error("Regression fixture did not reproduce the upstream crash");
    }
    console.log("Confirmed the unpatched historical query panics.");
    run("git", ["apply", "--check", path.join(patchDir, "missing-record.patch")], { cwd: temp });
    run("git", ["apply", path.join(patchDir, "missing-record.patch")], { cwd: temp });
    run(go, ["test", "./...", "-count=1"], { cwd: temp, env });
    run(go, ["test", "-race", "./internal/bstore", "-run", "^TestMissingHistoricalRecords$", "-count=1"], { cwd: temp, env });
    fs.mkdirSync(out, { recursive: true });
    const executable = path.join(temp, "kai-block-store-output");
    run(go, ["build", "-trimpath", "-buildvcs=false", "-ldflags", `-s -w -X main.Commit=${VERSION}`, "-o", executable, "./cmd/koinos-block-store"], {
      cwd: temp, env: { ...env, GOOS: "linux", GOARCH: "amd64", CGO_ENABLED: "0" },
    });
    const reported = execFileSync(executable, ["--version"], { encoding: "utf8" });
    if (!reported.includes(`(${VERSION})`)) throw new Error("The compiled executable does not identify the history patch");
    fs.writeFileSync(path.join(out, SOURCE_NAMES.koinos_block_store), compressBinary(fs.readFileSync(executable)));
    fs.copyFileSync(path.join(patchDir, "start.sh"), path.join(out, SOURCE_NAMES["start.sh"]));
    fs.copyFileSync(path.join(temp, "LICENSE.md"), path.join(out, "LICENSE.md"));
    const files = FILES.map(name => ({ name, sha256: sha(name === "koinos_block_store" ? executable : path.join(out, SOURCE_NAMES[name])) }));
    fs.writeFileSync(path.join(out, "manifest.json"), JSON.stringify({ schemaVersion: 1, patch: PATCH, version: VERSION,
      platform: "linux/amd64", upstreamCommit: UPSTREAM, goVersion: GO_VERSION, patchSha256: sha(path.join(patchDir, "missing-record.patch")), files }, null, 2) + "\n");
    console.log(`Built verified runtime in ${out}`);
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
}
if (require.main === module) build(path.resolve(process.argv[2] || path.join(ROOT, "plugin/service/core/node-runtime")));
module.exports = { build, compressBinary, UPSTREAM, PATCH, VERSION, GO_VERSION };
