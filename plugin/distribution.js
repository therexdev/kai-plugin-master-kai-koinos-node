"use strict";
async function refreshDistribution(){try{S.distribution=await call("distribution:status");patchDistributionView();}catch(e){toast(e.message,"bad");}}
function addSatsUi(a,b){return (BigInt(a||"0")+BigInt(b||"0")).toString();}
function pct(v){const n=Math.round(Number(v));return !Number.isFinite(n)||n<0?0:Math.min(100,n);}
// ---------- distribution view ----------

function renderDistributionView() {
  const root = $("#view-distribution");
  const cfg = S.distribution?.config ?? S.appInfo.settings.distribution;
  root.innerHTML = `
    <h1>Community distribution</h1>
    <p class="lead">The VHP each block consumes is automatically re-burned so your node keeps producing at the same level. Split the remaining <b>profit</b> by percentage — once a day — between compounding, community pools, saved addresses, and your own wallet.</p>
    <div class="grid-2">
      <div class="card">
        <h2>⚙️ Configuration</h2>
        <label class="field"><span class="row" style="gap:8px">
          <input type="checkbox" id="di-enabled" ${cfg.enabled ? "checked" : ""} style="width:auto">
          <b>Enable community distribution</b></span></label>
        <div class="field">
          <span>What happens to each cycle's profit</span>
          <table class="split-table" style="margin-top:6px">
            <tbody>
              <tr><td>♻️ <b>Reburn</b> <span class="muted small">— compounded back into VHP</span></td>
                <td class="split-pct"><input id="di-pct-reburn" type="number" min="0" max="100" class="mono" value="${pct(cfg.reburnPct)}">%</td></tr>
              <tr><td>🤖 <b>Koinos AI Node</b> <span class="muted small">— every address seen on the AI network</span></td>
                <td class="split-pct"><input id="di-pct-ai" type="number" min="0" max="100" class="mono" value="${pct(cfg.sharePct?.ai)}">%</td></tr>
              <tr><td>⛏️ <b>Producing</b> <span class="muted small">— every node producing blocks with the minimum VHP</span></td>
                <td class="split-pct"><input id="di-pct-vhp" type="number" min="0" max="100" class="mono" value="${pct(cfg.sharePct?.producing)}">%</td></tr>
              <tr><td>⭐ <b>Both</b> <span class="muted small">— a bonus for doing both, <i>on top of</i> the two above</span></td>
                <td class="split-pct"><input id="di-pct-both" type="number" min="0" max="100" class="mono" value="${pct(cfg.sharePct?.both)}">%</td></tr>
              <tr><td>📤 <b>Saved addresses</b> <span class="muted small">— total of the recipients below</span></td>
                <td class="split-pct"><span id="di-pct-recipients" class="mono">0</span>%</td></tr>
              <tr class="split-rest"><td>👛 <b>Stays in your wallet</b> <span class="muted small">— whatever the percentages leave over</span></td>
                <td class="split-pct"><span id="di-pct-kept" class="mono">0</span>%</td></tr>
            </tbody>
          </table>
          <p class="hint" id="di-rule" style="margin-top:8px"></p>
        </div>
        <div class="field">
          <h3>Saved addresses</h3>
          <p class="hint">Give each address a whole percentage of the profit (0–100%). Recipients do not need to run a node. Set 0% to keep an address saved without adding new payouts.</p>
          <div id="di-recipients" class="stack"></div>
          <button id="di-add-recipient" class="btn" type="button">+ Add address</button>
          <p class="hint">Click Save to keep the list on this node. Changes apply at the next settlement, including the current cycle. Existing queued or accumulated payouts stay with their original address; lowering the minimum payout can release a small accumulated amount after an address is removed.</p>
        </div>
        <label class="field"><span>How each pool's share is split between its members</span>
          <select id="di-weighting">
            <option value="participation" ${cfg.weighting !== "even" ? "selected" : ""}>\u23f1\ufe0f By rewards earned — share \u221d the rewards a node was qualifying for</option>
            <option value="even" ${cfg.weighting === "even" ? "selected" : ""}>\u2696\ufe0f Evenly — a flat split among everyone in the pool</option>
          </select></label>
        <label class="field" id="di-minvhp-wrap"><span>Minimum VHP a node needs to count as producing <span class="muted small">(0 = any producer)</span></span>
          <input id="di-minvhp" type="text" class="mono" value="${esc(cfg.minVhpKoin)}"></label>
        <label class="field" id="di-roster-wrap"><span>Koinos AI Node roster URL</span>
          <input id="di-roster" type="text" class="mono" placeholder="https://…/workers/active" value="${esc(cfg.aiRosterUrl ?? "")}"></label>
        <label class="field"><span>Distribute daily at (UTC hour, 0–23)</span>
          <input id="di-hour" type="number" min="0" max="23" value="${cfg.payoutHourUtc}"></label>
        <div class="grid-2">
          <label class="field"><span>Minimum share to pay out (${esc(sym())})</span>
            <input id="di-minpay" type="text" class="mono" value="${esc(cfg.minPayoutKoin)}"></label>
          <label class="field"><span>Check every (minutes)</span>
            <input id="di-poll" type="number" min="1" value="${cfg.pollMinutes}"></label>
        </div>
        <div class="row">
          <label class="field"><span>Wallet password to authorize settings</span><input id="di-password" type="password" autocomplete="current-password"></label>
          <button id="di-save" class="btn primary">Save</button>
          <button id="di-pause" class="btn">Pause distribution</button>
          <button id="di-reset" class="btn danger" type="button">Reset Stats</button>
          <button id="di-now" class="btn">Check now</button>
          <button id="di-close" class="btn">Distribute now</button>
        </div>
        <p class="hint">Pausing stops reward tracking, reburn tracking, and payouts. Mining while paused is skipped when you enable distribution again. Reset Stats clears distribution totals, pending reburn, payouts, carried amounts, and local distribution history, and leaves distribution paused. Your saved settings, wallet balances, and node keep their current state.</p>
        <p class="hint">The pools <b>overlap</b>: run a Koinos AI Node and you are in the AI pool, produce blocks with the minimum VHP and you are in the producing pool — do both and you are in all three, paid from each. Each pool's percentage is split between its own members. The reburn is on top of the VHP your blocks consume, which is always restored so your node keeps producing at the same rate.</p>
        <p class="hint">Every time this node collects a block reward, each address is credited with it in every pool it belonged to <b>at that moment</b>, and each pool's share is paid in proportion to those credits. Be qualified for two of three rewards while someone else catches one, and you are paid exactly 2:1. Turn up in the last ten minutes and you earn the last ten minutes. Stake never buys a bigger share — a node with ten times the minimum VHP earns the same as one right at it.</p>
        <p class="hint">Credits are only cleared when a pool is actually paid out, so rewards that roll over still belong to whoever was around when they were earned. Any share below the minimum is skipped and carried rather than sent, because each payout spends mana. A pool nobody was in earns nothing — its percentage simply stays in your wallet.</p>
        <p class="hint">Whenever an AI pool is funded, the roster URL decides who is credited — point it only at a roster you trust. If the roster can't be read at any point during a day, the AI pools pay nobody and their share carries over rather than being kept. The producing pool is unaffected, and the VHP reburn still happens.</p>
        <p class="hint">Payouts are signed locally, so the app must be open with the wallet unlocked. Sending and reburning KOIN spend <b>mana</b> — big distributions drain out in chunks as mana recharges. Enabling this turns off the Reward-returns tab (they'd both spend the same rewards).</p>
      </div>
      <div class="card">
        <h2>📊 Status</h2>
        <div id="di-status" class="stack"></div>
      </div>
    </div>
    <div class="card">
      <h2>🧾 Distribution cycles</h2>
      <table><thead><tr><th>Closed</th><th>Profit</th><th>Reburned</th><th>Allocated payouts</th><th>Recipients</th><th>Kept</th><th>Carried</th></tr></thead>
      <tbody id="di-history"></tbody></table>
    </div>
    <div class="card">
      <h2>📤 Recent transactions</h2>
      <table><thead><tr><th>When</th><th>What</th><th>Amount</th><th>Tx</th></tr></thead>
      <tbody id="di-actions"></tbody></table>
    </div>`;

  // Keep the remainder, the conditional fields and the warnings in step with
  // the percentages as they are typed — the arithmetic should never be a
  // surprise waiting until Save.
  const syncSplits = () => {
    const p = splitInputs();
    const recipientPct = distributionRecipientInputs().reduce((sum, r) => sum + (Number(r.pct) || 0), 0);
    const allocated = p.reburnPct + p.ai + p.producing + p.both + recipientPct;
    $("#di-pct-recipients").textContent = String(recipientPct);
    const kept = 100 - allocated;
    const keptEl = $("#di-pct-kept");
    keptEl.textContent = String(kept);
    keptEl.className = "mono" + (kept < 0 ? " bad-text" : "");
    // A requirement nobody is paid for is never measured, so its field is only
    // relevant while a pool that depends on it is funded.
    const produceActive = p.producing > 0 || p.both > 0;
    const aiActive = p.ai > 0 || p.both > 0;
    $("#di-minvhp-wrap").style.display = produceActive ? "block" : "none";
    $("#di-roster-wrap").style.display = aiActive ? "block" : "none";
    $("#di-rule").innerHTML =
      kept < 0
        ? `<span class="bad-text">These come to ${allocated}% — more profit than there is. Reduce them to 100% or less.</span>`
        : allocated === 0
          ? "Nothing is allocated: the profit stays in your wallet, exactly like a normal node."
          : [
              p.reburnPct > 0 ? `<b>${p.reburnPct}%</b> compounds into VHP` : null,
              p.ai > 0 ? `<b>${p.ai}%</b> to AI nodes` : null,
              p.producing > 0 ? `<b>${p.producing}%</b> to producers` : null,
              p.both > 0 ? `<b>${p.both}%</b> more to nodes doing both` : null,
              recipientPct > 0 ? `<b>${recipientPct}%</b> to saved addresses` : null,
              kept > 0 ? `<b>${kept}%</b> stays with you` : null,
            ].filter(Boolean).join(" · ") +
            (p.both > 0 && p.ai > 0 && p.producing > 0
              ? ` — a node doing both is paid from all three (${p.ai + p.producing + p.both}% of the profit between them).`
              : "");
  };
  ["#di-pct-reburn", "#di-pct-ai", "#di-pct-vhp", "#di-pct-both"].forEach((sel) =>
    $(sel).addEventListener("input", syncSplits)
  );
  const addRecipient = (recipient = {}) => {
    const row = document.createElement("div");
    row.className = "distribution-recipient";
    row.innerHTML = `
      <label class="field recipient-name"><span>Name (optional)</span>
        <input class="di-recipient-label" maxlength="80" value="${esc(recipient.label ?? "")}" placeholder="e.g. Project treasury"></label>
      <label class="field recipient-address"><span>Koinos address</span>
        <input class="di-recipient-address mono" value="${esc(recipient.address ?? "")}" placeholder="Recipient address" spellcheck="false" autocomplete="off"></label>
      <label class="field recipient-percentage"><span>Profit %</span>
        <input class="di-recipient-pct mono" type="number" min="0" max="100" step="1" value="${esc(recipient.pct ?? 0)}"></label>
      <button class="btn danger di-recipient-remove" type="button" aria-label="Remove saved address">Remove</button>`;
    $(".di-recipient-remove", row).addEventListener("click", () => { row.remove(); syncSplits(); });
    row.addEventListener("input", syncSplits);
    $("#di-recipients").append(row);
    return row;
  };
  for (const recipient of cfg.recipients ?? []) addRecipient(recipient);
  $("#di-add-recipient").addEventListener("click", () => {
    const row = addRecipient();
    $(".di-recipient-address", row).focus();
    syncSplits();
  });
  syncSplits();

  $("#di-save").addEventListener("click", onSaveDistribution);
  $("#di-pause").addEventListener("click", async () => {
    try {
      await call("distribution:configure", { enabled: false });
      $("#di-enabled").checked = false;
      await refreshDistribution();
      toast("Distribution and tracking paused. Existing amounts are kept until you resume or reset stats.", "good");
    } catch (e) { toast(e.message, "bad"); }
  });
  $("#di-now").addEventListener("click", () => onDistributionTick("distribution:runNow", $("#di-now"), "Checking…"));
  $("#di-close").addEventListener("click", onDistributeNow);
  $("#di-reset").addEventListener("click", onResetDistributionStats);
  patchDistributionView();
}

