"use strict";
const { VERSION } = require("./block-store-runtime");
const { rpc } = require("./master-api");
const MAINNET = "EiBZK_GGVP0H_fXVAM3j6EAuz3-B-l3ejxRSewi7qIBfSA==";

// Explicit local diagnostic only. No backfill, resets, writes, public API
// requests or automatic history start. Sampling never certifies completeness.
async function checkHistory({ nodeMgr, call = (method, params, signal) => rpc("http://127.0.0.1:8085", method, params, { signal }), now = Date.now }) {
  const version = await nodeMgr._compose("mainnet", ["exec", "-T", "block_store", "/tmp/kai_koinos_block_store", "--version"], { timeout: 15000 });
  if (!version.ok || !version.stdout.includes(VERSION)) {
    throw new Error("The history safety patch is not running yet. Keep optional indexes off, then Stop and Start the node in this version of Master KAI Koinos Node before checking historical blocks.");
  }
  const chain = await call("chain.get_chain_id");
  if (chain.chain_id !== MAINNET) throw new Error("History check requires the local Mainnet node.");
  const head = await call("chain.get_head_info");
  const height = Number(head.head_topology?.height), finalized = Number(head.last_irreversible_block), headId = head.head_topology?.id;
  const age = now() - Number(head.head_block_time);
  if (!Number.isSafeInteger(height) || !Number.isSafeInteger(finalized) || finalized < 1 || finalized > height || typeof headId !== "string" || !headId || !Number.isFinite(age) || age < -300000 || age > 90000) throw new Error("Wait for the local Mainnet node to catch up before checking history.");
  const log = await nodeMgr.logs("mainnet", "account_history", 200).catch(() => "");
  const progress = [...String(log).matchAll(/Sync progress - Height:\s*(\d+)/g)].at(-1);
  const lastLoggedHeight = progress ? Number(progress[1]) : null;
  // Include both ends of the next upstream 1,000-block fetch when a saved log
  // checkpoint is available. It is an observation, not an exact DB cursor.
  const heights = [...new Set([1, 1000000, 2000000, Math.floor(finalized/2), finalized,
    ...(Number.isSafeInteger(lastLoggedHeight) ? [lastLoggedHeight, lastLoggedHeight+1, lastLoggedHeight+1000] : [])])]
    .filter(h => h >= 1 && h <= finalized).sort((a,b) => a-b);
  const samples = [];
  const signal = AbortSignal.timeout(45000);
  for (const sampleHeight of heights) {
    signal.throwIfAborted();
    try {
      const data = await call("block_store.get_blocks_by_height", { head_block_id: headId, ancestor_start_height: String(sampleHeight), num_blocks: 1, return_block: true, return_receipt: true }, signal);
      const item = data.block_items?.[0];
      if (data.block_items?.length !== 1 || Number(item?.block_height) !== sampleHeight || Number(item?.block?.header?.height) !== sampleHeight || !item?.block?.id || item.block.id !== item.block_id || !item.receipt || item.receipt.id !== item.block_id) {
        throw new Error("The requested block or its receipt is missing or inconsistent.");
      }
      samples.push({ height: sampleHeight, available: true });
    } catch (error) {
      samples.push({ height: sampleHeight, available: false, error: String(error.message).slice(0,350) });
      break; // One failure is enough to keep history paused; do not hammer it.
    }
  }
  return { checkedAt: now(), patched: true, finalizedHeight: finalized, lastLoggedHeight,
    samples, samplesAvailable: samples.length === heights.length && samples.every(s => s.available), complete: false };
}
module.exports = { checkHistory };
