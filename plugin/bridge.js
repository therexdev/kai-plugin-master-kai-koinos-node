/* Sandboxed UI bridge to this plugin's native Node service. The Node wallet
 * and funding engine belong to this plugin; they never read Core's wallet.
 * Password checks and native reviews remain required for value leaving. */
(function () {
  "use strict";

  // ---- password gate: value leaving the wallet proves the password HERE ----
  var OUTBOUND = {
    "chain:send": "Send KOIN",
    "fund:bridgeStart": "Bridge ETH to KOIN",
    "fund:routeCStart": "Fund with a swap",
    "fund:ethSend": "Send ETH",
    "fund:usdtSend": "Send USDT",
    "fund:vkoinSend": "Send vKOIN",
  };

  /** Ask for the wallet password with the app's own modal classes. Resolves
   *  the typed string, or null on cancel. Never stores what was typed. */
  function askPassword(title) {
    return new Promise(function (resolve) {
      var root = document.getElementById("modal-root");
      if (!root) return resolve(null);
      var backdrop = document.createElement("div");
      backdrop.className = "modal-backdrop";
      var modal = document.createElement("div");
      modal.className = "modal";
      modal.setAttribute("role", "dialog");
      modal.setAttribute("aria-modal", "true");
      modal.setAttribute("aria-label", title);
      var h = document.createElement("h2");
      h.textContent = title;
      var body = document.createElement("div");
      body.className = "modal-body";
      var p = document.createElement("p");
      p.className = "small muted";
      p.textContent = "Your wallet password is required whenever funds leave your wallet.";
      var input = document.createElement("input");
      input.type = "password";
      input.placeholder = "Wallet password";
      input.autocomplete = "current-password";
      input.style.width = "100%";
      input.style.marginTop = "10px";
      body.appendChild(p);
      body.appendChild(input);
      var actions = document.createElement("div");
      actions.className = "actions";
      var done = function (v) { input.value = ""; backdrop.remove(); resolve(v); };
      var heading = document.createElement("div");
      heading.className = "node-modal-heading";
      var dismiss = document.createElement("button");
      dismiss.type = "button";
      dismiss.className = "node-modal-close";
      dismiss.setAttribute("aria-label", "Cancel wallet approval");
      dismiss.textContent = "×";
      dismiss.addEventListener("click", function () { done(null); });
      heading.appendChild(h);
      heading.appendChild(dismiss);
      var cancel = document.createElement("button");
      cancel.className = "btn";
      cancel.textContent = "Cancel";
      cancel.addEventListener("click", function () { done(null); });
      var okBtn = document.createElement("button");
      okBtn.className = "btn primary";
      okBtn.textContent = "Confirm";
      okBtn.addEventListener("click", function () { done(input.value); });
      input.addEventListener("keydown", function (e) {
        if (e.key === "Enter") done(input.value);
        if (e.key === "Escape") done(null);
      });
      actions.appendChild(cancel);
      actions.appendChild(okBtn);
      modal.appendChild(heading);
      modal.appendChild(body);
      modal.appendChild(actions);
      backdrop.appendChild(modal);
      root.appendChild(backdrop);
      input.focus();
    });
  }

  const READ_CHANNELS = new Set(["app:info","wallet:status","wallet:summary","wallet:history","producer:balances","chain:balances","chain:sync","chain:maxBurn","producer:status","producer:draft","producer:vaultStatus","node:status","node:profileMigrationPreview","node:profileMigrationStatus","setup:status","node:logs","node:dataDir","node:inspectDataDir","node:moveDataDirStatus","node:backups","node:quickSyncInfo","network:producers","dashboard:summary","distribution:status","masterApi:status","masterApi:checkHistory","rewards:status","fund:status","fund:ethBalance","fund:bridgeStatus","fund:routeCStatus","fund:bridgeMax","fund:bridgeQuote","fund:routeCompare","fund:ethSendQuote","fund:ethSendMax","fund:cryptoBalances","fund:usdtSendQuote","fund:usdtSendMax","fund:usdtFundQuote","fund:vkoinSendQuote","fund:vkoinSendMax","fund:routeMaxEth","util:copy"]);
  const WALLET_CHANNELS = new Set(["wallet:create","wallet:import","wallet:unlock","wallet:lock","wallet:revealWif","wallet:remove","chain:burn","chain:send","producer:register","producer:configure","producer:key","producer:prepare","producer:broadcast","producer:vaultConnect","producer:vaultUse","producer:vaultPrepare","producer:vaultSend","producer:vaultDisconnect","rewards:configure","rewards:runNow","distribution:configure","distribution:runNow","distribution:distributeNow","distribution:resetStats"]);
  const FUND_CHANNELS = new Set(["fund:buyUrl","fund:bridgeReset","fund:bridgeAdvance","fund:bridgeStart","fund:routeCReset","fund:routeCAdvance","fund:routeCResume","fund:routeCStart","fund:ethSend","fund:usdtSend","fund:vkoinSend"]);
  function rpc(channel, payload) {
    const method = READ_CHANNELS.has(channel) ? "node.read" : WALLET_CHANNELS.has(channel) ? "node.wallet" : FUND_CHANNELS.has(channel) ? "node.fund" : "node.manage";
    return window.kai.call(method, { channel: channel, payload: payload || {} }).then(
      function (data) { return { ok: true, data: data }; },
      function (error) { return { ok: false, error: String(error && error.message || error) }; }
    );
  }
  window.koinosShell = { pickFolder: function (title) { return window.kai.call("node.pickFolder", { title: title || "Choose Node data folder" }).then(function (result) { return result.canceled ? null : result.path; }); } };

  function invoke(channel, payload) {
    if (channel === "util:copy") return rpc(channel, payload);
    if (channel in OUTBOUND && !(payload && payload.password)) {
      return askPassword(OUTBOUND[channel]).then(function (pw) {
        if (pw == null) return { ok: false, error: "Cancelled — no funds moved." };
        var withPw = Object.assign({}, payload || {}, { password: pw });
        return rpc(channel, withPw);
      });
    }
    // Ask where the data goes BEFORE the download is described, so the free
    // space the modal quotes is the drive the user actually picked.
    if (channel === "node:quickSyncInfo") {
      return maybeAskBeforeQuickSync().then(function () { return rpc(channel, payload); });
    }
    return rpc(channel, payload).then(function (res) {
      // Links Core hands back are opened here, where a window exists.
      if (res && res.ok && res.data && res.data.openUrl) void rpc("util:openExternal", { url: res.data.openUrl });
      // The value card rides on the dashboard's own poll — no extra request,
      // and it updates in step with everything else on the screen.
      if (channel === "dashboard:summary" && res && res.ok) {
        try { paintValue(res.data); } catch (e) { /* never break the dashboard over a number */ }
      }
      return res;
    });
  }

  // ---- events: Core pushes the same app:event stream over SSE ----
  var listeners = [];
  let eventCursor = 0, eventsStopped = false;
  async function connectEvents() {
    if (eventsStopped) return;
    try {
      const result = await window.kai.call("node.events", { after: eventCursor });
      for (const item of result.events || []) {
        eventCursor = Math.max(eventCursor, item.id);
        listeners.forEach(function (cb) { try { cb(item.event); } catch {} });
      }
      eventCursor = Math.max(eventCursor, result.cursor || 0);
    } catch { /* Reconnect after a temporary Core error. */ }
    if (!eventsStopped) setTimeout(connectEvents, 1500);
  }
  window.addEventListener("pagehide", function () { eventsStopped = true; });

  connectEvents();

  window.koinos = {
    connectionQr: function (uri) {
      var url = new URL(uri);
      if (url.origin !== "https://koinvault.app" || url.pathname !== "/" || !/^[A-Za-z0-9_-]{24}$/.test(url.searchParams.get("connect") || "") || !/^[A-Za-z0-9_-]{43}$/.test(url.searchParams.get("secret") || "")) throw new Error("Invalid wallet connection link");
      return window.KQR.svg(window.KQR.encode(uri, { ec: "M" }), { scale: 5, quiet: 4 });
    },
    invoke: invoke,
    onEvent: function (cb) {
      listeners.push(cb);
      return function () { listeners = listeners.filter(function (x) { return x !== cb; }); };
    },
  };

  // ---- difference 3: the chain data folder is the user's choice ----

  function fmtBytes(n) {
    if (n == null) return "unknown";
    if (n >= 1e12) return (n / 1e12).toFixed(2) + " TB";
    if (n >= 1e9) return (n / 1e9).toFixed(1) + " GB";
    if (n >= 1e6) return (n / 1e6).toFixed(0) + " MB";
    return Math.max(1, Math.round(n / 1e3)) + " kB";
  }

  /*
   * The native folder picker lives on the HOST window's preload — Electron
   * does not run preload in sub-frames, so `koinosShell` is undefined in
   * here. The parent is same-origin, so reaching through to it is the whole
   * adaptation. Outside Electron (a browser, the tests) there is no picker at
   * all, so the modal falls back to a typed path rather than a dead button.
   */
  function shell() {
    try {
      if (window.koinosShell && window.koinosShell.pickFolder) return window.koinosShell;
      if (window.parent && window.parent !== window && window.parent.koinosShell) return window.parent.koinosShell;
    } catch (e) { /* cross-origin: no picker, fall back to typing */ }
    return null;
  }

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  /** The app's own modal shell, so anything added here looks native. */
  function kaiModal(title, onCancel) {
    var root = document.getElementById("modal-root");
    if (!root) return null;
    var backdrop = el("div", "modal-backdrop");
    var box = el("div", "modal");
    box.setAttribute("role", "dialog");
    box.setAttribute("aria-modal", "true");
    box.setAttribute("aria-label", title);
    var body = el("div", "modal-body");
    var actions = el("div", "actions");
    var heading = el("div", "node-modal-heading");
    heading.appendChild(el("h2", null, title));
    if (onCancel) {
      var dismiss = el("button", "node-modal-close", "×");
      dismiss.type = "button";
      dismiss.setAttribute("aria-label", "Cancel folder selection");
      dismiss.addEventListener("click", onCancel);
      heading.appendChild(dismiss);
      box.addEventListener("keydown", function (event) { if (event.key === "Escape") { event.preventDefault(); onCancel(); } });
    }
    box.appendChild(heading);
    box.appendChild(body);
    box.appendChild(actions);
    backdrop.appendChild(box);
    root.appendChild(backdrop);
    return {
      body: body,
      actions: actions,
      close: function () { backdrop.remove(); },
    };
  }

  /**
   * Ask where the chain data should live.
   *
   * `info` is node:dataDir. The current path is shown as the answer already
   * chosen — the point is that it is editable, not that it must be edited.
   * Resolves the chosen absolute path, or null if the user backed out.
   */
  function askFolder(info, opts) {
    opts = opts || {};
    return new Promise(function (resolve) {
      var dismiss = function () { m.close(); resolve(null); };
      var m = kaiModal(opts.title || "Where should the chain data go?", dismiss);
      if (!m) return resolve(null);

      var lead = el("p", "small");
      lead.textContent = opts.lead ||
        "A fully synced Koinos node is tens of gigabytes. It will go here unless you choose somewhere else — " +
        "an external or secondary drive is fine.";
      m.body.appendChild(lead);

      var chosen = info.path;
      var pathLine = el("p", "mono small");
      pathLine.id = "kai-dd-path";
      pathLine.style.wordBreak = "break-all";
      pathLine.style.margin = "10px 0 4px";
      pathLine.textContent = chosen;
      m.body.appendChild(pathLine);

      var facts = el("p", "small muted");
      var refreshFacts = function (free) {
        facts.textContent = free == null
          ? "Free space on that drive: unknown"
          : "Free space on that drive: " + fmtBytes(free);
      };
      refreshFacts(info.freeBytes);
      m.body.appendChild(facts);

      var warn = el("div", "banner warn");
      warn.id = "kai-dd-warn";
      warn.style.display = "none";
      m.body.appendChild(warn);

      // Typed fallback for a plain browser, where no native picker exists.
      var typed = null;
      if (!shell()) {
        typed = document.createElement("input");
        typed.type = "text";
        typed.id = "kai-dd-input";
        typed.value = chosen;
        typed.style.width = "100%";
        typed.style.marginTop = "10px";
        typed.addEventListener("input", function () { chosen = typed.value.trim(); pathLine.textContent = chosen; });
        m.body.appendChild(typed);
      }

      var change = el("button", "btn", shell() ? "Choose a different folder…" : "Check this folder");
      change.id = "kai-dd-change";
      var confirm = el("button", "btn primary", opts.confirmLabel || "Use this folder");
      confirm.id = "kai-dd-confirm";
      var cancel = el("button", "btn", "Cancel");
      cancel.id = "kai-dd-cancel";

      var vet = function (candidate) {
        return invoke("node:inspectDataDir", { path: candidate }).then(function (r) {
          if (!r.ok) { warn.style.display = ""; warn.textContent = r.error || "That folder can't be used."; return false; }
          var d = r.data;
          if (!d.ok) { warn.style.display = ""; warn.textContent = d.reason; confirm.disabled = true; return false; }
          warn.style.display = "none";
          confirm.disabled = false;
          chosen = d.target;
          pathLine.textContent = chosen;
          refreshFacts(d.targetFreeBytes);
          return true;
        });
      };

      change.addEventListener("click", function () {
        var sh = shell();
        if (!sh) return vet(typed ? typed.value.trim() : chosen);
        sh.pickFolder("Where should the Koinos chain data go?").then(function (dir) {
          if (!dir) return;
          vet(dir);
        });
      });
      cancel.addEventListener("click", dismiss);
      confirm.addEventListener("click", function () { m.close(); resolve(chosen); });

      m.actions.appendChild(cancel);
      m.actions.appendChild(change);
      m.actions.appendChild(confirm);
    });
  }

  /*
   * Quick sync is the moment the disk decision becomes expensive — it is
   * about to download and unpack the whole chain. Asking here, once, with the
   * default already filled in, is the difference between "it chose for me"
   * and "I chose". Asked only while there is nothing to move yet; after that
   * the Node screen's Change button is the right route, because then it is a
   * move rather than a setting.
   */
  var askedThisSession = false;
  function maybeAskBeforeQuickSync() {
    if (askedThisSession) return Promise.resolve();
    return invoke("node:dataDir", {}).then(function (r) {
      if (!r || !r.ok) return; // never block quick sync on this
      var info = r.data;
      if (info.hasData || !info.isDefault) { askedThisSession = true; return; }
      return askFolder(info, {}).then(function (dir) {
        askedThisSession = true;
        if (!dir || dir === info.path) return;
        return invoke("node:setDataDir", { path: dir }).then(function (res) {
          if (res && res.ok) toastish("Chain data will go to " + dir);
        });
      });
    })["catch"](function () { /* the choice is a courtesy; the sync still runs */ });
  }

  /** The app's toast, if the renderer has booted; otherwise silence. */
  function toastish(msg) {
    try {
      var wrap = document.getElementById("toasts");
      if (!wrap) return;
      var t = el("div", "toast good", msg);
      wrap.appendChild(t);
      setTimeout(function () { t.remove(); }, 6000);
    } catch (e) { /* cosmetic only */ }
  }

  /*
   * Moving what is already there. This is the one the owner asked for by
   * name: someone buys a bigger drive and needs the node to come with them.
   * The heavy lifting and every safety rule is in Core (koinos/data-move.js);
   * this is the conversation around it.
   */
  function onChangeDataFolder() {
    return invoke("node:dataDir", {}).then(function (r) {
      if (!r || !r.ok) return;
      var info = r.data;

      if (!info.hasData) {
        // Nothing downloaded yet: changing it is just a setting.
        return askFolder(info, { confirmLabel: "Use this folder" }).then(function (dir) {
          if (!dir || dir === info.path) return;
          return invoke("node:setDataDir", { path: dir }).then(function (res) {
            if (res && res.ok) toastish("Chain data will go to " + dir);
            else if (res) return window.kai.dialogs.alert(res.error, { title: "Could not change the data folder" });
          });
        });
      }

      return askFolder(info, {
        title: "Move the chain data",
        lead: "There is " + fmtBytes(info.sizeBytes) + " of chain data here. Choosing a new folder copies all of it " +
          "across, checks it arrived, and only then removes the original — so nothing is lost if it is interrupted. " +
          "The node stops while it runs.",
        confirmLabel: "Move the data here",
      }).then(function (dir) {
        if (!dir || dir === info.path) return;
        startMove(dir, info);
      });
    });
  }

  /** Run the move with a progress modal that cannot be dismissed by accident. */
  function startMove(target, info) {
    var m = kaiModal("Moving the chain data");
    if (!m) return;
    var line = el("p", "small");
    line.id = "kai-move-phase";
    line.textContent = "Stopping the node…";
    var bar = el("div", "small mono");
    bar.id = "kai-move-bar";
    bar.style.marginTop = "8px";
    var note = el("p", "small muted");
    note.style.marginTop = "10px";
    note.textContent = "Every file is copied, then read back and checked against the original before anything is removed. " +
      "Safe to leave running: if this is interrupted, your data stays exactly where it is.";
    m.body.appendChild(line);
    m.body.appendChild(bar);
    m.body.appendChild(note);

    var cancel = el("button", "btn", "Cancel");
    cancel.id = "kai-move-cancel";
    cancel.addEventListener("click", function () {
      cancel.disabled = true;
      cancel.textContent = "Cancelling…";
      invoke("node:moveDataDirCancel", {});
    });
    m.actions.appendChild(cancel);

    var PHASES = {
      stopping: "Stopping the node…",
      copying: "Copying",
      verifying: "Checking every file arrived…",
      checksumming: "Verifying the copy is identical",
      switching: "Switching over…",
      cleaning: "Removing the old copy…",
    };

    var poll = setInterval(function () {
      invoke("node:moveDataDirStatus", {}).then(function (r) {
        if (!r || !r.ok || !r.data) return;
        var s = r.data;
        line.textContent = PHASES[s.phase] || s.phase;
        if (s.phase === "copying" && s.totalBytes) {
          var pct = Math.min(100, Math.round((s.copiedBytes / s.totalBytes) * 100));
          bar.textContent = fmtBytes(s.copiedBytes) + " of " + fmtBytes(s.totalBytes) + "  (" + pct + "%)";
        }
        // The checksum pass re-reads everything, so it needs its own bar —
        // without one it looks like the move has hung at 100%.
        if (s.phase === "checksumming" && s.totalBytes) {
          var cpct = Math.min(100, Math.round((s.checkedBytes / s.totalBytes) * 100));
          bar.textContent = fmtBytes(s.checkedBytes) + " of " + fmtBytes(s.totalBytes) + " checked  (" + cpct + "%)";
        }
        if (s.running) return;
        clearInterval(poll);
        m.close();
        if (s.phase === "done") {
          toastish("Chain data moved to " + s.target);
        } else if (s.cancelled) {
          toastish("Move cancelled — your data is untouched.");
        } else {
          return window.kai.dialogs.alert("The move did not finish: " + (s.error || "unknown error") +
            "\n\nYour original data was left exactly where it was.", { title: "Chain data move did not finish" });
        }
      });
    }, 700);

    invoke("node:moveDataDir", { path: target }).then(function (r) {
      if (r && !r.ok) {
        clearInterval(poll);
        m.close();
        return window.kai.dialogs.alert(r.error + "\n\nYour original data was left exactly where it was.", { title: "Chain data move did not start" });
      }
    });
    if (info && info.sizeBytes) bar.textContent = "0 of " + fmtBytes(info.sizeBytes);
  }

  /*
   * The Node screen re-renders whenever its data refreshes, so the button is
   * (re)attached by watching for the vendored "Data folder" button to appear
   * rather than by hooking a render we do not own.
   */
  function attachChangeButton() {
    var open = document.getElementById("n-open");
    if (!open || document.getElementById("kai-n-move")) return;
    var btn = el("button", "btn ghost", "Change data folder");
    btn.id = "kai-n-move";
    btn.title = "Move the chain data to another drive";
    btn.addEventListener("click", onChangeDataFolder);
    open.parentNode.insertBefore(btn, open.nextSibling);
  }
  setInterval(attachChangeButton, 500);

  // ---- difference 4: node value and estimated earnings, in dollars ----

  /*
   * Money, formatted for a person. Small amounts keep cents; large ones drop
   * them, because "$1,204.00 per year" implies a precision this figure does
   * not have.
   */
  function usd(n) {
    if (n == null || !isFinite(n)) return "—";
    var abs = Math.abs(n);
    // KOIN trades below a cent, so four decimals would round the price to
    // "$0.0089" — collapsing exactly the digits anyone comparing against
    // another venue is looking at.
    var digits = abs >= 1000 ? 0 : abs >= 1 ? 2 : abs >= 0.01 ? 4 : 6;
    return "$" + n.toLocaleString(undefined, { minimumFractionDigits: digits, maximumFractionDigits: digits });
  }

  function vtile(host, id, label, value, sub) {
    var t = document.getElementById(id);
    if (!t) {
      t = el("div", "tile");
      t.id = id;
      t.appendChild(el("div", "t-label", label));
      t.appendChild(el("div", "t-value", ""));
      t.appendChild(el("div", "t-sub", ""));
      host.appendChild(t);
    }
    // textContent throughout: these are numbers and short phrases, and none of
    // it has any business being parsed as markup.
    t.childNodes[1].textContent = value;
    t.childNodes[2].textContent = sub || "";
  }

  /*
   * Draw (or redraw) the card from a dashboard:summary payload.
   *
   * The rules it follows are all the same rule: never let an unknown render as
   * a number. No price, unreachable balances, or a node too young to have
   * produced anything all show "—" with the reason underneath — because
   * "$0.00 per day" is a claim that the machine earns nothing, and that is a
   * different statement from "nothing has been measured yet".
   */
  function paintValue(data) {
    var root = document.getElementById("view-dashboard");
    var tiles = document.getElementById("d-tiles");
    if (!root || !tiles) return;             // dashboard not painted yet

    var card = document.getElementById("kai-value-card");
    if (!card) {
      card = el("div", "card");
      card.id = "kai-value-card";
      var head = el("div", "row spread");
      head.appendChild(el("h2", null, "\uD83C\uDFE0 Node value"));
      var note = el("span", "muted small");
      note.id = "kai-value-note";
      head.appendChild(note);
      card.appendChild(head);
      var grid = el("div", "widget-grid");
      grid.id = "kai-value-grid";
      card.appendChild(grid);
      // Keep Node value beside the Node Details card, above Profit & return.
      // The tile-grid fallback also supports the standalone UI scaffold.
      var details = document.getElementById("d-node-details") || tiles;
      details.parentNode.insertBefore(card, details.nextSibling);
    }

    var grid = document.getElementById("kai-value-grid");
    var v = (data && data.value) || {};
    var price = (data && data.price) || {};

    var priceSub = price.usdPerKoin != null
      ? "KOIN + VHP at " + usd(price.usdPerKoin) + " per KOIN"
      : "waiting for a price";
    vtile(grid, "kai-v-total", "Node value", usd(v.nodeValueUsd), priceSub);

    var earnSub = v.basis === "measured"
      ? "from " + v.daysTracked + " day" + (v.daysTracked === 1 ? "" : "s") + " measured"
      : "not enough history yet";
    vtile(grid, "kai-v-daily", "Est. daily", usd(v.dailyUsd), earnSub);
    vtile(grid, "kai-v-weekly", "Est. weekly", usd(v.weeklyUsd), earnSub);
    vtile(grid, "kai-v-yearly", "Est. yearly", usd(v.yearlyUsd), earnSub);

    // The header note carries every caveat, so the tiles can stay clean.
    var note = document.getElementById("kai-value-note");
    var bits = [];
    if (price.usdPerKoin != null) {
      bits.push("Uniswap vKOIN/USDT");
      if (price.stale) bits.push("price " + Math.round((price.ageMs || 0) / 60000) + " min old");
    } else if (price.error) {
      bits.push("no price: " + price.error);
    } else if (price.pending) {
      bits.push("fetching price\u2026");
    }
    if (v.basis === "measured") bits.push("estimates, not a forecast");
    note.textContent = bits.join(" \u00B7 ");
  }

  // Reachable for tests, which cannot drive a live Ethereum quote.
  window.KaiNodeValue = { paint: paintValue, usd: usd };

  // Reachable for tests, which cannot click through a native folder picker.
  window.KaiNodeData = {
    change: onChangeDataFolder,
    attach: attachChangeButton,
    askBeforeQuickSync: maybeAskBeforeQuickSync,
  };

  // ---- 5. receive by QR ----
  /*
   * The addresses on the Wallet and Fund screens are copyable, which serves a
   * desktop wallet and nothing else. Money arrives at a node from a phone
   * wallet or an exchange app, and neither of those can reach this machine's
   * clipboard — so today the only route is reading 42 characters across and
   * typing them in, which is both miserable and the one error on these
   * screens that burns real funds with no way back.
   *
   * Each target names the element it reads the address FROM rather than being
   * handed a value. That is deliberate: it makes it impossible for the code
   * on screen to encode anything other than the text printed beside it, even
   * if a future refresh repaints one and not the other.
   */
  var QR_TARGETS = [
    {
      id: "kai-qr-koin",
      afterButton: "w-copy",
      addressFrom: function () {
        var btn = document.getElementById("w-copy");
        var row = btn && btn.parentNode;
        return row && row.querySelector(".addr");
      },
      title: "Receive",
      caption: "Scan to send KOIN or VHP to this node",
      warning: "This is a <b>Koinos</b> address. Only KOIN or VHP should be sent here — " +
               "ETH or USDT sent to it will be lost.",
    },
    {
      id: "kai-qr-eth",
      afterButton: "w-eth-copy",
      addressFrom: function () { return document.getElementById("w-eth-addr"); },
      title: "Receive ETH or USDT",
      caption: "Scan to send ETH or USDT to this node's funding address",
      warning: "Send only <b>ETH or USDT on Ethereum Mainnet</b>. " +
               "Other networks or other tokens may be lost.",
    },
    {
      id: "kai-qr-fund",
      afterButton: "fund-copy",
      addressFrom: function () {
        var wrap = document.getElementById("fund-addr-wrap");
        return wrap && wrap.querySelector(".mono");
      },
      title: "Fund this node",
      caption: "Scan to send ETH from a phone wallet or an exchange",
      warning: "Send only <b>ETH on Ethereum Mainnet</b> here. " +
               "Funds on other networks or other tokens may be lost.",
    },
  ];

  /** Is this actually an address, or the renderer's placeholder? */
  function usableAddress(node) {
    var text = node && (node.textContent || "").trim();
    if (!text || text.length < 8) return null;
    if (text.charAt(0) === "(" || text.indexOf("\u2026") === 0) return null; // "(unavailable)", "…"
    return text;
  }

  function showQr(target) {
    var address = usableAddress(target.addressFrom());
    if (!address) {
      if (window.toast) window.toast("No address to show yet", "bad");
      return;
    }
    var art;
    try {
      // Level M recovers ~15% — the usual choice for an address on a screen.
      // Enough for a phone camera held at an angle, without pushing the module
      // count so high that the code renders too fine to read in a small window.
      art = window.KQR.svg(window.KQR.encode(address, { ec: "M" }), { scale: 6, quiet: 4 });
    } catch (e) {
      if (window.toast) window.toast("Could not render a QR code: " + (e.message || e), "bad");
      return;
    }

    var m = kaiModal(target.title);
    if (!m) return;

    var artWrap = el("div");
    artWrap.style.display = "flex";
    artWrap.style.justifyContent = "center";
    artWrap.style.padding = "14px 0 4px";
    artWrap.innerHTML = art;
    // The code is drawn on its own white ground: scanners read dark-on-light
    // and every surface around it in this app is dark.
    var svgEl = artWrap.querySelector("svg");
    if (svgEl) svgEl.style.borderRadius = "10px";
    m.body.appendChild(artWrap);

    if (target.caption) {
      var cap = el("p", "hint", target.caption);
      cap.style.textAlign = "center";
      m.body.appendChild(cap);
    }

    // The address stays on screen under the code. A QR is unreadable to a
    // human, and anyone who wants to check what they just scanned can compare
    // the ends of it without closing the sheet.
    var addr = el("div", "addr", address);
    addr.style.marginTop = "12px";
    m.body.appendChild(addr);

    if (target.warning) {
      var warn = el("div", "banner warn");
      warn.style.marginTop = "12px";
      // The surrounding screen carries this caveat too, but a QR invites a
      // scan from a phone wallet that may be on another chain entirely, so it
      // has to travel with the code rather than stay on the page behind it.
      warn.innerHTML = target.warning;
      m.body.appendChild(warn);
    }

    var copy = el("button", "btn", "Copy address");
    copy.addEventListener("click", function () {
      // invoke() resolves {ok:false} when the clipboard write is refused
      // rather than rejecting, so saying "copied" unconditionally would be a
      // lie exactly when the user needs to know to fall back to the QR.
      window.koinos.invoke("util:copy", { text: address }).then(function (res) {
        if (!window.toast) return;
        if (res && res.ok) window.toast("Address copied", "good");
        else window.toast("Could not copy — scan the code instead", "bad");
      });
    });
    var done = el("button", "btn primary", "Done");
    done.addEventListener("click", m.close);
    m.actions.appendChild(copy);
    m.actions.appendChild(done);
  }

  /** Put a QR button beside every copy button that has an address next to it. */
  function attachQrButtons() {
    if (!window.KQR) return; // qr.js absent: leave the screens exactly as they were
    QR_TARGETS.forEach(function (target) {
      // Already attached. This is not just tidiness: the observer below fires
      // on our own insertion, so without this the two feed each other and the
      // page wedges rather than merely growing a second button.
      if (document.getElementById(target.id)) return;
      var anchor = document.getElementById(target.afterButton);
      if (!anchor || !anchor.parentNode) return;           // that view is not painted
      var btn = el("button", "btn ghost", "QR Code");
      btn.id = target.id;
      btn.addEventListener("click", function () { showQr(target); });
      anchor.parentNode.insertBefore(btn, anchor.nextSibling);
    });
  }

  /*
   * The renderer repaints whole views from innerHTML — on unlock, on every
   * fund refresh — so the buttons have to be re-attached rather than added
   * once. Watching the DOM covers every repaint path without this file having
   * to know which channel caused it. Re-attaching is a no-op when they are
   * already there, which is what stops this from feeding itself: the insert
   * is a mutation, and the guard in attachQrButtons is what makes it settle.
   */
  if (typeof MutationObserver === "function") {
    new MutationObserver(function () { attachQrButtons(); })
      .observe(document.documentElement, { childList: true, subtree: true });
  }
  document.addEventListener("DOMContentLoaded", attachQrButtons);

  // ---- embedded in Koinos AI: its sidebar drives the views ----
  // The host hides this page's own sidebar (the menus live in Koinos AI's,
  // revealed by the Run Koinos Node switch) and posts {koinosView: "..."}.
  // Clicking the hidden nav item is the switch mechanism, so this stays true
  // to renderer.js's own navigation no matter how it changes. Clicks land
  // only after init() attaches listeners, so keep trying until the view is
  // actually active.
  var wanted = null;
  var sections = new Set(["dashboard", "wallet", "fund", "burn", "node", "distribution", "master-api", "returns", "settings"]);
  function requestSection(section) { if (sections.has(section)) wanted = section; }
  window.kai.onEvent?.("kai-plugin:navigate", function (value) { requestSection(value?.section || "dashboard"); });
  window.addEventListener("message", function (e) {
    requestSection(e.data?.koinosView);
  });
  setInterval(function () {
    if (!wanted) return;
    var section = document.getElementById("view-" + wanted);
    if (section && section.classList.contains("active")) { wanted = null; return; }
    var item = document.querySelector('.nav-item[data-view="' + wanted + '"]');
    if (item) item.click();
  }, 200);

  document.addEventListener("DOMContentLoaded", function () {
    document.getElementById("master-app-settings")?.addEventListener("click", function () {
      window.kai.call("node.appSettings", {}).catch(function (error) {
        void window.kai.dialogs.alert(String(error.message || error), { title: "Could not open App settings" });
      });
    });
    if (window.parent === window) return; // standalone: leave the page alone
    var sidebar = document.getElementById("sidebar");
    if (sidebar) sidebar.style.display = "none";
  });
})();
