"use strict";
// Native smoke instrumentation, never included in the signed plugin payload.
// The real Core, plugin host, public SDK, renderer and feature engines run.
// Public/local RPC and process creation are blocked so no live node or funds
// can be touched by this disposable-profile test.
function install({ coreRoot, appData, reportFile }) {
  require(require("node:path").join(coreRoot, "scripts/foundation/apps-fixture.js"))
    .install({ appRoot: coreRoot, appData, reportFile, syntheticKeychain: true });
  const { EventEmitter } = require("node:events"), { PassThrough } = require("node:stream");
  const state = global.__masterNativeFixture = { requests: [], processes: [] };
  const blocked = () => Object.assign(new Error("Native smoke blocks live network and external processes"), { code: "KAI_SMOKE_BLOCKED" });
  const recordRequest = raw => {
    let origin = "unknown";
    try { origin = new URL(typeof raw === "string" || raw instanceof URL ? String(raw) : raw?.url || "").origin; } catch {}
    state.requests.push(origin);
  };
  global.fetch = async raw => { recordRequest(raw); throw blocked(); };
  for (const name of ["node:http", "node:https"]) {
    const module = require(name);
    module.request = raw => { recordRequest(raw); throw blocked(); };
    module.get = raw => { recordRequest(raw); throw blocked(); };
  }
  const processModule = require("node:child_process");
  const child = () => {
    const result = new EventEmitter();
    result.stdout = new PassThrough(); result.stderr = new PassThrough();
    result.stdin = new PassThrough(); result.pid = -1; result.kill = () => true; result.unref = () => {};
    return result;
  };
  for (const method of ["execFile", "exec", "spawn"]) processModule[method] = (...args) => {
    state.processes.push({ method, command: String(args[0]).slice(0, 160) });
    const result = child(), callback = args.findLast(value => typeof value === "function");
    setImmediate(() => {
      if (callback) callback(blocked(), "", "");
      else result.emit("error", blocked());
      result.stdout.end(); result.stderr.end(); result.emit("exit", 1); result.emit("close", 1);
    });
    return result;
  };
  for (const method of ["execFileSync", "execSync", "spawnSync"]) processModule[method] = (...args) => {
    state.processes.push({ method, command: String(args[0]).slice(0, 160) }); throw blocked();
  };
}
module.exports = { install };