function distributionRecipientInputs() {
  return $$("#di-recipients .distribution-recipient").map((row) => ({
    address: $(".di-recipient-address", row).value.trim(),
    label: $(".di-recipient-label", row).value.trim(),
    pct: $(".di-recipient-pct", row).value,
  }));
}

// The four percentage boxes, clamped the way the engine clamps them.
function splitInputs() {
  const read = (sel) => {
    const n = Math.round(Number($(sel).value));
    return Number.isFinite(n) && n > 0 ? Math.min(100, n) : 0;
  };
  return {
    reburnPct: read("#di-pct-reburn"),
    ai: read("#di-pct-ai"),
    producing: read("#di-pct-vhp"),
    both: read("#di-pct-both"),
  };
}

async function onSaveDistribution() {
  const btn = $("#di-save");
  const p = splitInputs();
  busyButton(btn, true, "Saving…");
  try {
    await call("distribution:configure", {
      password: $("#di-password").value,
      enabled: $("#di-enabled").checked,
      weighting: $("#di-weighting").value,
      reburnPct: p.reburnPct,
      sharePct: { ai: p.ai, producing: p.producing, both: p.both },
      recipients: distributionRecipientInputs(),
      aiRosterUrl: $("#di-roster").value.trim(),
      minVhpKoin: $("#di-minvhp").value.trim(),
      payoutHourUtc: Number($("#di-hour").value),
      minPayoutKoin: $("#di-minpay").value.trim(),
      pollMinutes: Number($("#di-poll").value),
    });
    toast("Distribution settings saved", "good");
    await Promise.all([refreshDistribution(), refreshRewards()]);
  } catch (e) {
    toast(e.message, "bad");
  } finally {
    $("#di-password").value = "";
    busyButton(btn, false);
  }
}

