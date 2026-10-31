"use strict";
// Real Electron/Core integration; deliberately no live Docker/RPC/wallet data.
// KAI_CORE_SOURCE=/path/to/kai-core node scripts/test-master-native.cjs
const fs = require("node:fs"), path = require("node:path"), os = require("node:os");
const crypto = require("node:crypto"), assert = require("node:assert/strict");
const root = path.resolve(__dirname, ".."), coreRoot = path.resolve(process.env.KAI_CORE_SOURCE || path.join(root, "../kai-core"));
const { _electron: electron } = require(path.join(coreRoot, "node_modules/playwright-core"));
const electronPath = require(path.join(coreRoot, "node_modules/electron"));
const { signingPayload, BINARY, verifyPackage } = require(path.join(coreRoot, "core/lib/plugins/package"));
const id = "kai.master-kai-koinos-node", otherId = "kai.koinos-node";
const views = ["dashboard", "wallet", "fund", "burn", "node", "distribution", "master-api", "returns", "settings"];

function installSource(manager, source, key) {
  const manifest = JSON.parse(fs.readFileSync(path.join(source, "manifest.json"), "utf8")), files = {};
  function walk(dir, prefix = "") {
    for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
      assert.equal(item.isSymbolicLink(), false, "Smoke source must not contain symlinks");
      const relative = prefix + item.name;
      if (item.isDirectory()) walk(path.join(dir, item.name), relative + "/");
      else if (relative !== "manifest.json") files[relative] = fs.readFileSync(path.join(dir, item.name)).toString(BINARY.test(relative) ? "base64" : "utf8");
    }
  }
  walk(source);
  const pkg = { manifest, files, publicKey: key.publicKey.export({ format: "der", type: "spki" }).toString("base64"),
    signature: crypto.sign(null, Buffer.from(signingPayload(manifest, files)), key.privateKey).toString("base64") };
  verifyPackage(pkg); manager.install(pkg, { trustNative: true }); return manifest;
}

