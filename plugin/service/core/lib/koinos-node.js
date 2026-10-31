"use strict";

const path = require("path");
const fs = require("fs");

const { JsonStore } = require("./store");
// The local earning wallet; external producer custody never imports its account key.
const { MIN_PASSWORD_LENGTH } = require("./wallet");
const { NETWORKS, DEFAULT_SETTINGS } = require("./koinos/constants");
const { ChainService } = require("./koinos/chain");
const { NodeManager } = require("./koinos/node-manager");
const dataMove = require("./koinos/data-move");
const { SetupService } = require("./koinos/setup");
const { DistributionEngine } = require("./koinos/distribution");
const { MasterNodeApi } = require("./koinos/master-api");
const { checkHistory } = require("./koinos/history-check");
const { RewardEngine } = require("./koinos/rewards");
const { createProducerCache } = require("./koinos/network-producers");
const { ProducerStats } = require("./koinos/producer-stats");
const { projectReturns } = require("./koinos/profit-metrics");
const { valuation, createPriceCache, satsToUsd } = require("./koinos/koin-price");
const { parseAmount, formatAmount, subSats, cmpSats } = require("./koinos/format");
const { weiToEth } = require("./koinos/eth");
const { BridgeOrchestrator, MAX_BRIDGE_ETH } = require("./koinos/bridge-orchestrator");
const { RouteCOrchestrator, MAX_ROUTE_C_ETH } = require("./koinos/route-c-orchestrator");
const { quoteDeposit, maxBridgeable, makeProvider } = require("./koinos/eth-bridge");
const { quoteSend, maxSendable, sendEth } = require("./koinos/eth-send");
const { usdtBalance, quoteUsdtSend, maxUsdtSendable, sendUsdt, parseUsdt } = require("./koinos/usdt-send");
const { vkoinBalance, quoteVkoinSend, maxVkoinSendable, sendVkoin } = require("./koinos/vkoin-send");
const { quoteSwap } = require("./koinos/koindx");
const { quoteEthToVkoin, quoteVkoinOut, applySlippage } = require("./koinos/eth-swap");
const { compareRoutes, descriptor } = require("./koinos/fund-routes");

/* Complete plugin-owned Koinos Node engine. Its encrypted wallet, chain
 * configuration, funding journals and Docker supervisor live in this plugin
 * profile. It does not open Core or another application's wallet. */

// The owner's existing onramp relay, shared with Koinos Node Desktop. The app
// key identifies the app to that endpoint; it is a client-side constant in
// both apps, so the endpoint's own caps are what actually bound abuse.
const DEFAULT_ONRAMP_ENDPOINT = "https://koinos-node.vercel.app/api/session";
const ONRAMP_APP_KEY = "kkapp_71854dc40591df1aeb8811a514e3dbc302bb382f";