async function onDistributionTick(channel, btn, busyLabel) {
  busyButton(btn, true, busyLabel);
  try {
    S.distribution = await call(channel);
    patchDistributionView();
    const last = S.distribution.last;
    toast(last?.message || `Check complete: ${last?.outcome ?? "done"}`,
      ["cycle-closed", "distributed"].includes(last?.outcome) ? "good"
        : last?.outcome === "cycle-held" ? "warn" : "info", 8000);
  } catch (e) {
    toast(e.message, "bad");
  } finally {
    busyButton(btn, false);
  }
}

function onDistributeNow() {
  showModal({
    title: "Close the cycle now?",
    body: `<p class="small">This closes the current cycle immediately instead of waiting for the daily time:
      the VHP consumed so far is queued for reburn and the profit earned <b>up to now</b> is carved up by
      your percentages. The next cycle starts fresh right after.</p>`,
    actions: [
      { label: "Cancel", onClick: (close) => close() },
      {
        label: "Distribute now", class: "primary",
        onClick: async (close) => {
          close();
          await onDistributionTick("distribution:distributeNow", $("#di-close"), "Distributing…");
        },
      },
    ],
  });
}

function onResetDistributionStats() {
  showModal({
    title: "Reset distribution stats?",
    body: `<p>This resets rewards, VHP consumed, profit, queued reburn, queued payouts, carried amounts, and local distribution history to zero.</p>
      <p>Distribution will stay paused until you enable it again. Your saved recipients and settings are kept. Wallet balances and completed blockchain transactions are unchanged.</p>
      <p>If any transaction has an unknown result, check it in Wallet History or the block explorer first. Resetting discards pending accounting and cannot undo funds already sent.</p>`,
    actions: [
      { label: "Cancel", onClick: (close) => close() },
      { label: "Reset Stats", class: "danger", onClick: async (close) => {
        close();
        const btn = $("#di-reset");
        busyButton(btn, true, "Resetting…");
        try {
          S.distribution = await call("distribution:resetStats", { confirmed: true });
          $("#di-enabled").checked = false;
          patchDistributionView();
          toast("Distribution stats reset to zero. Enable distribution when you are ready to start fresh.", "good");
        } catch (e) { toast(e.message, "bad"); }
        finally { busyButton(btn, false); }
      } },
    ],
  });
}

