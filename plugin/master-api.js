"use strict";
function renderMasterApiView() {
  const cfg = S.appInfo.settings.masterApi || {};
  $("#view-master-api").innerHTML = `<h1>Master node API</h1>
    <p class="lead">Serve Koinos blockchain requests and producer statistics to your apps.</p>
    <div class="card"><label class="field"><span><input id="ma-enabled" type="checkbox" ${cfg.enabled ? "checked" : ""}> Enable API endpoint</span></label>
    <label class="field"><span><input id="ma-rpc-enabled" type="checkbox" ${cfg.rpcEnabled !== false ? "checked" : ""}> Allow blockchain RPC and already-signed transactions</span></label>
    <p class="hint">Wallet keys, signing and node administration remain private. RPC requests are restricted to supported blockchain methods.</p>
    <label class="field"><span>Public HTTPS address</span><input id="ma-public" type="url" spellcheck="false" value="${esc(cfg.publicUrl || "https://api.koinosai.com")}"></label>
    <label class="field"><span>Private local node RPC</span><input id="ma-rpc" type="url" spellcheck="false" value="${esc(cfg.rpcUrl || "http://127.0.0.1:8085")}"></label>
    <label class="field"><span>API port</span><input id="ma-port" type="number" value="${esc(cfg.port || 41110)}"></label>
    <label class="field"><span><input id="ma-indexes" type="checkbox" ${cfg.extendedIndexes ? "checked" : ""}> Enable account history, transaction and contract metadata services on the next node start</span></label>
    <p class="hint">These optional indexes use extra disk and memory. Save, then stop and start the node when convenient. Saving does not restart it. Existing sync snapshots do not guarantee complete historical records; keep backup RPCs until the history you need is verified.</p>
    <label class="field"><span><input id="ma-metadata-backups" type="checkbox" ${cfg.metadataFallback !== false ? "checked" : ""}> Look up missing contract metadata using backup APIs</span></label>
    <p class="hint">With the optional services enabled, use local metadata first, then Koinos Blocks and api.koinos.io. Only public contract addresses are sent for these lookups. Account history continues syncing separately.</p>
    <button id="ma-save" class="btn primary">Save API settings</button>
    <p class="hint">In Cloudflare Tunnel, publish this HTTPS hostname to the local API port shown below. The tunnel must run on this computer. This field does not create DNS or a tunnel.</p>
    <p class="hint">Keep memory-saver mode off for API use. Producer counts cover the last 28,800 finalized blocks; initial indexing may take time while the RPC is already ready.</p></div>
    <div class="card"><h2>Endpoint status</h2><pre id="ma-status" style="white-space:pre-wrap"></pre></div>
    <div class="card"><h2>Historical data</h2><p class="hint">Check a small sample of local blocks and receipts, including the last logged account-history position. This requires a node restart after installing the history safety patch. It does not start history, repair data, or prove the entire history is complete.</p>
    <button id="ma-check-history" class="btn">Check historical blocks</button><pre id="ma-history-result" style="white-space:pre-wrap"></pre></div>`;
  $("#ma-check-history").addEventListener("click", async () => {
    const button = $("#ma-check-history"), result = $("#ma-history-result");
    button.disabled = true; result.textContent = "Checking the patched local service and historical samples…";
    try {
      const value = await call("masterApi:checkHistory");
      result.textContent = `${value.samplesAvailable ? "Sampled blocks and receipts are available. Full history completeness remains unverified." : "Historical data is missing or unavailable. Keep account history paused."}\nLast logged history height: ${value.lastLoggedHeight ?? "not found"}\n` +
        value.samples.map(s => `Block ${s.height}: ${s.available ? "available" : s.error}`).join("\n");
    } catch (error) { result.textContent = error.message; }
    finally { button.disabled = false; }
  });
  $("#ma-save").addEventListener("click",async () => { try {
    const previousIndexes = Boolean(S.appInfo.settings.masterApi?.extendedIndexes);
    const saved = await call("masterApi:configure",{ enabled:$("#ma-enabled").checked, rpcEnabled:$("#ma-rpc-enabled").checked,
      publicUrl:$("#ma-public").value.trim(), extendedIndexes:$("#ma-indexes").checked, metadataFallback:$("#ma-metadata-backups").checked,
      rpcUrl:$("#ma-rpc").value.trim(), port:Number($("#ma-port").value) });
    S.appInfo.settings.masterApi = saved.config;
    toast(previousIndexes !== saved.config.extendedIndexes ? "Saved. Stop and start the node when ready to apply the index services." : "Node API settings saved","good");
    await refreshMasterApi();
  } catch(e) { toast(e.message,"bad"); } });
  void refreshMasterApi();
}
async function refreshMasterApi() {
  const el = $("#ma-status"); if (!el) return;
  try {
    const s = await call("masterApi:status"), p = s.summary, m = s.rpc?.metadata_fallback, last = m?.last_lookup;
    const metadataStatus = `Metadata backups: ${m?.enabled ? "enabled — Koinos Blocks → api.koinos.io" : "inactive"}${last ? `\nLast metadata lookup: ${last.outcome === "found" ? last.source === "local" ? "local node" : last.source + (last.cached ? " (cached)" : "") : last.outcome === "not_found" ? "no metadata found" : "unavailable — retry or use a backup RPC"}` : ""}`;
    el.textContent = `${s.listening ? "Listening" : "Stopped"}\nCloudflare service URL: ${s.rpcUrl}\nPublic RPC address: ${s.publicRpcUrl}\nRPC ready: ${s.config.rpcEnabled ? s.rpc?.ready ? "yes" : "no — waiting for a fresh Mainnet node" : "disabled"}\n${s.error || s.rpc?.error || ""}\n${metadataStatus}\nAccount history completeness must be checked separately.\nProducer feed: ${s.producerUrl}\n${p ? `Indexed ${p.indexed_height} / ${p.finalized_height} finalized · ${p.total_blocks} blocks\nProducer data ready: ${p.available ? "yes" : "no"}\nChain ID: ${p.chain_id}\nUpdated: ${fmtTime(p.updated_at)}` : "Producer index is starting."}`;
  } catch(e) { el.textContent = e.message; }
}