function buildChannels({ settings, state, wallet, chain, nodeMgr, setup, rewards, distribution, masterApi, stats, bridge, routeC, userData, appVersion, defaultNodeData = null, priceCache: injectedPriceCache = null, producerCache: injectedProducerCache = null, vaultRequest = undefined, onEvent = () => {} }) {
  const channels = new Map();
  const handle = (channel, fn) => channels.set(channel, fn);
  const { ProducerCustody } = require("./koinos/producer-custody");
  const custody = new ProducerCustody({ settings, state, wallet, chain, nodeMgr, rewards, distribution });
  const { ProducerVault } = require("./koinos/producer-vault");
  const vault = new ProducerVault({ custody, chain, request: vaultRequest });
  handle("producer:vaultConnect", () => vault.connect());
  handle("producer:vaultStatus", () => vault.status());
  handle("producer:vaultUse", () => vault.useWallet());
  handle("producer:vaultPrepare", input => vault.prepare(input));
  handle("producer:vaultSend", input => vault.send(input));
  handle("producer:vaultDisconnect", () => vault.disconnect());
  const producerAddress = () => custody.config().address;
  handle("producer:configure", input => custody.configure(input));
  handle("producer:key", input => custody.key(input));
  handle("producer:prepare", input => custody.prepare(input));
  handle("producer:draft", () => custody.savedDraft());
  handle("producer:broadcast", input => custody.broadcast(input));

  // One KOIN price for this Core, refreshed at most every few minutes and kept
  // across failures. Scoped here rather than module-level so a second Core in
  // the same process (the tests make them) does not share one.
  // Injected by createKoinosNode so the dashboard channel and the worker's
  // report to the website quote the SAME price — two caches would drift and
  // the two screens would disagree for no reason a user could explain.
  const priceCache = injectedPriceCache || createPriceCache();

  /*
   * This is the Node plugin wallet. The Node service
   * re-opens it at start-up from a secret the OS holds. So it is nearly always
   * unlocked with nobody present, and "unlocked" proves nothing. Anything that
   * moves value to an address the user does not control proves the password on
   * that call. Reburn (KOIN -> your own VHP) deliberately does not.
   */
  const requirePassword = (password) => {
    wallet.signerFor(password); // throws on a missing or wrong password
    return true;
  };

  const publicNetworks = Object.fromEntries(
    Object.entries(NETWORKS).map(([id, n]) => [
      id,
      {
        id,
        label: n.label,
        tokenSymbol: n.tokenSymbol,
        explorer: n.explorer,
        contracts: n.contracts,
        ports: n.ports,
        rpcUrls: n.rpcUrls,
        localRpcUrl: n.localRpcUrl,
      },
    ])
  );

  // ----- app / settings -----
  handle("app:info", () => ({
    version: appVersion,
    platform: process.platform,
    userData,
    networks: publicNetworks,
    settings: { ...settings.all(), ...(distribution ? { distribution: distribution.config() } : {}) },
    minPasswordLength: MIN_PASSWORD_LENGTH,
  }));

  handle("settings:update", ({ network, customRpc, keepLiquidKoin, onrampEndpoint }) => {
    if (distribution?._busy) throw new Error("Wait for the current distribution operation.");
    if (network !== undefined) {
      if (!NETWORKS[network]) throw new Error(`Unknown network: ${network}`);
      if (network !== chain.network().id && (nodeMgr._desiredRunning || nodeMgr._op?.running)) throw new Error("Stop the node before changing its network.");
      settings.set("network", network);
      chain.clearCache();
      rewards.start(); // re-arm timer; reward baselines are tracked per network
    }
    if (customRpc !== undefined) {
      for (const [netId, url] of Object.entries(customRpc)) {
        if (!NETWORKS[netId]) throw new Error(`Unknown network: ${netId}`);
        if (url && !/^https?:\/\/\S+$/.test(url)) throw new Error("RPC URL must start with http(s)://");
        settings.set(`customRpc.${netId}`, url || "");
      }
      chain.clearCache();
    }
    if (keepLiquidKoin !== undefined) {
      parseAmount(keepLiquidKoin);
      settings.set("keepLiquidKoin", String(keepLiquidKoin));
    }
    if (onrampEndpoint !== undefined) {
      const u = String(onrampEndpoint).trim();
      // Must be https — this endpoint holds the Coinbase secret key.
      if (u && !/^https:\/\/\S+$/.test(u)) throw new Error("Onramp endpoint must be an https:// URL");
      settings.set("onrampEndpoint", u);
    }
    return settings.all();
  });

  // ----- wallet -----
  handle("wallet:status", () => wallet.status());
  handle("wallet:create", ({ password }) => wallet.create({ password }));
  handle("wallet:import", ({ wif, password }) => wallet.importWif({ wif, password }));
  handle("wallet:unlock", ({ password }) => wallet.unlock(password));
  handle("wallet:lock", () => wallet.lock());
  handle("wallet:revealWif", ({ password }) => wallet.revealWif(password));
  handle("wallet:remove", ({ password, confirm }) => wallet.remove({ password, confirm }));

  // The sidebar reads this app's wallet, never the external producer's funds.
  // USD values liquid KOIN only; VHP remains a separate native balance.
  // This read needs neither an unlocked signer nor a running node.
  handle("wallet:summary", async () => {
    const address = wallet.address || null;
    const net = chain.network();
    const rpcIdentity = JSON.stringify(chain.rpcUrls?.() || []);
    const out = { address, network: net.id, tokenSymbol: net.tokenSymbol, koin: null, vhp: null, mana: null, usd: null, price: null, observedAt: null };
    if (!address) return out;
    if (net.id === "mainnet") priceCache.snapshot(); // warm the shared quote without blocking balances
    const balances = await chain.balances(address);
    if (wallet.address !== address || chain.network().id !== net.id || JSON.stringify(chain.rpcUrls?.() || []) !== rpcIdentity) throw new Error("Wallet or network changed; retry the balance.");
    if (balances.error || !/^\d+$/.test(String(balances.koin ?? ""))) throw new Error("Wallet balance unavailable.");
    out.koin = formatAmount(balances.koin, { grouping: false });
    if (/^\d+$/.test(String(balances.vhp ?? ""))) out.vhp = formatAmount(balances.vhp, { grouping: false });
    if (/^\d+$/.test(String(balances.mana ?? ""))) out.mana = formatAmount(balances.mana, { grouping: false });
    out.observedAt = Date.now();
    out.price = net.id === "mainnet" ? priceCache.snapshot() : null;
    const price = out.price;
    if (price && !price.stale && Number.isFinite(price.usdPerKoin) && price.usdPerKoin > 0) {
      out.usd = satsToUsd(balances.koin, price.usdPerKoin);
    }
    return out;
  });
  const walletHistory = new (require("./koinos/wallet-history").WalletHistory)({ chain, wallet });
  handle("wallet:history", input => walletHistory.read(input));

  // ----- chain -----
  handle("producer:balances", async () => {
    const address = producerAddress();
    return address ? { address, ...await chain.balances(address) } : { address: null };
  });
  handle("chain:balances", async () => {
    const address = wallet.address;
    if (!address) return { address: null };
    const b = await chain.balances(address);
    return {
      address,
      ...b,
      formatted: {
        koin: formatAmount(b.koin),
        vhp: formatAmount(b.vhp),
        mana: formatAmount(b.mana),
      },
    };
  });

  handle("chain:burn", async ({ amount }) => {
    custody.requireLocal();
    const amountSat = parseAmount(amount);
    const res = await chain.burn(wallet.signer, amountSat);
    onEvent({
      type: "burn",
      message: `Burned ${formatAmount(amountSat)} ${chain.network().tokenSymbol} → VHP`,
      txId: res.txId,
    });
    return { ...res, amountSat, amountFormatted: formatAmount(amountSat) };
  });

  handle("chain:send", async ({ to, amount, token, password, expectedAddress, expectedNetwork }) => {
    // Wallet sends spend only the local earning wallet, independently of
    // producer custody. External producer transfers use producer:prepare.
    const amountSat = parseAmount(amount);
    const address = wallet.address, network = chain.network().id, rpcIdentity = JSON.stringify(chain.rpcUrls?.() || []);
    const reviewed = expectedAddress !== undefined || expectedNetwork !== undefined;
    if (reviewed && (expectedAddress !== address || expectedNetwork !== network)) throw new Error("Wallet or network changed. Review this transfer again.");
    const assertContext = () => {
      if (wallet.address !== address || chain.network().id !== network || JSON.stringify(chain.rpcUrls?.() || []) !== rpcIdentity)
        throw new Error("Wallet or network changed. Review this transfer again.");
    };
    // Sending moves value to somebody else: the password is proved HERE,
    // on this call, because the wallet auto-unlocks at start-up and being
    // unlocked is not evidence a person is present.
    assertContext();
    const res = await chain.transfer(wallet.signerFor(password), { to, amountSat, token, ...(reviewed ? { assertContext } : {}) });
    onEvent({
      type: "send",
      message: `Sent ${formatAmount(amountSat)} ${String(token).toUpperCase()} to ${to}`,
      txId: res.txId,
    });
    return { ...res, amountSat };
  });

  handle("chain:sync", () => chain.syncStatus());

  handle("chain:maxBurn", async () => {
    custody.requireLocal();
    const address = wallet.address;
    if (!address) throw new Error("No wallet");
    const { koin, mana } = await chain.balances(address);
    const keep = parseAmount(settings.get("keepLiquidKoin", "10"));
    // Cap by liquid balance above the mana buffer AND by mana actually available
    // now — burning requires mana >= amount, so a balance-only Max can suggest an
    // amount that reverts with "could not burn KOIN".
    const byBalance = cmpSats(koin, keep) > 0 ? subSats(koin, keep) : "0";
    const byMana = chain.burnableFromMana(mana);
    const manaLimited = cmpSats(byMana, byBalance) < 0;
    const max = manaLimited ? byMana : byBalance;
    return {
      maxSat: max,
      maxFormatted: formatAmount(max, { grouping: false }),
      manaLimited,
      manaFormatted: formatAmount(mana),
    };
  });

  // ----- block producer registration -----
  handle("producer:status", () => custody.status());

  handle("producer:register", async () => {
    custody.requireLocal();
    const networkId = chain.network().id;
    const pub = nodeMgr.readProducerPublicKey(networkId);
    if (!pub) {
      throw new Error(
        "No signing key found yet. Start the node once — the block producer generates its key on first run."
      );
    }
    const res = await chain.registerProducerKey(wallet.signer, pub);
    onEvent({ type: "producer", message: "Block production key registered on chain", txId: res.txId });
    return res;
  });

  // ----- node -----
  handle("node:status", async () => {
    const networkId = chain.network().id;
    const status = await nodeMgr.status(networkId);
    let sync = null;
    if (status.isRunning) {
      sync = await chain.syncStatus().catch(() => null);
      if ((!sync || sync.local?.error) && !status.memorySaver && status.health?.ok !== false) {
        status.health = { ok: false, reason: "local-chain-unavailable" };
      }
    }
    // Only probe prerequisites while Docker isn't usable yet — this is what
    // drives the guided setup card.
    let setupStatus = null;
    if (!status.docker?.ok) {
      setupStatus = await setup.status().catch(() => null);
    }
    return { network: networkId, ...status, sync, setup: setupStatus };
  });

  // ----- guided setup (WSL + Docker) -----
  handle("setup:status", () => setup.status());
  handle("setup:installWsl", () => setup.installWsl());
  handle("setup:restart", () => setup.restart());
  handle("setup:cancelRestart", () => setup.cancelRestart());
  handle("setup:installDocker", () => setup.installDocker());
  handle("setup:cancelInstallDocker", () => setup.cancelInstallDocker());
  handle("setup:startDocker", () => setup.startDocker());
  handle("setup:markWslReady", () => setup.markWslReady());
  handle("setup:openDockerDocs", () => {
    // Core is headless: hand the URL back and the bridge's window opens it.
    // (The old body called Electron's shell here, which does not exist in
    // Core — a ReferenceError waiting on this button.)
    return { openUrl: setup.dockerDocsUrl() };
  });

  // ----- Electron-only utilities, re-homed -----
  // The standalone app served these from its main process. Core runs on the
  // same machine as the user, so the OS openers do the same job; the
  // clipboard (util:copy) stays in the page, where it belongs.
  const opener = () =>
    process.platform === "win32" ? ["cmd", ["/c", "start", '""']] :
    process.platform === "darwin" ? ["open", []] : ["xdg-open", []];
  handle("util:openExternal", ({ url } = {}) => {
    const u = String(url || "");
    if (!/^https?:\/\/\S+$/.test(u)) throw new Error("Only http(s) links can be opened");
    // Returned as well as spawned: in the browser build the bridge's own
    // window.open is the one that reliably lands in front of the user.
    const [cmd, args] = opener();
    try {
      const child = require("child_process").spawn(cmd, [...args, u], { detached: true, stdio: "ignore" });
      child.on("error", () => {}); // no opener on this box; the bridge still opens it
      child.unref();
    } catch { /* same */ }
    return { openUrl: u };
  });
  handle("util:openPath", ({ which } = {}) => {
    // A fixed menu, never a caller-supplied path — this route is reachable
    // from any same-origin page.
    const dir =
      which === "nodeData" ? nodeMgr.dirs(chain.network().id).root :
      which === "userData" ? userData : null;
    if (!dir) throw new Error(`Unknown folder: ${which}`);
    const [cmd, args] = opener();
    const child = require("child_process").spawn(cmd, [...args, dir], { detached: true, stdio: "ignore" });
    child.on("error", () => {}); // a headless box has no file manager; nothing to do
    child.unref();
    return { opened: dir };
  });

  handle("node:start", async ({ produce }) => {
    const networkId = chain.network().id;
    // One-time, best-effort: right-size the WSL VM so the node has enough memory
    // to begin with. Self-skips off Windows; writes .wslconfig only when it would
    // raise a too-low limit. Fully guarded — tuning must NEVER block starting the
    // node, whatever goes wrong here.
    try {
      if (!state.get("node.memoryTuned", false)) {
        await setup.optimizeWslMemory().catch(() => {});
        state.set("node.memoryTuned", true);
      }
    } catch {
      /* tuning is best-effort; starting the node always wins */
    }
    let producerAddress = null;
    if (produce) {
      producerAddress = custody.config().address;
      if (custody.config().mode === "external") {
        if (producerAddress === wallet.address) throw new Error("External producer key is present in the local earning wallet. Use a separate cold address.");
        const registration = await custody.status();
        if (!registration.matches) throw new Error(registration.verificationError || "Verify the hot public key registration on-chain before enabling external production.");
      }
      if (!producerAddress) throw new Error("Create a wallet first to enable block production");
    }
    // One click means the WHOLE chain (field report: this button answered
    // "install Docker first"). Docker missing → start its download and say
    // so; Docker stopped → start it and wait for the engine, then carry on
    // into the actual node start.
    let docker = await nodeMgr.dockerInfo();
    if (!docker.ok) {
      if (process.platform === "linux") throw new Error(docker.error);
      const r = await setup.startDocker(); // installs Docker Desktop itself when missing
      if (r?.installing) {
        throw new Error(
          "Docker Desktop isn't installed yet — downloading it for you now (progress shows on this page). Follow its installer, then press Start node again."
        );
      }
      const deadline = Date.now() + 60000;
      while (!docker.ok && Date.now() < deadline) {
        await new Promise((res) => setTimeout(res, 3000));
        docker = await nodeMgr.dockerInfo();
      }
      if (!docker.ok) {
        throw new Error(
          "Docker is starting — first launch can take a couple of minutes. Press Start node again once its whale icon settles."
        );
      }
    }
    return nodeMgr.start(networkId, producerAddress);
  });

  handle("node:profileMigrationPreview", () => nodeMgr.profileMigration().preview(chain.network().id));
  handle("node:profileMigrationStatus", () => nodeMgr.profileMigration().status(chain.network().id));
  handle("node:profileMigrationStart", ({ previewId } = {}) => nodeMgr.profileMigration().start(chain.network().id, previewId));
  handle("node:profileMigrationCancel", () => nodeMgr.profileMigration().cancel());
  handle("node:stop", () => nodeMgr.stop(chain.network().id));
  handle("node:repairServices", () => nodeMgr.repair(chain.network().id));
  handle("node:setAutoRecover", ({ on }) => {
    settings.set("node.autoRecover", !!on);
    nodeMgr.setAutoRecover(!!on);
    return { autoRecover: !!on };
  });
  handle("node:logs", ({ service, tail }) => nodeMgr.logs(chain.network().id, service, tail));
  /* ----- where the chain data lives -----
   *
   * Two moments matter. Before the download, choosing is free — nothing has
   * been written yet, so it is only a setting. After it, choosing means
   * moving tens of gigabytes, which is a real operation with a real chance of
   * going wrong; node:moveDataDir is the one that does it properly.
   */
  handle("node:dataDir", async () => {
    const current = path.resolve(nodeMgr.dataRoot);
    const size = await dataMove.measure(current);
    return {
      path: current,
      defaultPath: defaultNodeData ? path.resolve(defaultNodeData) : null,
      isDefault: defaultNodeData ? path.resolve(defaultNodeData) === current : true,
      sizeBytes: size.bytes,
      fileCount: size.files,
      freeBytes: await dataMove.freeBytes(current),
      // Empty means nothing has been downloaded yet, so a change is free.
      hasData: size.files > 0,
      move: nodeMgr.moveStatus(),
    };
  });

  handle("node:inspectDataDir", async ({ path: target }) => {
    if (!target) throw new Error("Pick a folder first");
    return nodeMgr.inspectMove(String(target));
  });

  /** Point at a new folder WITHOUT moving anything. Only legal while there is
   *  nothing to move — otherwise it would silently orphan a synced chain. */
  handle("node:setDataDir", async ({ path: target }) => {
    if (!target) throw new Error("Pick a folder first");
    const next = path.resolve(String(target));
    const current = path.resolve(nodeMgr.dataRoot);
    if (next === current) return { path: current, changed: false };
    if ((await dataMove.measure(current)).files > 0) {
      throw new Error("There is already chain data here — use Move instead, so it comes with you.");
    }
    const check = await dataMove.checkTarget(current, next);
    if (!check.ok) throw new Error(check.reason);
    fs.mkdirSync(next, { recursive: true });
    settings.set("node.dataDir", next);
    nodeMgr.dataRoot = next;
    return { path: next, changed: true };
  });

  /** Move existing chain data to a new folder and repoint the node at it. */
  handle("node:moveDataDir", async ({ path: target }) => {
    if (!target) throw new Error("Pick a folder first");
    return nodeMgr.moveData(chain.network().id, String(target), {
      // Persisted at the moment the new copy becomes the real one — before
      // the old one is deleted, so a crash here costs disk, never data.
      onSwitched: (dir) => { settings.set("node.dataDir", dir); },
    });
  });

  handle("node:moveDataDirStatus", () => nodeMgr.moveStatus());
  handle("node:moveDataDirCancel", () => nodeMgr.cancelMove());

  handle("node:backups", () => nodeMgr.backups(chain.network().id));
  handle("node:deleteBackup", ({ id }) => nodeMgr.removeBackup(chain.network().id, id));
  handle("node:quickSyncInfo", () => nodeMgr.quickSyncInfo(chain.network().id));
  handle("node:quickSync", () => nodeMgr.quickSync(chain.network().id));
  handle("node:quickSyncCancel", () => nodeMgr.cancelQuickSync());

  handle("network:producers", () => masterApi?.config().enabled && chain.network().id === "mainnet"
    ? masterApi.producerSummary()
    : injectedProducerCache
    ? injectedProducerCache.get(chain.network().id)
    : { network: chain.network().id, available: false, error: "Producer reader unavailable" });

  // ----- dashboard -----
  let lastGoodBalances = null; // { values, at, address }

  handle("dashboard:summary", async () => {
    const net = chain.network();
    const address = producerAddress();
    const ws = wallet.status();
    const out = {
      network: { id: net.id, label: net.label, tokenSymbol: net.tokenSymbol, explorer: net.explorer },
      wallet: { exists: !!address, unlocked: custody.config().mode === "local" && ws.unlocked, address },
      custody: custody.config(),
      node: null,
      balances: null,
      stats: null,
      rewards: rewards.status().config,
    };
    // Node running state (docker + services).
    try {
      const ns = await nodeMgr.status(net.id);
      out.node = {
        docker: ns.docker,
        isRunning: ns.isRunning,
        runningCount: ns.runningCount,
        health: ns.health,
        peers: ns.peers,
        op: ns.op,
        producerRegistered: null,
      };
      if (ns.isRunning) {
        out.sync = await chain.syncStatus().catch(() => null);
        if ((!out.sync || out.sync.local?.error) && !ns.memorySaver && out.node.health?.ok !== false) {
          out.node.health = { ok: false, reason: "local-chain-unavailable" };
        }
      }
    } catch (e) {
      out.node = { error: String(e.message) };
    }
    if (!address) return out;
    // Balances + producer stats (both hit the RPC).
    let [balances, statsRes] = await Promise.all([
      chain.balances(address).catch((e) => ({ error: String(e.message) })),
      stats.refresh(address).catch((e) => ({ available: false, error: String(e.message) })),
    ]);
    ({ balances, lastGood: lastGoodBalances } = holdBalances(balances, lastGoodBalances, address, Date.now()));
    out.balances = balances;
    out.stats = statsRes;

    // Projected returns: annualize the recent daily profit rate against the
    // producing stake (VHP), plus a compounded figure at the user's reburn rate.
    const rcfg = out.rewards || {};
    const reburnFraction = rcfg.enabled && rcfg.mode === "burn" ? Number(rcfg.pct || 0) / 100 : 0;
    const windows = statsRes && statsRes.windows ? statsRes.windows : null;
    const stakeSats = balances && !balances.error ? balances.vhp : "0";
    out.returns = windows
      ? projectReturns({ avgDailyProfitSats: windows.avgDailyProfit, stakeSats, reburnFraction })
      : null;

    /*
     * What all of that is worth in dollars, priced off the Uniswap v4
     * vKOIN/USDT pool (vKOIN is KOIN bridged 1:1, and that pool is the only
     * meaningful liquidity).
     *
     * `snapshot` deliberately does NOT await the quote. This handler is polled
     * every few seconds and paints the whole dashboard; putting an Ethereum
     * round trip in front of balances, sync state and the activity feed would
     * make the whole screen wait on a number that is merely nice to have. The
     * first poll after launch carries no price and the next one does.
     */
    out.price = priceCache.snapshot();
    out.value = valuation({ balances, windows, usdPerKoin: out.price.usdPerKoin });

    // Screenshot/demo-only override (never set in production): present a
    // running, synced node with representative balances so marketing shots
    // show a live dashboard.
    if (process.env.KND_DEMO) {
      out.node = { docker: { ok: true }, isRunning: true, runningCount: 7, op: null };
      out.sync = {
        inSync: true,
        local: { height: 38297044, headBlockTimeMs: Date.now(), error: null },
        remote: { height: 38297044 },
        progressPct: 100,
      };
      out.balances = { koin: "4308560000", vhp: "228813610000", mana: "3822790000" };
      const demoWindows = { last24h: "31200000", last7d: "216500000", last30d: "934800000", avgDailyProfit: "31160000", daysTracked: 30 };
      out.stats = { available: true, network: net.id, totals: out.stats?.totals ?? null, feed: out.stats?.feed ?? [], windows: demoWindows, syncing: false };
      out.returns = projectReturns({ avgDailyProfitSats: demoWindows.avgDailyProfit, stakeSats: out.balances.vhp, reburnFraction: 0.5 });
      // A representative price, so a demo shot shows the value box populated
      // rather than a row of dashes. Never reached in production.
      out.price = { usdPerKoin: 0.0512, at: Date.now(), ageMs: 0, stale: false, error: null, probeUsdt: 100 };
      out.value = valuation({ balances: out.balances, windows: demoWindows, usdPerKoin: out.price.usdPerKoin });
    }
    return out;
  });

  // ----- rewards -----
  handle("rewards:status", () => rewards.status());
  /*
   * Arming automatic returns to another address is the largest value-moving
   * decision in this file, and the rule at the top of it already covered this
   * case — it just was not being applied. A one-off ETH send proves the
   * password; a standing instruction to send EVERY future block reward
   * somewhere else did not, even though it moves value repeatedly, on its own,
   * to an address the person may not control. The wallet is nearly always
   * unlocked, so nothing else stood between a caller and that redirect.
   *
   * The password is proven when the destination is armed or changed. The rest
   * of the returns settings — percentage, minimum, cap, poll interval, pausing,
   * and compounding back into your own VHP — are untouched, because none of
   * them can move a satoshi anywhere the wallet does not already own.
   */
  handle("rewards:configure", (patch) => {
    if (patch?.enabled) custody.requireLocal();
    // NEVER let the password reach rewards.configure: that object is persisted.
    const { password, ...settingsPatch } = patch || {};
    const before = rewards.config();
    const after = { ...before, ...settingsPatch };

    const sendingNow = after.mode === "send" && !!after.enabled;
    const sendingBefore = before.mode === "send" && !!before.enabled;
    const destChanged = String(after.toAddress || "") !== String(before.toAddress || "");

    if ((sendingNow && !sendingBefore) || destChanged) {
      if (!password) {
        throw new Error(
          "Enter your wallet password to change where returns go. This is the one return setting that can move " +
          "KOIN to an address you may not control, so it asks even though the wallet is unlocked.",
        );
      }
      requirePassword(password);
    }
    if (distribution?._busy) throw new Error("Wait for the current distribution operation.");
    const result = rewards.configure(settingsPatch);
    if (result.enabled) distribution?.configure({ enabled: false });
    return result;
  });
  handle("rewards:runNow", () => { custody.requireLocal(); return rewards.tick("manual"); });

  if (distribution) {
    handle("distribution:status", () => distribution.status());
    handle("distribution:configure", (input = {}) => {
      if (distribution._busy || rewards._busy) throw new Error("Wait for the current reward/distribution operation.");
      const { password, ...patch } = input;
      const disableOnly = patch.enabled === false && Object.keys(patch).length === 1;
      if (!disableOnly) { custody.requireLocal(); if (!password) throw new Error("Enter your wallet password to authorize distribution settings."); requirePassword(password); }
      const config = distribution.configure(patch);
      if (config.enabled) {
        rewards.configure({ enabled: false });
        settings.set("distributionAuthorization", { address: wallet.address, network: chain.network().id, rpc: JSON.stringify(chain.rpcUrls()), configuration: JSON.stringify(config) });
      }
      return config;
    });
    handle("distribution:runNow", () => { custody.requireLocal(); return distribution.tick("manual"); });
    handle("distribution:distributeNow", () => { custody.requireLocal(); return distribution.tick("manual", { forceClose: true }); });
    handle("distribution:resetStats", (input = {}) => {
      custody.requireLocal();
      if (rewards._busy) throw new Error("Wait for the current reward/distribution operation.");
      if (input.confirmed !== true) throw new Error("Confirm Reset Stats to clear distribution accounting and pending amounts.");
      const result = distribution.resetStats();
      settings.set("distributionAuthorization", null);
      return result;
    });
  }
  if (masterApi) {
    let historyCheck = null;
    handle("masterApi:checkHistory", () => {
      // Multiple clicks share one bounded local check. No public route exists.
      if (!historyCheck) historyCheck = checkHistory({ nodeMgr }).finally(() => { historyCheck = null; });
      return historyCheck;
    });
    handle("masterApi:status", () => masterApi.status());
    handle("masterApi:configure", async input => {
      const result = await masterApi.configure(input);
      // Save the next-start profile. No Docker command or running-node restart.
      nodeMgr.apiServices = result.config.extendedIndexes;
      return result;
    });
  }

  // ----- fund node (Ethereum on-ramp — Phase 1) -----
  // Shared, app-hosted Coinbase Onramp endpoint. Every install uses this by
  // default so the Buy button works with zero setup; advanced users can override
  // it with their own endpoint in the Fund tab. (DEFAULT_ONRAMP_ENDPOINT and
  // ONRAMP_APP_KEY are defined at module scope.)
  const effectiveOnrampEndpoint = () => settings.get("onrampEndpoint", "") || DEFAULT_ONRAMP_ENDPOINT;

  handle("fund:status", () => ({
    ethAddress: wallet.ethAddress,
    onrampEndpoint: settings.get("onrampEndpoint", ""), // user override; blank = built-in default
    onrampDefault: DEFAULT_ONRAMP_ENDPOINT,
    onrampConfigured: !!effectiveOnrampEndpoint(),
  }));

  // Asks the user's own Coinbase Onramp endpoint (a small serverless function
  // holding their CDP secret) to mint a session token for the wallet's ETH
  // address, then builds the hosted Coinbase Pay URL. Post-2025 Onramp requires
  // this server-minted session token — the secret never lives in the app.
  handle("fund:buyUrl", async ({ amountUsd } = {}) => {
    const address = wallet.ethAddress;
    if (!address) throw new Error("Create or unlock your wallet first to get a funding address.");
    const endpoint = effectiveOnrampEndpoint();
    if (!endpoint) throw new Error("No Coinbase Onramp endpoint is configured.");
    let token;
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 15000);
      const resp = await fetch(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json", "x-koinoskit-app": ONRAMP_APP_KEY },
        body: JSON.stringify({ address, asset: "ETH", network: "ethereum" }),
        signal: controller.signal,
      }).finally(() => clearTimeout(timer));
      if (!resp.ok) throw new Error(`endpoint returned HTTP ${resp.status}`);
      const data = await resp.json();
      token = data.token || data.sessionToken;
    } catch (e) {
      throw new Error(`Couldn't reach your Onramp endpoint: ${String(e.message || e)}`);
    }
    if (!token) throw new Error("Your Onramp endpoint didn't return a session token.");
    const u = new URL("https://pay.coinbase.com/buy/select-asset");
    u.searchParams.set("sessionToken", token);
    u.searchParams.set("defaultAsset", "ETH");
    u.searchParams.set("defaultNetwork", "ethereum");
    u.searchParams.set("fiatCurrency", "USD");
    if (amountUsd && Number(amountUsd) > 0) u.searchParams.set("presetFiatAmount", String(Number(amountUsd)));
    return { url: u.toString() };
  });

  // Read-only ETH balance of the wallet's funding address, via public RPCs
  // (tried in order). Lets the user confirm funds arrived before bridging.
  const ETH_RPCS = [
    "https://ethereum-rpc.publicnode.com",
    "https://eth.llamarpc.com",
    "https://cloudflare-eth.com",
    "https://rpc.ankr.com/eth",
  ];
  handle("fund:ethBalance", async () => {
    const address = wallet.ethAddress;
    if (!address) throw new Error("Create or unlock your wallet first.");
    let lastErr;
    for (const rpc of ETH_RPCS) {
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 10000);
        const resp = await fetch(rpc, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_getBalance", params: [address, "latest"] }),
          signal: controller.signal,
        }).finally(() => clearTimeout(timer));
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const data = await resp.json();
        if (data.error) throw new Error(data.error.message || "RPC error");
        return { address, wei: data.result, eth: weiToEth(data.result) };
      } catch (e) {
        lastErr = e;
      }
    }
    throw new Error(`Couldn't fetch ETH balance: ${String(lastErr?.message || lastErr)}`);
  });

  // ----- fund node bridge (Phase 2: ETH -> vETH -> KOIN) -----
  handle("fund:bridgeStatus", () => bridge.status());
  handle("fund:bridgeReset", () => bridge.reset());
  handle("fund:bridgeAdvance", () => bridge.advance());
  handle("fund:bridgeStart", ({ amountEth, slippageBps, password } = {}) => {
    // Starting a bridge authorises the WHOLE flow: the advancer then signs its
    // remaining steps unattended. So the password is proved at the intent,
    // once, rather than per signature.
    requirePassword(password);
    return bridge.start({ amountEth, slippageBps });
  });

  // Route C (ETH → USDT → vKOIN → bridge → native KOIN). start() sets up + quotes;
  // advance() is called once here to send the first tx, then the 8s driver takes over.
  handle("fund:routeCStatus", () => routeC.status());
  handle("fund:routeCReset", () => routeC.reset());
  handle("fund:routeCAdvance", () => routeC.advance());
  handle("fund:routeCResume", () => routeC.resume());
  handle("fund:routeCStart", async ({ amountEth, amountUsdt, amountVkoin, source, slippageBps, password } = {}) => {
    requirePassword(password); // same intent-level authorisation as the bridge
    const job = await routeC.start({ amountEth, amountUsdt, amountVkoin, source, slippageBps });
    await routeC.advance(); // keep the approved wallet operation until the first step finishes
    return job;
  });
  handle("fund:bridgeMax", async () => {
    const address = wallet.ethAddress;
    if (!address) throw new Error("Create or unlock your wallet first.");
    return maxBridgeable({
      fromAddress: address,
      koinosRecipient: wallet.address,
      network: settings.get("network", "mainnet"),
      capEth: MAX_BRIDGE_ETH,
    });
  });
  handle("fund:bridgeQuote", async ({ amountEth, slippageBps } = {}) => {
    const address = wallet.ethAddress;
    if (!address) throw new Error("Create or unlock your wallet first.");
    const network = settings.get("network", "mainnet");
    const deposit = await quoteDeposit({ fromAddress: address, amountEth, koinosRecipient: wallet.address, network });
    let swap = null;
    try {
      swap = await quoteSwap({ amountInSats: deposit.vethSats, slippageBps: slippageBps || 150, network, provider: chain.provider() });
    } catch (e) {
      swap = { error: String(e.message || e) };
    }
    return { deposit, swap, maxEth: MAX_BRIDGE_ETH };
  });

  // Compare both funding routes for a given ETH amount and rank by KOIN out, so
  // the UI can show the best plus the runners-up. Read-only (quotes only).
  //   Route B: ETH → vETH (Vortex) → KOIN (KoinDX)
  //   Route C: ETH → USDT → vKOIN (Uniswap v4) → KOIN (Vortex, 1:1)
  // Route C is quote-only in this build (execution ships next); `executable`
  // tells the UI which route the Bridge button can actually run today.
  handle("fund:routeCompare", async ({ amountEth, slippageBps = 150 } = {}) => {
    const address = wallet.ethAddress;
    if (!address) throw new Error("Create or unlock your wallet first.");
    const network = settings.get("network", "mainnet");

    let routeB;
    try {
      const deposit = await quoteDeposit({ fromAddress: address, amountEth, koinosRecipient: wallet.address, network });
      const swap = await quoteSwap({ amountInSats: deposit.vethSats, slippageBps, network, provider: chain.provider() });
      routeB = { ...descriptor("B"), executable: true, koinOut: swap.amountOut, koinOutMin: swap.amountOutMin, gasCostEth: deposit.gasCostEth };
    } catch (e) {
      routeB = { ...descriptor("B"), executable: true, koinOut: null, error: String(e.message || e) };
    }

    let routeC;
    try {
      const q = await quoteEthToVkoin({ amountEth, slippageBps });
      routeC = { ...descriptor("C"), executable: true, koinOut: q.koinOut, koinOutMin: q.koinOutMin, usdtOut: q.usdtOut };
    } catch (e) {
      routeC = { ...descriptor("C"), executable: true, koinOut: null, error: String(e.message || e) };
    }

    return { ...compareRoutes([routeB, routeC]), amountEth: String(amountEth), slippageBps };
  });

  // ----- withdraw ETH out (so ETH parked for bridging isn't trapped) -----
  handle("fund:ethSendQuote", async ({ toAddress, amountEth } = {}) => {
    const address = wallet.ethAddress;
    if (!address) throw new Error("Create or unlock your wallet first.");
    return quoteSend({ fromAddress: address, toAddress, amountEth });
  });
  handle("fund:ethSendMax", async ({ toAddress } = {}) => {
    const address = wallet.ethAddress;
    if (!address) throw new Error("Create or unlock your wallet first.");
    return maxSendable({ fromAddress: address, toAddress });
  });
  // REAL ETH MOVES HERE. ethPrivateKey() throws if the wallet is locked, so the
  // send is gated on an unlocked wallet.
  handle("fund:ethSend", async ({ toAddress, amountEth, password } = {}) => {
    if (!wallet.ethAddress) throw new Error("Create or unlock your wallet first.");
    requirePassword(password); // ETH leaving for another address
    const res = await sendEth({ ethPrivHex: wallet.ethPrivateKey(), toAddress, amountEth });
    return res;
  });

  // ----- ETH + USDT balances (one round-trip) for the Wallet tab -----
  handle("fund:cryptoBalances", async () => {
    const address = wallet.ethAddress;
    if (!address) throw new Error("Create or unlock your wallet first.");
    const provider = await makeProvider();
    const [ethWei, usdt, vkoin] = await Promise.all([
      provider.getBalance(address),
      usdtBalance({ address, provider }),
      vkoinBalance({ address, provider }),
    ]);
    return {
      address,
      ethWei: ethWei.toString(),
      eth: weiToEth("0x" + ethWei.toString(16)),
      usdtSats: usdt.sats,
      usdt: usdt.usdt,
      vkoinSats: vkoin.sats,
      vkoin: vkoin.vkoin,
    };
  });

  // ----- withdraw / send USDT out -----
  handle("fund:usdtSendQuote", async ({ toAddress, amountUsdt } = {}) => {
    const address = wallet.ethAddress;
    if (!address) throw new Error("Create or unlock your wallet first.");
    return quoteUsdtSend({ fromAddress: address, toAddress, amountUsdt });
  });
  handle("fund:usdtSendMax", async () => {
    const address = wallet.ethAddress;
    if (!address) throw new Error("Create or unlock your wallet first.");
    return maxUsdtSendable({ fromAddress: address });
  });
  // REAL USDT MOVES HERE. Gated on an unlocked wallet (ethPrivateKey throws locked).
  handle("fund:usdtSend", async ({ toAddress, amountUsdt, password } = {}) => {
    if (!wallet.ethAddress) throw new Error("Create or unlock your wallet first.");
    requirePassword(password);
    return sendUsdt({ ethPrivHex: wallet.ethPrivateKey(), toAddress, amountUsdt });
  });

  // ----- quote KOIN out for funding the node directly from USDT (Route C) -----
  handle("fund:usdtFundQuote", async ({ amountUsdt, slippageBps = 150 } = {}) => {
    const address = wallet.ethAddress;
    if (!address) throw new Error("Create or unlock your wallet first.");
    // Validate the amount BEFORE reaching for the network. It was the other
    // way round, which meant typing a bad number bought an Ethereum round trip
    // before being told, and meant this line only ran once a provider existed
    // — so the broken require below it needed a working connection to reveal
    // itself. Cheap checks first.
    const usdtSats = parseUsdt(amountUsdt);
    if (usdtSats <= 0n) throw new Error("Amount must be greater than 0");
    const provider = await makeProvider();
    const koin = await quoteVkoinOut({ usdtSats, provider });
    return { amountUsdt: String(amountUsdt), koinOut: koin.toString(), koinOutMin: applySlippage(koin, slippageBps).toString(), slippageBps };
  });

  // ----- send vKOIN out / bridge-to-KOIN recovery -----
  handle("fund:vkoinSendQuote", async ({ toAddress, amountVkoin } = {}) => {
    const address = wallet.ethAddress;
    if (!address) throw new Error("Create or unlock your wallet first.");
    return quoteVkoinSend({ fromAddress: address, toAddress, amountVkoin });
  });
  handle("fund:vkoinSendMax", async () => {
    const address = wallet.ethAddress;
    if (!address) throw new Error("Create or unlock your wallet first.");
    return maxVkoinSendable({ fromAddress: address });
  });
  handle("fund:vkoinSend", async ({ toAddress, amountVkoin, password } = {}) => {
    if (!wallet.ethAddress) throw new Error("Create or unlock your wallet first.");
    requirePassword(password);
    return sendVkoin({ ethPrivHex: wallet.ethPrivateKey(), toAddress, amountVkoin });
  });

  // ----- gas-aware Max for ETH funding: balance minus a Route-C gas reserve -----
  // Route C sends up to ~6 txs (swaps + approvals + bridge); reserve enough ETH so
  // the run can't stall out of gas mid-flow, and flag if the balance can't cover it.
  handle("fund:routeMaxEth", async () => {
    const address = wallet.ethAddress;
    if (!address) throw new Error("Create or unlock your wallet first.");
    const provider = await makeProvider();
    const balance = await provider.getBalance(address);
    const fee = await provider.getFeeData();
    const perGas = fee.maxFeePerGas ?? fee.gasPrice ?? 0n;
    const ROUTE_C_GAS = 750000n; // ETH→USDT + 2 approvals + USDT→vKOIN + approve + bridge
    const gasReserve = (perGas * ROUTE_C_GAS * 13n) / 10n; // +30% headroom
    let maxWei = balance > gasReserve ? balance - gasReserve : 0n;
    const capWei = 50000000000000000n; // 0.05 ETH
    if (maxWei > capWei) maxWei = capWei;
    return {
      maxWei: maxWei.toString(),
      maxEth: weiToEth("0x" + maxWei.toString(16)),
      gasReserveEth: weiToEth("0x" + gasReserve.toString(16)),
      balanceEth: weiToEth("0x" + balance.toString(16)),
      enoughForGas: balance > gasReserve,
    };
  });

  // ----- utilities -----



  // Serialize custody/network/node mutations so asynchronous RPC checks cannot
  // authorize a start, rotation or draft against a different producer context.
  let producerMutation = false;
  for (const name of ["distribution:configure", "distribution:runNow", "distribution:distributeNow", "distribution:resetStats", "masterApi:configure", "producer:vaultConnect", "producer:vaultUse", "producer:vaultPrepare", "producer:vaultSend", "producer:vaultDisconnect", "producer:vaultStatus", "producer:configure", "producer:key", "producer:prepare", "producer:broadcast", "producer:register", "settings:update", "node:start", "node:stop", "node:repairServices", "chain:burn", "chain:send", "rewards:runNow", "rewards:configure"]) {
    const fn = channels.get(name);
    if (!fn) continue;
    channels.set(name, async input => {
      if (producerMutation) throw new Error("Wait for the current producer operation to finish.");
      producerMutation = true;
      try {
        if (!name.startsWith("producer:vault") && !["node:stop", "node:repairServices"].includes(name)) vault.guardMutation();
        return await fn(input); } finally { producerMutation = false; }
    });
  }
  // Native review data is not a renderer channel. Keep approvals bound to the
  // original stored draft/configuration and show its human-readable summary.
  channels.review = channel => {
    if (channel === "producer:vaultSend") {
      if (!vault.draft) throw Error("Prepare a fresh Koin Vault transaction.");
      return { draftId: vault.draft.id, summary: structuredClone(vault.draft.summary), fingerprint: require("node:crypto").createHash("sha256").update(JSON.stringify(vault.draft)).digest("hex") };
    }
    if (channel === "producer:broadcast") {
      const draft = custody.savedDraft();
      return { transactionId: draft.transaction.id, summary: draft.summary, fingerprint: require("node:crypto").createHash("sha256").update(JSON.stringify(draft)).digest("hex") };
    }
    if (channel === "rewards:runNow") return { configuration: structuredClone(rewards.config()) };
    if (["distribution:runNow", "distribution:distributeNow", "distribution:resetStats"].includes(channel) && distribution) return { configuration: structuredClone(distribution.config()), accounting: structuredClone(distribution.status()) };
    return null;
  };
  return channels;
}



