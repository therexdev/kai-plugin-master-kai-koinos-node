"use strict";
const fs = require("node:fs"), path = require("node:path");
const { WalletService } = require("./core/lib/wallet");
const { create: createNode, safePath } = require("./electron/plugin-services/koinos-node-full");

// This is explicitly trusted native code. Renderer isolation does not confine
// this module; its full-computer-access grant is reviewed at installation.
function create(api, dependencies = {}) {
  if (api.version !== 1) throw Error("Koinos Node requires Foundation API v1");
  const electron = dependencies.electron || require("electron");
  fs.mkdirSync(api.plugin.dataDir, { recursive: true, mode: 0o700 });
  const profileStat = fs.lstatSync(api.plugin.dataDir);
  if (!profileStat.isDirectory() || profileStat.isSymbolicLink()) throw Error("Node profile must be a real directory.");
  // The host chooses this root. OS ancestors may be aliases (/var on macOS),
  // while every wallet/Node path below the canonical root remains guarded.
  const dataDir = fs.realpathSync(api.plugin.dataDir);
  const walletDir = path.join(dataDir, "wallet");
  safePath(walletDir);
  const walletFile = path.join(walletDir, "wallet.json");
  if (fs.existsSync(walletFile)) {
    const stat = fs.lstatSync(walletFile);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 1024 * 1024) throw Error("Node wallet storage is unsafe; the file was preserved.");
    let saved;
    try { saved = JSON.parse(fs.readFileSync(walletFile, "utf8")); } catch { throw Error("Node wallet is unreadable; restore its backup deliberately."); }
    if (!saved || typeof saved !== "object" || !saved.address || !saved.crypto) throw Error("Node wallet format is invalid; the file was preserved.");
  }
  const wallet = dependencies.wallet || new WalletService(walletDir);
  let spendTail = Promise.resolve(), disposed = false, disposing = null;
  const active = () => { api.signal.throwIfAborted(); if (disposed) throw Error("Koinos Node is closing"); };
  const withWalletSpend = run => {
    const work = spendTail.catch(() => {}).then(() => { active(); return run(); });
    spendTail = work; return work;
  };
  const service = (dependencies.createNode || createNode)({
    dataDir, wallet, version: api.plugin.version,
    settings: api.settings, electron, withWalletSpend,
    getWindow: () => electron.BrowserWindow.fromId(api.desktop.hostWindowId()),
    confirm: (title, detail) => api.desktop.confirm(title, detail),
  });
  return {
    call(method, input, signal) {
      active();
      if (method === "node.appSettings") {
        if (input !== undefined && (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).length)) throw Error("App settings takes no options.");
        return api.desktop.openCore("settings");
      }
      return service.call(method, input, signal || api.signal);
    },
    startBackground() { active(); return service.startBackground(); },
    privacyChanged(mode) { return service.privacyChanged(mode); },
    dispose(options) {
      if (disposing) return disposing;
      disposed = true;
      disposing = (async () => { await service.dispose(options); await spendTail.catch(() => {}); wallet.lock(); })().catch(error => { disposing = null; throw error; });
      return disposing;
    },
  };
}
module.exports = { create };