async function main() {
  const temp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "kai-master-native-"))), profile = path.join(temp, "profile");
  const output = path.resolve(process.env.KAI_MASTER_NATIVE_OUTPUT || path.join(os.tmpdir(), "kai-master-native-smoke"));
  fs.mkdirSync(output, { recursive: true });
  const report = { realCore: true, realPluginService: true, realElectron: true, platform: process.platform,
    syntheticProfile: true, syntheticKeychain: true, ephemeralPackageSignatures: true, liveNetwork: false, liveDocker: false,
    checks: [], screenshots: [], failures: [] };
  require(path.join(coreRoot, "electron/foundation-profile")).prepareFoundationProfile(profile);
  fs.writeFileSync(path.join(profile, "settings.json"), JSON.stringify({ network: { privacyMode: "local-only" }, earn: { autoStart: false } }));
  const manager = new (require(path.join(coreRoot, "core/lib/plugins/manager")).PluginManager)(profile);
  const key = crypto.generateKeyPairSync("ed25519"), manifest = installSource(manager, path.join(root, "plugin"), key);
  assert.equal(manifest.id, id); assert.equal(manifest.name, "Master KAI Koinos Node");
  const ordinary = path.resolve(process.env.KAI_ORDINARY_NODE_SOURCE || path.join(root, "../kai-plugin-koinos-node/plugin"));
  if (process.env.KAI_ORDINARY_NODE_SOURCE) assert.ok(fs.existsSync(path.join(ordinary, "manifest.json")),
    "KAI_ORDINARY_NODE_SOURCE must point to the ordinary Node plugin directory containing manifest.json");
  if (fs.existsSync(path.join(ordinary, "manifest.json"))) { assert.equal(installSource(manager, ordinary, key).id, otherId); report.ordinaryNodeInstalled = true; }
  const exitReport = path.join(temp, "exit.json");
  fs.writeFileSync(path.join(temp, "package.json"), JSON.stringify({ name: "kai-master-node-native-smoke", version: require(path.join(coreRoot, "package.json")).version, main: "desktop.js" }));
  fs.writeFileSync(path.join(temp, "desktop.js"), `"use strict";require(${JSON.stringify(path.join(root, "test/master-native-fixture.js"))}).install(${JSON.stringify({ coreRoot, appData: path.join(temp, "app-data"), reportFile: exitReport })});require(${JSON.stringify(path.join(coreRoot, "electron/core-main.js"))});`);
  const args = [];
  if (process.platform === "linux" && process.getuid?.() === 0) args.push("--no-sandbox");
  if (process.platform === "linux" && !process.env.DISPLAY) args.push("--ozone-platform=headless");
  args.push(temp);
  const env = { ...process.env, KAI_CORE_DATA: profile, KAI_CORE_PORT: "0", KAI_CHANNEL: "core", KAI_SMOKE_SYNTHETIC_LOCK: "1" };
  delete env.ELECTRON_RUN_AS_NODE; delete env.KAI_CORE_TOKEN; delete env.KAI_SESSION_SECRET;
  let application, page, logs = "";
  const appEval = expression => application.evaluate(async (_electron, { id, expression }) => {
    const renderer = global.__foundationHost.renderer(id); if (!renderer) throw Error("Master Node renderer is unavailable");
    return renderer.executeJavaScript(expression, true);
  }, { id, expression });
  const until = async (predicate, message, timeout = 30000) => {
    const deadline = Date.now() + timeout;
    do { if (await predicate()) return; await new Promise(resolve => setTimeout(resolve, 100)); } while (Date.now() < deadline);
    throw Error(message);
  };
  const check = async (name, task) => {
    try { await task(); report.checks.push(name); console.log("PASS", name); }
    catch (error) { report.failures.push({ name, error: error.stack || String(error) }); console.error("FAIL", name, error.message); }
  };
  const invoke = (channel, method = "node.read", payload = {}) => appEval(`window.kai.call(${JSON.stringify(method)},${JSON.stringify({ channel, payload })})`);
  try {
    application = await electron.launch({ executablePath: electronPath, args, env, timeout: 60000 });
    for (const stream of [application.process().stdout, application.process().stderr]) stream?.on("data", chunk => { logs = (logs + chunk).slice(-40000); });
    page = await application.firstWindow({ timeout: 60000 });
    await application.evaluate(() => global.__foundationWindow.setContentSize(1697, 1007));
    await page.waitForFunction(() => document.getElementById("version")?.textContent.startsWith("v"), null, { timeout: 60000 });
    await page.locator(`[data-app="${id}"]`).click();
    await until(() => application.evaluate((_electron, id) => global.__foundationHost.windows.get(id)?.ready && global.__foundationHost.selected === id, id), "Master Node did not open", 60000);
    await until(() => appEval("!!document.querySelector('#view-settings').children.length && typeof S !== 'undefined' && !!S.appInfo"), "Master Node renderer did not initialize");
    await check("Master plugin starts through the real Core SDK with a private empty wallet", async () => {
      const info = await invoke("app:info"), wallet = await invoke("wallet:status");
      assert.equal(info.version, manifest.version); assert.equal(wallet.exists, false);
      assert.ok(info.userData.startsWith(manager.dataDir(id) + path.sep));
      assert.equal(fs.existsSync(path.join(manager.dataDir(id), "wallet/wallet.json")), false);
      const isolation = await appEval("({node:typeof require,core:typeof window.kaiCore,bridge:typeof window.kai.call,title:document.title})");
      assert.deepEqual(isolation, { node: "undefined", core: "undefined", bridge: "function", title: "Master KAI Koinos Node" });
      report.service = { version: info.version, walletExists: wallet.exists };
    });
    await check("All nine original Master Node sections render in their original order", async () => {
      assert.deepEqual(await appEval("Array.from(document.querySelectorAll('#nav [data-view]'),item=>item.dataset.view)"), views);
      for (const view of views) {
        await appEval(`document.querySelector('[data-view="${view}"]').click();true`);
        await until(() => appEval(`document.getElementById('view-${view}').classList.contains('active') && document.getElementById('view-${view}').innerText.trim().length>10`), "Missing Master view " + view);
        // Let each real view finish its SDK reads before visiting the next;
        // Core deliberately limits renderer calls to thirty per second.
        await new Promise(resolve => setTimeout(resolve, 500));
        const file = path.join(output, view + ".png");
        await application.evaluate((_electron, { id, file }) => global.__foundationCapture(file, id), { id, file });
        report.screenshots.push(file);
      }
      assert.equal(await appEval("document.getElementById('master-workspace-title').textContent"), "Master KAI Koinos Node");
    });
    await check("Distribution and Node API retain full controls and default to disabled", async () => {
      for (const control of ["di-save", "di-pause", "di-reset", "di-now", "di-close", "di-history", "di-actions", "ma-save", "ma-check-history", "ma-indexes", "ma-metadata-backups"])
        assert.equal(await appEval(`!!document.getElementById(${JSON.stringify(control)})`), true, control);
      const distribution = await invoke("distribution:status"), api = await invoke("masterApi:status");
      assert.equal(distribution.config.enabled, false); assert.equal(api.config.enabled, false); assert.equal(api.listening, false);
      report.distribution = { enabled: distribution.config.enabled, trackingPaused: distribution.trackingPaused };
      report.nodeApi = { enabled: api.config.enabled, listening: api.listening };
    });
    await check("Node API settings use the real native review and cancellation preserves disabled state", async () => {
      await appEval("document.querySelector('[data-view=\"master-api\"]').click();true");
      const result = await appEval("window.kai.call('node.manage',{channel:'masterApi:configure',payload:{enabled:false}}).then(()=>({ok:true}),error=>({ok:false,error:error.message}))");
      assert.equal(result.ok, false); assert.match(result.error, /cancel/i);
      assert.equal((await invoke("masterApi:status")).config.enabled, false);
      const dialogs = await application.evaluate(() => global.__foundationSmoke.dialogs);
      assert.ok(dialogs.some(dialog => /review/i.test(dialog.title || "")));
    });
    if (report.ordinaryNodeInstalled) await check("The regular Node and Master Node have separate saved preferences and data", async () => {
      assert.notEqual(manager.dataDir(id), manager.dataDir(otherId));
      await appEval("window.kai.call('node.language',{language:'es'})");
      const status = await application.evaluate(async (_electron, otherId) => {
        const record = await global.__foundationServices.ensure(otherId); return record.service.call("node.language", {});
      }, otherId);
      assert.notEqual(status.language, "es");
      await appEval("window.kai.call('node.language',{language:'en'})");
    });
    await check("Master Node stays mounted and keeps ticking through navigation and Core tray", async () => {
      const before = await application.evaluate((_electron, id) => global.__foundationHost.renderer(id).id, id);
      await appEval("window.__masterTicks=0;window.__masterTimer=setInterval(()=>window.__masterTicks++,50);true");
      await page.locator('[data-page="plugins"]').click(); await application.evaluate(() => global.__foundationWindow.close());
      await until(() => application.evaluate(() => !global.__foundationWindow.isVisible()), "Core did not enter tray");
      await until(async () => await appEval("window.__masterTicks") > 3, "Master renderer stopped in tray");
      await application.evaluate(() => global.__foundationTray.show()); await page.locator(`[data-app="${id}"]`).click();
      assert.equal(await application.evaluate((_electron, id) => global.__foundationHost.renderer(id).id, id), before);
      await appEval("clearInterval(window.__masterTimer);true");
    });
    await check("The app settings footer opens the Core Settings page through the public API", async () => {
      await appEval("document.getElementById('master-app-settings').click();true");
      await until(() => page.locator('[data-page="settings"]').evaluate(element => element.getAttribute("aria-current") === "page"), "App settings did not navigate to Core Settings");
    });
    await check("No feature startup failures or uncaught renderer exceptions", async () => {
      report.runtime = await application.evaluate(() => ({ background: [...global.__foundationServices.backgroundErrors], errors: global.__foundationSmoke.errors, fixture: global.__masterNativeFixture }));
      assert.deepEqual(report.runtime.background, []); assert.deepEqual(report.runtime.errors, []);
      assert.equal(/No handler registered for/.test(logs), false);
    });
    await check("Removal disposes Master services and leaves the regular Node installed", async () => {
      await page.evaluate(id => window.kaiCore.call("plugins.change", { id, action: "remove" }), id);
      const state = await application.evaluate((_electron, { id, otherId }) => ({ master: global.__foundationServices.services.has(id), ordinary: global.__foundationServices.services.has(otherId), masterView: global.__foundationHost.windows.has(id) }), { id, otherId });
      assert.equal(state.master, false); assert.equal(state.masterView, false); if (report.ordinaryNodeInstalled) assert.equal(state.ordinary, true);
    });
    const process = application.process(), ended = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(Error("Core did not quit within 30 seconds")), 30000);
      process.once("exit", code => { clearTimeout(timeout); code === 0 ? resolve() : reject(Error("Core exit " + code)); });
    });
    await application.evaluate(() => setTimeout(() => global.__foundationTrayMenu.find(item => item.label === "Quit KAI Core Beta").click(), 0));
    await ended; application = null;
    report.exit = JSON.parse(fs.readFileSync(exitReport, "utf8"));
    assert.equal(report.exit.remainingServices, 0); assert.equal(report.exit.remainingViews, 0); assert.deepEqual(report.exit.errors, []);
    report.checks.push("Normal Core quit drains all services and renderers");
    if (report.failures.length) throw Error(`${report.failures.length} native checks failed`);
  } catch (error) { report.error = error.stack || String(error); throw error; }
  finally {
    report.logs = logs; fs.writeFileSync(path.join(output, "report.json"), JSON.stringify(report, null, 2));
    if (application) await application.close().catch(() => {});
    if (!process.argv.includes("--keep-profile")) fs.rmSync(temp, { recursive: true, force: true });
    console.log("Native report", path.join(output, "report.json"));
  }
}
main().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