/**
 * Construct the whole node stack against the Node plugin's own wallet and data directory,
 * and return { channels, stop } where channels is the full name -> handler map.
 * Nothing here starts a node or touches the network on its own; the advancer
 * timers only do work once the user has started a flow.
 */
function createKoinosNode({ dataDir, wallet, appVersion, onEvent = () => {}, storeFactory = (file, defaults) => new JsonStore(file, defaults), configureServices = () => {}, networkAllowed = () => true, runBackground = (_name, run) => run() }) {
  const root = path.join(dataDir, "koinos-node");
  fs.mkdirSync(root, { recursive: true });

  const settings = storeFactory(path.join(root, "settings.json"), DEFAULT_SETTINGS);
  const state = storeFactory(path.join(root, "state.json"), {});
  const chain = new ChainService(settings);

  /*
   * Where the chain data lives. The default sits beside the app's own data,
   * which is the right answer for most people and the wrong one for anyone
   * whose system drive is small — so it is a default, not a decision: the
   * setup flow offers it pre-filled and editable, and it can be moved later.
   */
  const defaultNodeData = path.join(root, "node");
  const chosenNodeData = settings.get("node.dataDir", null);

  const nodeMgr = new NodeManager({
    templateRoot: path.join(__dirname, "..", "koinos-node-template"),
    dataRoot: chosenNodeData || defaultNodeData,
    intentPath: path.join(root, "node-supervisor.json"),
    onEvent,
    autoRecover: settings.get("node.autoRecover", true),
    accountHistory: settings.get("node.accountHistory", false),
    apiServices: settings.get("masterApi.extendedIndexes", false),
    probeHead: async (networkId) => {
      const s = await chain.headInfo([NETWORKS[networkId].localRpcUrl]).catch(() => null);
      const h = s?.height;
      return Number.isSafeInteger(h) && h > 0 ? h : null;
    },
  });

  const setup = new SetupService({
    platform: process.platform,
    arch: process.arch,
    downloadDir: path.join(root, "downloads"),
    state,
    onEvent,
  });

  nodeMgr.startDocker = () => setup.startDocker({ installIfMissing: false });

  const stats = new ProducerStats({ chain, state });
  const rewards = new RewardEngine({ chain, wallet, settings, state, stats, onEvent });
  const distribution = new DistributionEngine({ chain, wallet, settings, state, stats, onEvent,
    authorize: () => {
      const grant = settings.get("distributionAuthorization", {}) || {};
      if (!settings.health().ok || settings.get("producer.mode", "local") !== "local") throw new Error("Local producer custody is required.");
      if (grant.address !== wallet.address || grant.network !== chain.network().id || grant.rpc !== JSON.stringify(chain.rpcUrls()) || grant.configuration !== JSON.stringify(distribution.config())) throw new Error("Save distribution settings with the wallet password for this wallet/network and configuration.");
      if (rewards.config().enabled || rewards._busy) throw new Error("Reward returns must be disabled.");
    },
  });
  const masterApi = new MasterNodeApi({ root, settings, storeFactory });

  const bridge = new BridgeOrchestrator({
    wallet,
    provider: chain.provider(),
    store: storeFactory(path.join(root, "fund-bridge.json"), { job: null }),
    settings,
    appKey: ONRAMP_APP_KEY,
    network: settings.get("network", "mainnet"),
    onEvent,
  });
  const routeC = new RouteCOrchestrator({
    wallet,
    provider: chain.provider(),
    store: storeFactory(path.join(root, "fund-routec.json"), { routeCJob: null }),
    settings,
    appKey: ONRAMP_APP_KEY,
    network: settings.get("network", "mainnet"),
    onEvent,
  });

  // Core plugins inject guarded stores and lifecycle/spend coordination while
  // preserving the same channel handlers used by the original application.
  configureServices({ settings, state, chain, nodeMgr, setup, rewards, distribution, masterApi, bridge, routeC });
  nodeMgr.supervise(() => {
    if (!networkAllowed()) throw new Error("Node supervision is paused in Local-Only mode");
    return chain.network().id;
  });
  rewards.start();
  distribution.start();
  masterApi.start().catch(e => onEvent({ type: "masterApi", level: "error", message: e.message }));
  const apiRetryTimer = setInterval(() => masterApi.maintain().catch(() => {}), 30000);
  apiRetryTimer.unref?.();

  // Advancers. A bridge or swap the user STARTED (and proved the password for)
  // finishes on its own; these only ever act on a job already in flight.
  const bridgeTimer = setInterval(() => {
    const job = bridge.status();
    if (networkAllowed() && job && !["done", "error", "depositing"].includes(job.status)) Promise.resolve().then(() => runBackground("bridge", () => bridge.advance())).catch(() => {});
  }, 15000);
  const routeCTimer = setInterval(() => {
    const job = routeC.status();
    if (networkAllowed() && job && !["done", "error"].includes(job.status) && wallet.status().unlocked) {
      Promise.resolve().then(() => runBackground("routeC", () => routeC.advance())).catch(() => {});
    }
  }, 8000);
  bridgeTimer.unref?.();
  routeCTimer.unref?.();

  const priceCache = createPriceCache();
  const producerCache = createProducerCache();
  const channels = buildChannels({
    settings, state, wallet, chain, nodeMgr, setup, rewards, distribution, masterApi, stats, bridge, routeC,
    userData: root, appVersion, defaultNodeData, priceCache, producerCache, onEvent,
  });

  return {
    channels,
    review: channel => channels.review(channel),
    settings,
    nodeMgr,
    /** The KOIN price as of now, without waiting on Ethereum. Shared with the
     *  dashboard channel so both surfaces quote the same number. */
    priceSnapshot: () => priceCache.snapshot(),
    async call(channel, payload) {
      const fn = channels.get(String(channel));
      if (!fn) throw new Error(`Unknown Koinos channel: ${channel}`);
      return fn(payload ?? {});
    },
    list() {
      return [...channels.keys()].sort();
    },
    async stop() {
      nodeMgr.dispose();
      clearInterval(apiRetryTimer);
      distribution.stop();
      producerCache.stop();
      priceCache.stop();
      clearInterval(bridgeTimer);
      clearInterval(routeCTimer);
      try { rewards.stop(); } catch { /* already stopped */ }
      try { setup.stopWatchers(); } catch { /* none armed */ }
      await masterApi.dispose();
    },
  };
}

/*
 * The dashboard must never lie downward (field bug, 2026-08-27): the
 * public RPC has flaky minutes, and a failed balance read used to paint
 * 0 mana / $0.00 until the next poll succeeded. Real numbers do not
 * teleport to zero — so a failed read serves the last good values for the
 * SAME address, marked `stale: true` and carrying NO `error` field (the
 * valuation and returns guards key on `error` and must keep computing).
 * Past the hold window the honest error shows again: a wall of stale
 * numbers would be the opposite lie.
 */
const BALANCE_HOLD_MS = 10 * 60_000;

function holdBalances(fresh, lastGood, address, now) {
  if (!fresh.error) return { balances: fresh, lastGood: { values: fresh, at: now, address } };
  if (lastGood && lastGood.address === address && now - lastGood.at < BALANCE_HOLD_MS) {
    return { balances: { ...lastGood.values, stale: true }, lastGood };
  }
  return { balances: fresh, lastGood };
}

module.exports = { createKoinosNode, buildChannels, holdBalances, ONRAMP_APP_KEY };