const DISTRIBUTION_OUTCOME_LABELS = {
  disabled: ["pill", "disabled"],
  "no-wallet": ["pill warn", "no wallet"],
  locked: ["pill warn", "wallet locked"],
  "rpc-error": ["pill bad", "RPC error"],
  "history-unavailable": ["pill bad", "no history RPC"],
  syncing: ["pill accent", "reading history…"],
  anchored: ["pill accent", "tracking started"],
  resumed: ["pill accent", "tracking resumed"],
  reset: ["pill", "stats reset"],
  "re-anchored": ["pill warn", "re-anchored"],
  watching: ["pill accent", "watching network"],
  "cycle-closed": ["pill good", "cycle closed"],
  "cycle-held": ["pill warn", "held — roster unavailable"],
  distributing: ["pill accent", "paying out…"],
  distributed: ["pill good", "all paid out"],
  "tx-error": ["pill bad", "tx failed"],
  "invalid-config": ["pill bad", "check settings"],
};

const TIER_UI = {
  reburn: ["♻️", "Reburn → VHP"],
  both: ["⭐", "Doing both (bonus)"],
  producing: ["⛏️", "Producing"],
  ai: ["🤖", "Koinos AI Node"],
  recipients: ["📤", "Saved addresses"],
  kept: ["👛", "Stays in your wallet"],
};
const TIER_ORDER = ["both", "producing", "ai"];

