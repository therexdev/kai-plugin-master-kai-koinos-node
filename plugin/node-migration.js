"use strict";
// Renderer-only review and progress for the plugin-owned native migration.
// Source paths and Docker operations are selected and checked by the service.
(function (root) {
  const phases = new Set(["idle", "running", "complete", "failed", "cancelled"]);
  const errorText = error => String(error?.message || error || "Node migration is unavailable.").replace(/^Error invoking remote method '[^']+': (?:Error: )?/, "").slice(0, 1200);
  function bytes(value) {
    let n = Number(value); if (!Number.isFinite(n) || n < 0) return "Unknown size";
    const units = ["B", "KB", "MB", "GB", "TB"]; let i = 0;
    while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
    return `${n.toLocaleString(undefined, { maximumFractionDigits: i ? 1 : 0 })} ${units[i]}`;
  }
  function createController({ call, render = () => {}, onComplete = () => {}, setTimer = setTimeout, clearTimer = clearTimeout }) {
    const state = { open: false, loading: false, starting: false, pausing: false, acknowledged: false, reviewed: false, preview: null, job: { phase: "idle" }, error: "", external: false };
    let timer = null, polling = false, epoch = 0, serial = 0, disposed = false, completed = false;
    const busy = () => state.starting || state.pausing || state.job.phase === "running";
    const snapshot = () => structuredClone(state);
    const view = () => ({ busy: busy(), resumable: state.preview?.resumable === true || state.job.resumable === true,
      canStart: state.open && !busy() && !state.loading && state.reviewed && state.job.phase !== "complete" && state.preview?.available === true && typeof state.preview.previewId === "string" && state.acknowledged,
      hasTransfer: state.job.phase !== "idle" || state.job.resumable === true });
    const emit = () => { if (!disposed) render(snapshot(), view()); };
    function schedule() { if (timer !== null) clearTimer(timer); timer = null; if (!disposed && (state.open || state.job.phase === "running")) timer = setTimer(() => { timer = null; void poll(); }, state.job.phase === "running" ? 750 : 5000); }
    function accept(job) {
      if (!job || !phases.has(job.phase)) throw Error("The node migration status could not be read.");
      const previous = state.job.phase; state.job = job;
      if (job.preview && (job.phase === "running" || !state.preview)) state.preview = job.preview;
      if (job.phase !== "running") state.pausing = false;
      if (job.phase === "complete" && !completed) { completed = true; onComplete(job.result || {}); }
      if (previous === "running" && ["failed", "cancelled"].includes(job.phase)) { state.acknowledged = false; state.reviewed = false; state.preview = null; }
    }
    async function poll() {
      if (polling || disposed || state.starting) return;
      polling = true; const expected = ++serial;
      try { const job = await call("node:profileMigrationStatus"); if (!disposed && expected === serial) accept(job); }
      catch (error) { if (!disposed && expected === serial && (state.open || state.job.phase === "running")) state.error = errorText(error); }
      finally { polling = false; emit(); schedule(); }
    }
    async function preview() {
      const expected = ++epoch; state.loading = true; state.error = ""; state.acknowledged = false; state.reviewed = false; emit();
      try {
        const value = await call("node:profileMigrationPreview");
        if (!disposed && expected === epoch) { state.preview = value; state.reviewed = true; }
      } catch (error) { if (!disposed && expected === epoch) state.error = errorText(error); }
      finally { if (!disposed && expected === epoch) { state.loading = false; emit(); schedule(); } }
    }
    async function open() {
      if (state.open || disposed) return; const expected = ++epoch; ++serial; state.open = true; state.error = ""; state.acknowledged = false; state.reviewed = false; state.loading = true; emit();
      try { const job = await call("node:profileMigrationStatus"); if (disposed || expected !== epoch || !state.open) return; accept(job); }
      catch (error) { if (disposed || expected !== epoch || !state.open) return; state.error = errorText(error); }
      state.loading = false;
      if (state.job.phase !== "running" && state.job.phase !== "complete") await preview();
      emit(); schedule();
    }
    function close() { if (busy()) return false; state.open = false; state.loading = false; epoch++; emit(); schedule(); return true; }
    function acknowledge(value) { if (busy() || state.loading) return; state.acknowledged = value === true; emit(); }
    async function start() {
      if (!view().canStart) return;
      const previewId = state.preview.previewId; ++serial; state.starting = true; state.error = ""; completed = false; emit();
      try {
        const job = await call("node:profileMigrationStart", { previewId });
        accept(job);
        if (job.cancelled && job.phase === "idle") state.error = "Migration was not started. No additional files were transferred.";
      } catch (error) {
        state.error = errorText(error);
        // An IPC result can be lost after starting. Keep controls locked until
        // the native state says whether a transfer is actually running.
        try { accept(await call("node:profileMigrationStatus")); }
        catch { state.job = { phase: "running", preview: state.preview, unconfirmed: true }; state.error += " Checking whether migration started…"; }
      } finally { state.starting = false; emit(); schedule(); }
    }
    async function pause() {
      if (state.starting || state.pausing || state.job.phase !== "running") return;
      ++serial; state.pausing = true; state.error = ""; emit();
      try { accept(await call("node:profileMigrationCancel")); }
      catch (error) { state.pausing = false; state.error = errorText(error); }
      finally { emit(); schedule(); }
    }
    return { open, close, start, pause, preview, acknowledge, poll, snapshot, view,
      observe(node) { state.external = node?.control?.reason === "managed-elsewhere"; emit(); },
      dispose() { disposed = true; epoch++; if (timer !== null) clearTimer(timer); } };
  }
  function mount(document, invoke) {
    const dialog = document.getElementById("node-migration-dialog"); if (!dialog) return null;
    const $ = id => document.getElementById(`node-migration-${id}`);
    const text = (id, value) => { const node = $(id), next = String(value ?? ""); if (node.textContent !== next) node.textContent = next; };
    let focusBefore = null;
    const controller = createController({ call: async (channel, payload) => { const reply = await invoke(channel, payload); if (!reply?.ok) throw Error(reply?.error || "Node migration is unavailable."); return reply.data; },
      onComplete: result => document.dispatchEvent(new root.CustomEvent("kai-node-migration-complete", { detail: result })),
      render(state, view) {
        if (state.open && !dialog.open) { focusBefore = document.activeElement; dialog.showModal(); }
        if (!state.open && dialog.open) { dialog.close(); if (focusBefore?.isConnected) focusBefore.focus(); }
        renderEntryPoints(state, view);
        if (!state.open) return;
        const info = state.preview || state.job.preview, job = state.job, progress = job.progress || {};
        text("title", job.phase === "complete" ? "Node migration complete" : view.resumable ? "Resume Master node migration" : "Migrate from Master Koinos AI Node");
        text("intro", job.phase === "complete" ? "The chain data is now owned by this plugin. Start the node when you are ready." : "Move chain data from Master Koinos AI Node into this plugin so it can manage your node.");
        text("source", info?.source?.basedir || info?.source?.root || (state.loading ? "Checking the Master node…" : "No Master node source was identified."));
        text("destination", info?.destination?.basedir || info?.destination?.root || (state.loading ? "Checking the plugin location…" : "Plugin location unavailable."));
        text("network", info?.network || (state.loading ? "Checking…" : "Not identified"));
        text("size", info ? `${bytes(info.bytes)}${Number.isSafeInteger(info.files) ? ` · ${info.files.toLocaleString()} files` : ""}` : state.loading ? "Checking chain files…" : "Chain size unavailable.");
        text("method", info?.mode === "move" ? "Same drive: chain data can be moved without keeping a second full copy." : info?.mode === "copy-delete" ? "Different drives: each verified file is copied, then removed from the old location. Completed files stay transferred if you pause." : "The migration checks the source, destination and available space before transferring.");
        text("detail", info?.detail || ""); $("detail").hidden = !info?.detail;
        text("wallet-note", info?.walletNotice || "This transfers chain data only. This plugin keeps its current wallet. Wallets, private production keys, KOIN and VHP are not transferred. If you generated a new wallet, transfer your KOIN and VHP manually before setting up production.");
        $("acknowledge").checked = state.acknowledged; $("acknowledge").disabled = view.busy || state.loading;
        $("review").hidden = job.phase === "complete" || view.busy;
        $("close").disabled = view.busy;
        $("dismiss").disabled = state.starting || state.pausing;
        text("dismiss", state.pausing ? "Pausing…" : job.phase === "running" ? "Pause migration" : "Close");
        $("submit").hidden = job.phase === "complete" || job.phase === "running";
        $("submit").disabled = !view.canStart;
        text("submit", state.starting ? "Confirming…" : view.resumable ? "Resume migration" : "Stop Master node and migrate");
        $("recheck").hidden = view.busy || state.loading || job.phase === "complete" || !(job.resumable || ["failed", "cancelled"].includes(job.phase) || info?.available === false || !!state.error);
        text("recheck", view.resumable ? "Review transfer to resume" : "Check again");
        $("progress-wrap").hidden = !view.busy;
        const total = Number(progress.totalBytes) || 0, done = Number(progress.completedBytes) || 0;
        if (total > 0) { $("progress").max = total; $("progress").value = Math.min(total, done); text("percent", `${Math.min(100, Math.floor(done / total * 100))}%`); }
        else { $("progress").removeAttribute("value"); text("percent", ""); }
        text("progress-detail", state.pausing ? "Pausing safely after the current file…" : progress.detail || (state.starting ? "Waiting for migration confirmation…" : "Preparing the transfer…"));
        text("progress-count", Number.isSafeInteger(progress.totalFiles) ? `${progress.completedFiles || 0} / ${progress.totalFiles} files · ${bytes(done)}${total ? ` / ${bytes(total)}` : ""}` : "");
        const terminal = ["complete", "failed", "cancelled"].includes(job.phase);
        $("outcome").hidden = !terminal; $("outcome").dataset.phase = job.phase;
        text("outcome-title", { complete: "Chain data transferred", failed: "Migration needs attention", cancelled: "Migration paused" }[job.phase] || "");
        text("outcome-detail", job.result?.summary || (job.phase === "complete" ? "Migration is complete. The node is stopped and block production is off." : job.resumable ? "Completed files stay transferred. Resume migration before starting either node." : "The transfer did not finish. Review the details before trying again."));
        text("outcome-warnings", Array.isArray(job.result?.warnings) ? job.result.warnings.join("\n") : ""); $("outcome-warnings").hidden = !job.result?.warnings?.length;
        text("error", state.error || job.error || ""); $("error").hidden = !state.error && !job.error;
      }
    });
    function renderEntryPoints(state, view) {
      const pending = view.hasTransfer && state.job.phase !== "complete";
      for (const name of ["node", "dashboard", "settings"]) {
        const host = document.getElementById(`view-${name}`); if (!host) continue;
        let card = document.getElementById(`node-migration-entry-${name}`);
        const show = name === "settings" || pending || (name === "dashboard" && state.external);
        if (!show) { card?.remove(); continue; }
        if (!card) {
          card = document.createElement("div"); card.id = `node-migration-entry-${name}`; card.className = name === "settings" ? "card node-migration-entry" : "banner warn node-migration-entry";
          const label = document.createElement("p"), button = document.createElement("button"); label.className = "node-migration-entry-detail"; button.className = "btn"; button.type = "button"; button.dataset.openNodeMigration = "";
          card.append(label, button); const lead = host.querySelector(":scope > .lead"); if (name === "settings") host.append(card); else if (lead) lead.after(card); else host.prepend(card);
        }
        card.querySelector("p").textContent = state.job.phase === "running" ? "Node migration is running. Keep KAI open or in the tray until it finishes." : pending ? "Node migration needs to finish before either node can start. Completed files stay transferred." : "Transfer chain data from Master Koinos AI Node into this plugin. Wallets, production keys and funds stay separate.";
        card.querySelector("button").textContent = state.job.phase === "running" ? "View migration" : pending ? "Resume migration" : "Migrate from Master Koinos AI Node";
      }
      const banner = document.querySelector("#n-health .banner");
      if (state.external && banner && !banner.querySelector("[data-open-node-migration]")) { const row = document.createElement("div"), button = document.createElement("button"); row.className = "node-migration-warning-action"; button.className = "btn"; button.type = "button"; button.dataset.openNodeMigration = ""; button.textContent = "Migrate from Master Koinos AI Node"; row.append(button); banner.append(row); }
    }
    document.addEventListener("click", event => { if (event.target.closest?.("[data-open-node-migration]")) void controller.open(); });
    $("acknowledge").addEventListener("change", event => controller.acknowledge(event.target.checked));
    $("form").addEventListener("submit", event => { event.preventDefault(); void controller.start(); });
    $("close").addEventListener("click", () => controller.close());
    $("dismiss").addEventListener("click", () => controller.view().busy ? void controller.pause() : controller.close());
    $("recheck").addEventListener("click", () => void controller.preview());
    dialog.addEventListener("cancel", event => { event.preventDefault(); controller.close(); });
    dialog.addEventListener("close", () => { if (controller.snapshot().open && !controller.close()) dialog.showModal(); });
    void controller.poll();
    return controller;
  }
  if (typeof module === "object" && module.exports) module.exports = { createController, mount, bytes };
  if (root.document && root.koinos?.invoke) {
    const controller = mount(root.document, (channel, payload) => root.koinos.invoke(channel, payload));
    root.KaiNodeMigration = controller;
    if (controller) {
      for (const [name, getNode] of [["patchNodeView", () => S.node], ["patchDashboardView", () => S.dashboard?.node]]) {
        const original = root[name]; if (typeof original === "function") root[name] = function (...args) { const result = original.apply(this, args); controller.observe(getNode()); return result; };
      }
      root.document.addEventListener("kai-node-migration-complete", () => { void refreshNode(); void refreshDashboard(); });
      root.addEventListener("pagehide", () => controller.dispose());
    }
  }
})(typeof window === "object" ? window : globalThis);
