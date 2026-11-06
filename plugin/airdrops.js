"use strict";
// All amounts and payment records come from the native service. Renderer
// previews cannot authorize a different payload or supply transaction IDs.
let airdropPreview = null, airdropState = null, airdropRequest = false;
const airdropAmount = sats => {
  const n = BigInt(sats || "0");
  return `${n / 100000000n}${n % 100000000n ? "." + (n % 100000000n).toString().padStart(8, "0").replace(/0+$/, "") : ""}`;
};
function airdropInput() { return { token: $("#ad-token").value, mode: $("#ad-mode").value, total: $("#ad-total").value, text: $("#ad-list").value }; }
async function airdropAction(fn) {
  try { await fn(); } catch (error) { toast(error.message, "bad", 10000); }
}
function renderAirdropsView() {
  $("#view-airdrops").innerHTML = KaiI18n.html`
    <h1>Airdrops</h1>
    <p class="lead">Send KOIN or VHP from this Node wallet to a list of wallets.</p>
    <div class="card">
      <div class="grid-2">
        <label class="field"><span>Token</span><select id="ad-token"><option value="koin">KOIN</option><option value="vhp">VHP</option></select></label>
        <label class="field"><span>Allocation</span><select id="ad-mode"><option value="equal">Split a total equally</option><option value="amounts">Amount for each wallet</option></select></label>
      </div>
      <label class="field" id="ad-total-field"><span>Total to split</span><input id="ad-total" inputmode="decimal" type="text" placeholder="1000"></label>
      <label class="field"><span>Wallet list</span><textarea id="ad-list" rows="9" spellcheck="false" style="width:100%;font-family:monospace" aria-describedby="ad-list-help"></textarea></label>
      <p class="hint" id="ad-list-help">Equal split: paste addresses separated by lines, commas or tabs. Per-wallet amounts: paste ADDRESS,AMOUNT or two spreadsheet columns, one wallet per line. An ADDRESS,TOKEN-AMOUNT header is optional. Use a decimal point and no thousands separators. Maximum 2,000 wallets.</p>
      <p class="hint">Equal splits allocate any remaining 0.00000001 units to the first wallets in list order. Duplicate and invalid addresses must be corrected before sending.</p>
      <div class="row"><button id="ad-preview" class="btn primary">Preview airdrop</button><button id="ad-save" class="btn" disabled>Save reviewed list</button></div>
      <div id="ad-preview-result" style="margin-top:16px"></div>
    </div>
    <div class="card">
      <h2>Saved airdrop</h2>
      <p class="hint">Pause distribution and disable reward returns before sending. Keep liquid KOIN for mana, including for VHP transfers. Sending VHP reduces this wallet's mining power. Password and native approval are required each time you start or resume.</p>
      <div class="row"><button id="ad-run" class="btn primary" disabled>Start / resume airdrop</button><button id="ad-pause" class="btn" disabled>Pause airdrop</button><button id="ad-check" class="btn" disabled>Check uncertain transaction</button><button id="ad-discard" class="btn" disabled>Discard unsent draft</button><button id="ad-report" class="btn" disabled>Export payment record CSV</button></div>
      <div id="ad-progress" role="status" aria-live="polite" style="margin-top:16px"></div>
      <div id="ad-payments"></div>
    </div>
    <div class="card"><h2>Previous airdrops</h2><div id="ad-history"></div></div>`;
  const invalidate = () => { airdropPreview = null; $("#ad-save").disabled = true; $("#ad-preview-result").textContent = ""; $("#ad-total-field").hidden = $("#ad-mode").value !== "equal"; };
  for (const id of ["#ad-token", "#ad-mode", "#ad-total", "#ad-list"]) $(id).addEventListener("input", invalidate);
  $("#ad-preview").onclick = () => airdropAction(async () => {
    const input = airdropInput(), plan = await call("airdrop:preview", input);
    if (JSON.stringify(input) !== JSON.stringify(airdropInput())) return;
    airdropPreview = { ...input, fingerprint: plan.fingerprint };
    $("#ad-preview-result").innerHTML = KaiI18n.html`<p><b>${esc(plan.network)} · ${esc(plan.token.toUpperCase())} · ${plan.rows.length} wallets · ${esc(airdropAmount(plan.totalSat))} total</b></p><p class="mono">${esc(plan.wallet)}</p>` + airdropTable(plan.rows);
    $("#ad-save").disabled = false;
  });
  $("#ad-save").onclick = () => airdropAction(async () => {
    if (!airdropPreview) return;
    $("#ad-save").disabled = true;
    try { await call("airdrop:create", airdropPreview); invalidate(); await refreshAirdrops(); }
    finally { $("#ad-save").disabled = !airdropPreview; }
  });
  $("#ad-run").onclick = () => airdropAction(async () => {
    const id = airdropState?.job?.id;
    if (!id || airdropRequest) return;
    airdropRequest = true; paintAirdrops();
    try { await call("airdrop:run", { id }); }
    finally { airdropRequest = false; await refreshAirdrops(); }
  });
  $("#ad-pause").onclick = () => airdropAction(async () => { await call("airdrop:pause"); await refreshAirdrops(); });
  $("#ad-check").onclick = () => airdropAction(async () => {
    await call("airdrop:reconcile", { id: airdropState.job.id }); await refreshAirdrops();
    if (airdropState.job.rows.some(r => ["unknown", "submitting"].includes(r.status))) toast("Still awaiting a verified transaction outcome. No payment was resent.", "warn", 10000);
  });
  $("#ad-discard").onclick = () => airdropAction(async () => { await call("airdrop:discard", { id: airdropState.job.id }); await refreshAirdrops(); });
  $("#ad-report").onclick = () => copyAirdropReport(airdropState?.job?.id);
}
function airdropTable(rows) {
  return KaiI18n.html`<div style="overflow:auto;max-height:420px"><table><thead><tr><th>#</th><th>Address</th><th>Amount</th><th>Status</th><th>Transaction ID</th></tr></thead><tbody>${rows.map((row, i) => `<tr><td>${i + 1}</td><td class="mono">${esc(row.address)}</td><td>${esc(airdropAmount(row.amountSat))}</td><td>${esc(KaiI18n.t(({ pending: "Pending", submitting: "Sending", unknown: "Unknown result", sent: "Sent" })[row.status] || "Preview"))}</td><td class="mono" style="overflow-wrap:anywhere">${esc(row.txId || "—")}</td></tr>`).join("")}</tbody></table></div>`;
}
async function copyAirdropReport(id) {
  if (!id) return;
  await airdropAction(async () => { const result = await window.kai.call("node.exportAirdrop", { id }); if (result.saved) toast("Payment record CSV saved", "good"); });
}
async function refreshAirdrops() {
  try { airdropState = await call("airdrop:status"); paintAirdrops(); } catch (error) { toast(error.message, "bad"); }
}
function paintAirdrops() {
  if (!$("#ad-progress") || !airdropState) return;
  const { job, running, pauseRequested, history } = airdropState;
  const unknown = job?.rows.some(row => ["unknown", "submitting"].includes(row.status));
  const sent = job?.rows.filter(row => row.status === "sent").length || 0;
  $("#ad-run").disabled = !job || running || airdropRequest || unknown || sent === job.rows.length;
  $("#ad-pause").disabled = !running || pauseRequested;
  $("#ad-check").disabled = !job || running || airdropRequest || !unknown;
  $("#ad-discard").disabled = !job || running || airdropRequest || job.rows.some(row => row.status !== "pending" || row.attempts.length);
  $("#ad-report").disabled = !job;
  const statusText = running ? (pauseRequested ? "Pausing after current transaction" : "Sending") : unknown ? "Transaction check required; no automatic resend" : job && sent === job.rows.length ? "Complete" : "Ready / paused";
  KaiI18n.setText($("#ad-progress"), job ? KaiI18n.message(["", " · ", " · ", " · ", "/", " · ", "", ""], KaiI18n.literal(job.network), KaiI18n.literal(job.token.toUpperCase()), KaiI18n.literal(airdropAmount(job.totalSat)), sent, job.rows.length, KaiI18n.message([statusText]), KaiI18n.literal(job.error ? " · " + job.error : "")) : "No saved airdrop yet.");
  $("#ad-payments").innerHTML = job ? KaiI18n.html`<p class="mono">${esc(job.wallet)}</p>` + airdropTable(job.rows) : "";
  $("#ad-history").innerHTML = (history || []).slice().reverse().map(j => KaiI18n.html`<p>${esc(j.network)} · ${esc(j.token.toUpperCase())} · ${esc(airdropAmount(j.totalSat))} · ${j.recipientCount} wallets <button class="btn" data-airdrop-report="${esc(j.id)}">Export payment record CSV</button></p>`).join("");
  $$("[data-airdrop-report]").forEach(button => { button.onclick = () => copyAirdropReport(button.dataset.airdropReport); });
}