// The configured carve-up as pills, for the Status panel's one-line summary.
function splitPills(cfg) {
  const parts = [];
  const add = (key, value) => {
    if (value > 0) parts.push(`<span class="pill accent">${TIER_UI[key][0]} ${value}%</span>`);
  };
  add("reburn", pct(cfg.reburnPct));
  for (const tier of TIER_ORDER) add(tier, pct(cfg.sharePct?.[tier]));
  const recipientPct = (cfg.recipients ?? []).reduce((sum, r) => sum + pct(r.pct), 0);
  add("recipients", recipientPct);
  const kept =
    100 - pct(cfg.reburnPct) - TIER_ORDER.reduce((a, t) => a + pct(cfg.sharePct?.[t]), 0) - recipientPct;
  if (kept > 0) parts.push(`<span class="pill">👛 ${kept}%</span>`);
  return parts.join(" ") || `<span class="pill">nothing allocated</span>`;
}

// What the profit so far would become if the cycle closed right now, line by
// line — the same arithmetic the engine will do, shown before it happens.
function splitRows(split, creditCounts) {
  const row = (key, amount, pctVal, note) =>
    pctVal > 0
      ? `<div class="row spread"><span class="muted small">&nbsp;&nbsp;${TIER_UI[key][0]} ${esc(TIER_UI[key][1])} <span class="mono">${pctVal}%</span>${note}</span>
           <span class="mono small">${fmtSat(amount, 4)} ${sym()}</span></div>`
      : "";
  const members = (tier) => {
    const n = creditCounts?.[tier];
    return n == null ? "" : ` <span class="muted small">· ${n} node${n === 1 ? "" : "s"}</span>`;
  };
  return [
    row("reburn", split.reburn, split.reburnPct, ""),
    ...TIER_ORDER.map((t) => row(t, split.tiers[t].amount, split.tiers[t].pct, members(t))),
    ...(split.recipients ?? []).filter((r) => r.pct > 0).map((r) =>
      `<div class="row spread"><span class="muted small" title="${esc(r.address)}">📤 ${esc(r.label || shortTx(r.address))} <span class="mono">${r.pct}%</span></span>
        <span class="mono small">${fmtSat(r.amount, 4)} ${sym()}</span></div>`),
    row("kept", split.kept, Math.max(0, split.keptPct), ""),
  ].join("");
}

