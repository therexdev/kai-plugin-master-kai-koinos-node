"use strict";
const fs = require("fs"), os = require("os"), path = require("path"), { execFileSync } = require("child_process");
const { VERSION, stageRuntime } = require("../plugin/service/core/lib/koinos/block-store-runtime");
const root = path.resolve(__dirname, "../plugin/service/core/node-runtime");
const temp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "kai-block-store-smoke-")));
try {
  stageRuntime(root, temp);
  const staged = path.join(temp, "block-store-runtime");
  const output = execFileSync("docker", ["run", "--rm", "--mount", `type=bind,source=${staged},target=/kai-block-store,readonly`,
    "--entrypoint", "/bin/sh", "koinos/koinos-block-store:v1.1.0", "/kai-block-store/start.sh", "--version"], { encoding: "utf8" });
  if (!output.includes(`(${VERSION})`)) throw new Error("Container did not execute the expected patched runtime");
  process.stdout.write(output);
} finally { fs.rmSync(temp, { recursive: true, force: true }); }
