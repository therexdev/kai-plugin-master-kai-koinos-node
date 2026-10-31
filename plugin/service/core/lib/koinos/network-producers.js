"use strict";

// Public explorer's documented endpoint and rules, verified against
// interfecto/koinos-token-tracker aa11ddfc19adb9ef0afa0e244b363706fcb732fd:
// internal/api/handlers.go, internal/store/sqlite.go, internal/api/explorer.html.
const PRODUCERS_URL = "https://api.koinosscan.com/v1/token-tracker/producers";
const WINDOW_BLOCKS = 28800;
const TWO_HOURS = 2 * 60 * 60 * 1000;
const TTL_MS = 60_000;
const MAX_STALE_MS = 10 * 60_000;

function summarizeProducers(data, now = Date.now()) {
  if (!data || !Array.isArray(data.producers) || data.producers.length > 10000 ||
      !Number.isSafeInteger(data.total_blocks) || data.total_blocks < 0 || data.total_blocks > WINDOW_BLOCKS) {
    throw new Error("Invalid producer response");
  }
  let active = 0, recent = 0, blocks = 0;
  const addresses = new Set();
  for (const p of data.producers) {
    if (!p || typeof p.address !== "string" || !/^[1-9A-HJ-NP-Za-km-z]{25,40}$/.test(p.address) || addresses.has(p.address) ||
        !Number.isSafeInteger(p.blocks_24h) || p.blocks_24h < 0 || p.blocks_24h > WINDOW_BLOCKS ||
        !Number.isSafeInteger(p.last_block_time) || p.last_block_time < 0 || p.last_block_time > now + 300_000 ||
        (p.blocks_24h > 0 && p.last_block_time === 0)) {
      throw new Error("Invalid producer entry");
    }
    addresses.add(p.address);
    blocks += p.blocks_24h;
    if (p.blocks_24h > 0) active++;
    if (p.last_block_time > 0 && now - p.last_block_time < TWO_HOURS) recent++;
  }
  if (blocks !== data.total_blocks) throw new Error("Incomplete producer response");
  return {
    activeApprox24h: active,
    recent2h: recent,
    totalTracked: addresses.size,
    inactiveApprox24h: addresses.size - active,
    windowBlocks: WINDOW_BLOCKS,
    totalBlocks: blocks,
  };
}

// Small, fixed, public GET. No wallet address, credentials or telemetry sent.
async function fetchProducers({ fetchImpl = fetch, signal } = {}) {
  const response = await fetchImpl(PRODUCERS_URL, {
    signal, redirect: "error", headers: { Accept: "application/json" },
  });
  if (!response.ok || Number(response.headers.get("content-length")) > 2 * 1024 * 1024) {
    await response.body?.cancel().catch(() => {});
    throw new Error(!response.ok ? `Producer API returned HTTP ${response.status}` : "Producer response too large");
  }
  const reader = response.body.getReader();
  const chunks = [];
  let bytes = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > 2 * 1024 * 1024) throw new Error("Producer response too large");
      chunks.push(Buffer.from(value));
    }
  } finally { await reader.cancel().catch(() => {}); }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function createProducerCache({ fetchImpl = fetch, now = Date.now, ttlMs = TTL_MS, maxStaleMs = MAX_STALE_MS, timeoutMs = 10000 } = {}) {
  let cached = null, fetchedAt = null, attemptedAt = null, pending = null, error = null, controller = null, stopped = false;
  function view() {
    const stale = error != null || (fetchedAt != null && now() - fetchedAt >= ttlMs);
    const available = cached != null && now() - fetchedAt <= maxStaleMs;
    return {
      network: "mainnet", source: "KoinosScan", sourceUrl: PRODUCERS_URL,
      available, stale: available && stale, fetchedAt,
      ...(available ? summarizeProducers(cached, fetchedAt) : {}),
      error: error || (!available ? "Producer data unavailable" : null),
    };
  }
  async function get(network = "mainnet") {
    if (network !== "mainnet") return { network, available: false, unsupported: true, error: "KoinosScan reports mainnet producers only" };
    if (stopped) return { network, available: false, error: "Producer reader stopped" };
    if (pending) return pending;
    if (attemptedAt != null && now() - attemptedAt < ttlMs) return view();
    attemptedAt = now();
    controller = new AbortController();
    const timeout = setTimeout(() => controller?.abort(), timeoutMs);
    pending = (async () => {
      try {
        const data = await fetchProducers({ fetchImpl, signal: controller.signal });
        summarizeProducers(data, now());
        if (!stopped) { cached = data; fetchedAt = now(); error = null; }
      } catch {
        error = "Unable to refresh producer data";
      } finally { clearTimeout(timeout); }
      return view();
    })().finally(() => { pending = null; controller = null; });
    return pending;
  }
  return { get, stop() { stopped = true; controller?.abort(); cached = null; } };
}

module.exports = { PRODUCERS_URL, WINDOW_BLOCKS, TWO_HOURS, summarizeProducers, fetchProducers, createProducerCache };