function patchDistributionView() {
  const statusEl = $("#di-status");
  if (!statusEl) return;
  const r = S.distribution;
  if (!r) { statusEl.innerHTML = `<span class="muted">Loading…</span>`; return; }
  const d = r.derived;
  const c = d?.cycle;
  const q = d?.queue;
  const last = r.last;
  const [pillClass, pillLabel] = last ? DISTRIBUTION_OUTCOME_LABELS[last.outcome] ?? ["pill", last.outcome] : ["pill", "no checks yet"];
  // The roster is only read — and only worth reporting on — while a pool that
  // depends on it is funded.
  const aiActive = pct(r.config.sharePct?.ai) > 0 || pct(r.config.sharePct?.both) > 0;
  statusEl.innerHTML = `
    ${d?.inFlight && !d.inFlight.active ? `<div class="banner bad" role="alert">A distribution transaction has an unknown result. Automatic payouts are paused. Check Wallet History or the block explorer before using Reset Stats.</div>` : ""}
    <div class="row spread"><span class="muted">Engine</span>
      <span class="pill ${r.config.enabled ? "good" : "warn"}">${r.config.enabled ? "enabled" : "disabled"}</span></div>
    ${!r.config.enabled ? `<div class="muted small">Tracking paused. Mining while off will not be added to distribution.</div>` : d?.trackingPaused || !d?.anchored ? `<div class="muted small">Waiting for the first complete reward-history check to start tracking.</div>` : ""}
    <div class="row spread"><span class="muted">Last check</span>
      <span class="small">${last ? `${fmtTime(last.time)} · ` : ""}<span class="${pillClass}">${esc(pillLabel)}</span></span></div>
    ${last?.message ? `<div class="muted small">${esc(last.message)}</div>` : ""}
    <div class="row spread"><span class="muted">Next distribution</span>
      <span class="small mono">${c?.dueAt ? fmtTime(c.dueAt) : "—"}</span></div>
    <hr style="border-color:var(--border);border-style:solid;opacity:.4">
    <div class="row spread"><span class="muted">Profit split</span>
      <span class="small">${splitPills(r.config)}</span></div>
    <div class="row spread"><span class="muted">Within a pool</span>
      <span class="small">${r.config.weighting === "even"
        ? `<span class="pill">evenly</span>`
        : `<span class="pill accent">by rewards earned</span>`}</span></div>
    <div class="row spread"><span class="muted">Producers seen this cycle</span>
      <span class="mono">${c ? c.seenCount : "0"}</span></div>
    <div class="row spread"><span class="muted">Reward checks this cycle</span>
      <span class="mono">${c ? c.ticks ?? 0 : "0"}</span></div>
    ${aiActive
      ? `<div class="row spread"><span class="muted">AI nodes seen this cycle</span>
      <span class="mono">${c ? c.aiSeenCount : "0"}${c?.aiReads ? ` <span class="muted small">(${c.aiReads.ok} ok / ${c.aiReads.failed} failed)</span>` : ""}</span></div>
    ${!r.config.aiRosterUrl
        ? `<div class="muted small">⚠️ No roster URL set — no one can be verified as running a Koinos AI Node, so cycles will pay nobody and carry over.</div>`
        : c?.aiReads?.accepted === 0 && c?.aiReads?.rejected > 0
          ? `<div class="muted small">⚠️ The roster answered, but none of the ${c.aiReads.rejected} addresses it returned were valid Koinos addresses. A status/display page that shortens addresses (<span class="mono">1AbCdE…wXyZ</span>) can't be paid to — point this at an endpoint that returns full addresses.</div>`
          : c?.aiReads?.lastError
            ? `<div class="muted small">⚠️ Last roster read failed: ${esc(c.aiReads.lastError)}</div>`
            : c?.aiReads?.rejected > 0
              ? `<div class="muted small">⚠️ ${c.aiReads.rejected} roster ${c.aiReads.rejected === 1 ? "entry was" : "entries were"} not a valid Koinos address and ${c.aiReads.rejected === 1 ? "was" : "were"} ignored.</div>`
              : ""}`
      : ""}
    <div class="row spread"><span class="muted">Rewards this cycle</span>
      <span class="mono">${fmtSat(c?.rewards ?? "0", 4)} ${sym()}</span></div>
    <div class="row spread"><span class="muted">VHP consumed (to reburn)</span>
      <span class="mono">${fmtSat(c?.vhpConsumed ?? "0", 4)} ${sym()}</span></div>
    <div class="row spread"><span class="muted">Profit to carve up</span>
      <span class="mono">${fmtSat(c?.profit ?? "0", 4)} ${sym()}</span></div>
    ${c?.split ? splitRows(c.split, d?.creditCounts) : ""}
    <div class="row spread"><span class="muted">Carried from earlier cycles</span>
      <span class="mono">${d ? fmtSat(d.carry, 4) : "0"} ${sym()}</span></div>
    ${Object.entries(d?.carryByRecipient ?? {}).map(([address, amount]) =>
      `<div class="row spread"><span class="muted small" title="${esc(address)}">📤 ${esc(shortTx(address))} accumulated</span>
        <span class="mono small">${fmtSat(amount, 8)} ${sym()}</span></div>`).join("")}
    <hr style="border-color:var(--border);border-style:solid;opacity:.4">
    <div class="row spread"><span class="muted">Reburn queued</span>
      <span class="mono">${q ? fmtSat(q.reburnOwed, 4) : "0"} ${sym()}</span></div>
    <div class="row spread"><span class="muted">Payouts queued</span>
      <span class="mono">${q ? `${q.payouts.length} · ${fmtSat(q.payoutTotal, 4)} ${sym()}` : "0"}</span></div>`;

  const hist = $("#di-history");
  if (hist) {
    const rows = (d?.history ?? []).map((h) => {
      const paid = h.tiers
        ? TIER_ORDER.reduce((a, t) => addSatsUi(a, h.tiers[t]?.paidSat ?? "0"), h.recipientPaid ?? "0")
        : null;
      const perTier = h.tiers
        ? TIER_ORDER
            .filter((t) => h.tiers[t] && h.tiers[t].pct > 0)
            .map((t) => `${TIER_UI[t][0]} ${h.tiers[t].pct}% → ${fmtSat(h.tiers[t].paidSat, 4)} to ${h.tiers[t].recipientCount} node${h.tiers[t].recipientCount === 1 ? "" : "s"}${h.tiers[t].held ? " (held)" : ""}`)
            .join(" · ")
        : "";
      return `<tr>
        <td class="small">${fmtTime(h.time)}${h.holdReason ? ` <span class="pill warn">held</span>` : ""}</td>
        <td class="mono">${fmtSat(h.profit ?? h.pool, 4)}</td>
        <td class="mono">${fmtSat(h.reburn, 4)}${h.extraReburn && h.extraReburn !== "0" ? `<span class="muted small"> +${fmtSat(h.extraReburn, 2)}</span>` : ""}</td>
        <td class="mono">${paid == null ? "—" : fmtSat(paid, 4)}</td>
        <td class="mono">${h.recipientCount}<span class="muted small"> of ${h.eligibleCount}</span></td>
        <td class="mono">${h.kept ? fmtSat(h.kept, 4) : "0"}</td>
        <td class="mono">${fmtSat(h.carryOut, 4)}</td>
      </tr>${perTier ? `<tr><td colspan="7" class="muted small">${perTier}</td></tr>` : ""}${
        (h.recipientDetails ?? []).filter((r) => r.pct > 0 || r.carryInSat !== "0").map((r) =>
          `<tr><td colspan="7" class="muted small" title="${esc(r.address)}">📤 ${esc(r.label || r.address)} · ${r.pct}% → ${fmtSat(r.paidSat, 4)} allocated${r.carryOutSat !== "0" ? ` · ${fmtSat(r.carryOutSat, 8)} carried` : ""}</td></tr>`).join("")}${
        h.holdReason ? `<tr><td colspan="7" class="muted small">${esc(h.holdReason)}</td></tr>` : ""}`;
    });
    hist.innerHTML = rows.join("") || `<tr><td colspan="7" class="muted">No distributions yet.</td></tr>`;
  }

  const acts = $("#di-actions");
  if (acts) {
    const rows = (d?.actions ?? []).slice(0, 25).map((a) => `<tr>
        <td class="small">${fmtTime(a.time)}</td>
        <td>${a.kind === "reburn" ? "♻️ Reburn → VHP" : `📤 ${esc(shortTx(a.to))}`}</td>
        <td class="mono">${fmtSat(a.amount, 4)}</td>
        <td><button class="link" data-tx="${esc(a.txId)}">${esc(shortTx(a.txId))}</button></td>
      </tr>`);
    acts.innerHTML = rows.join("") || `<tr><td colspan="4" class="muted">No transactions yet.</td></tr>`;
    $$("button[data-tx]", acts).forEach((b) =>
      b.addEventListener("click", () => openTx(b.dataset.tx))
    );
  }
}
