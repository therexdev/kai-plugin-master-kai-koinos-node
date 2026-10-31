"use strict";

const { Provider } = require("koilib");

const MAINNET_RPC_URLS = Object.freeze([
  "https://api.koinosai.com",
  "https://api.koinosblocks.com",
  "https://api.koinos.io",
]);
const RPC_TIMEOUT_MS = 12000;

function uniqueUrls(urls) {
  const seen = new Set();
  return urls.filter(url => {
    let key;
    try { key = new URL(url).href; } catch { key = url; }
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function rpcUrlsForNetwork(network, custom = "") {
  const primary = String(custom || "").trim();
  const hasCustom = /^https?:\/\//.test(primary);
  const defaults = network.rpcUrls.length ? network.rpcUrls : hasCustom ? [] : [network.localRpcUrl];
  return uniqueUrls([...(hasCustom ? [primary] : []), ...defaults].filter(Boolean));
}

// Retain koilib's contract-error formatting so wallet/transaction callers still
// receive the original chain rejection and logs.
function rejection(error) {
  if (!error.data) return new Error(error.message || "RPC request rejected");
  let data;
  try { data = JSON.parse(error.data); } catch { data = { data: error.data }; }
  return new Error(JSON.stringify({ ...(error.message && { error: error.message }), ...data }));
}

class FailoverProvider extends Provider {
  constructor(urls, { fetchImpl = fetch, timeoutMs = RPC_TIMEOUT_MS } = {}) {
    super(uniqueUrls(typeof urls === "string" ? [urls] : urls));
    this.fetchImpl = fetchImpl;
    this.timeoutMs = timeoutMs;
  }

  async call(method, params) {
    // Snapshot once: concurrent calls have independent retry budgets and always
    // try the configured primary first. A signed submission is serialized only
    // once, so a transport retry cannot create/sign a second transaction.
    const urls = [...this.rpcNodes];
    const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method, params });
    let lastError = new Error("No Koinos RPC endpoint configured");
    for (let i = 0; i < urls.length; i++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      let reply;
      try {
        const response = await this.fetchImpl(urls[i], {
          method: "POST", headers: { "Content-Type": "application/json" },
          body, signal: controller.signal, redirect: "error",
        });
        if (!response.ok) {
          await response.body?.cancel();
          throw new Error(`Koinos RPC HTTP ${response.status}`);
        }
        reply = await response.json();
        if (!reply || typeof reply !== "object" || (reply.result === undefined && !reply.error)) {
          throw new Error("Invalid Koinos RPC response");
        }
      } catch (error) {
        lastError = controller.signal.aborted ? new Error("Koinos RPC timed out") : error;
        continue;
      } finally {
        clearTimeout(timer);
      }
      if (reply.error) {
        lastError = rejection(reply.error);
        // An RPC may omit account-history or another service. Contract/chain
        // rejections are final; changing providers cannot fix a rejected spend.
        if (reply.error.code === -32601) continue;
        throw lastError;
      }
      this.currentNodeId = i;
      return reply.result;
    }
    throw lastError;
  }
}

function createProvider(urls, options) { return new FailoverProvider(urls, options); }

module.exports = { MAINNET_RPC_URLS, rpcUrlsForNetwork, createProvider };
