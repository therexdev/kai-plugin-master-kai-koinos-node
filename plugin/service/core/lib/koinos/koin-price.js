"use strict";

/*
 * What the node is worth, and what it earns, in dollars.
 *
 * The price comes from the Uniswap v4 vKOIN/USDT pool — the same pool the
 * funding route already swaps through, and the only meaningful vKOIN
 * liquidity. vKOIN is KOIN bridged 1:1, so its price IS KOIN's price.
 *
 * Two things about that pool govern everything here, and both are stated in
 * the numbers this module returns rather than hidden behind a clean figure:
 *
 *   A QUOTE IS NOT A PRICE. Two things separate what the pool quotes from what
 *   every price site reports, and both have to be handled or the dashboard
 *   disagrees with the rest of the world:
 *
 *     THE FEE. This pool's tier is 1%, taken out of the input. Buying with
 *     `x` USDT swaps only `x * (1 - fee)`, so the quote implies a price of
 *     mid / (1 - fee) — about 1% high — no matter how small the trade. No
 *     probe size escapes it; it is removed arithmetically instead, which is
 *     exact rather than approximate.
 *
 *     PRICE IMPACT. The pool is thin, about $32k, so the probe moves it. This
 *     scales with size, so the probe is small: 10 USDT costs roughly 0.06%,
 *     where 100 USDT cost 0.6%.
 *
 *   Field-checked. With a 100 USDT probe and the fee left in, the dashboard
 *   read $0.0091 while every other venue said $0.008928 — 1.93% high, which
 *   is 1% fee plus 0.9% impact almost exactly. Both figures are kept: the
 *   market price is what a person means by "the price", and the executable
 *   one is what they would actually pay.
 *
 *   IT IS A DOLLAR VALUE OF A VOLATILE ASSET. Everything downstream is an
 *   estimate, and the yearly figure is an estimate built on an estimate: a
 *   recent daily rate, annualised, at today's price. It is not a forecast and
 *   the UI must not let it read as one.
 *
 * The split here is deliberate: every calculation is a pure function of
 * numbers that arrive as arguments, so the arithmetic — decimals, what counts
 * as value, what happens with no history — is testable without a network.
 * Only `fetchUsdPerKoin` touches Ethereum.
 */

const SATS = 100000000;      // KOIN and vKOIN both carry 8 decimals
const USDT_UNITS = 1000000;  // USDT carries 6

// Small enough that its own price impact stays negligible in a ~$32k pool
// (~0.06%), large enough not to be dust the pool rounds away. It was 100,
// which cost 0.6% of impact and visibly disagreed with every price site.
const DEFAULT_PROBE_USDT = 10;

// A price is re-fetched at most this often. The dashboard polls every few
// seconds; an Ethereum RPC round trip on every poll would be rude to the
// endpoint and pointless — this price does not move meaningfully in a minute.
const PRICE_TTL_MS = 5 * 60 * 1000;

// Past this, a cached price stops being "the price" and starts being a
// number from an hour ago that happens to still be on screen.
const PRICE_STALE_MS = 60 * 60 * 1000;

/**
 * USD per KOIN, from one pool quote.
 *
 * usdtSats: what went in (6-dec). vkoinSats: what came out (8-dec).
 * Returns null rather than Infinity or NaN when the quote is empty — a
 * missing price must be absent, never a number that renders as $0.00 or "∞".
 */
function computeUsdPerKoin({ usdtSats, vkoinSats }) {
  const usdt = Number(usdtSats) / USDT_UNITS;
  const koin = Number(vkoinSats) / SATS;
  if (!(usdt > 0) || !(koin > 0)) return null;
  return usdt / koin;
}

/**
 * Take the pool's fee back out of a buy quote.
 *
 * Uniswap charges the fee on the INPUT: paying `x` swaps `x * (1 - f)`, so
 * `quoted = mid / (1 - f)` and `mid = quoted * (1 - f)`. Exact for the fee
 * component — the only residue is price impact, which is why the probe is
 * small rather than why this is approximate.
 *
 * v4 fees are in hundredths of a basis point: 10000 = 1%.
 */
function removePoolFee(quotedUsdPerKoin, feeHundredthsBips) {
  if (quotedUsdPerKoin == null) return null;
  const f = Number(feeHundredthsBips) / 1e6;
  if (!(f >= 0) || f >= 1) return quotedUsdPerKoin;
  return quotedUsdPerKoin * (1 - f);
}

/** KOIN satoshis → dollars. Null in, null out. */
function satsToUsd(sats, usdPerKoin) {
  if (sats == null || usdPerKoin == null) return null;
  const n = Number(sats);
  if (!Number.isFinite(n)) return null;
  return (n / SATS) * usdPerKoin;
}

/**
 * The dashboard's dollar figures.
 *
 * NODE VALUE is KOIN + VHP. VHP is KOIN that was burned to produce blocks —
 * it is the same value in a different state, so leaving it out would report a
 * producing node as nearly worthless. Mana is deliberately NOT counted: it is
 * a regenerating resource derived from the KOIN already counted, and adding it
 * would inflate the total with the same coins twice.
 *
 * EARNINGS come from the measured average daily profit, so they are only
 * meaningful once the node has actually produced. With no history the answer
 * is null — not zero. "$0.00 / day" is a claim about earnings; "not yet" is
 * the truth, and the difference matters to someone deciding whether their
 * machine is worth running.
 */
function valuation({ balances, windows, usdPerKoin } = {}) {
  const koinSats = balances && !balances.error ? balances.koin : null;
  const vhpSats = balances && !balances.error ? balances.vhp : null;

  let holdingsSats = null;
  if (koinSats != null || vhpSats != null) {
    holdingsSats = (BigInt(koinSats ?? 0) + BigInt(vhpSats ?? 0)).toString();
  }

  // Only trust the rate once there is at least one full day behind it.
  const hasHistory = !!(windows && Number(windows.daysTracked) > 0);
  const dailySats = hasHistory ? windows.avgDailyProfit : null;

  const daily = satsToUsd(dailySats, usdPerKoin);
  return {
    usdPerKoin: usdPerKoin ?? null,
    holdingsSats,
    nodeValueUsd: satsToUsd(holdingsSats, usdPerKoin),
    koinUsd: satsToUsd(koinSats, usdPerKoin),
    vhpUsd: satsToUsd(vhpSats, usdPerKoin),
    dailyUsd: daily,
    weeklyUsd: daily == null ? null : daily * 7,
    yearlyUsd: daily == null ? null : daily * 365,
    daysTracked: windows ? Number(windows.daysTracked || 0) : 0,
    // Straight from the measured window, so the UI can say how much history
    // the projection actually rests on instead of implying certainty.
    basis: hasHistory ? "measured" : "no-history",
  };
}

/**
 * Ask the pool what a small amount of USDT buys.
 *
 * Never throws for network reasons the caller cannot act on — it returns
 * { usdPerKoin: null, error } so a dashboard can keep drawing everything else.
 * A node with no internet must still show its balances.
 */
async function fetchUsdPerKoin({ provider, probeUsdt = DEFAULT_PROBE_USDT, now = Date.now(), signal } = {}) {
  const { quoteVkoinOut } = require("./eth-swap");
  const usdtSats = BigInt(Math.round(probeUsdt * USDT_UNITS));
  let p; const stop = () => { if (!provider) p?.destroy(); };
  try {
    signal?.throwIfAborted();
    p = provider || (await require("./eth-bridge").makeProvider(undefined, { signal }));
    signal?.addEventListener("abort", stop, { once: true });
    signal?.throwIfAborted();
    const vkoinSats = await quoteVkoinOut({ usdtSats, provider: p });
    const executable = computeUsdPerKoin({ usdtSats, vkoinSats });
    if (executable == null) {
      return { usdPerKoin: null, at: now, probeUsdt, error: "The vKOIN/USDT pool returned no liquidity." };
    }
    const fee = require("./route-constants").VKOIN_USDT_POOL.fee;
    return {
      // What a person means by "the price", and what every other venue shows.
      usdPerKoin: removePoolFee(executable, fee),
      // What this size would actually cost, fee and impact included.
      executableUsdPerKoin: executable,
      feeHundredthsBips: fee,
      at: now, probeUsdt, source: "uniswap-v4:vKOIN/USDT", error: null,
    };
  } catch (e) {
    return { usdPerKoin: null, at: now, probeUsdt, error: String(e?.shortMessage || e?.message || e) };
  } finally {
    // A background quote owns only the provider it created. Failed or complete
    // quotes must not leave discovery/retry timers running after Core stops.
    signal?.removeEventListener("abort", stop);
    if (!provider) p?.destroy();
  }
}

/**
 * One price, refreshed at most every TTL, kept across failures.
 *
 * Keeping the last good price through a failure is the point: a dropped
 * connection should dim a number, not delete it. It is handed back with its
 * age so the UI can mark it stale rather than presenting an hour-old price as
 * current.
 */
function createPriceCache({ ttlMs = PRICE_TTL_MS, staleMs = PRICE_STALE_MS, fetcher = fetchUsdPerKoin } = {}) {
  const controller = new AbortController();
  let last = null;      // last SUCCESSFUL result
  let lastError = null;
  let inFlight = null;  // collapses concurrent callers onto one round trip

  return {
    async get({ now = Date.now(), force = false } = {}) {
      controller.signal.throwIfAborted();
      const fresh = last && now - last.at < ttlMs;
      if (fresh && !force) return { ...last, ageMs: now - last.at, stale: false, error: lastError };
      if (!inFlight) {
        inFlight = fetcher({ now, signal: controller.signal }).finally(() => { inFlight = null; });
      }
      const r = await inFlight;
      if (r.usdPerKoin != null) { last = r; lastError = null; }
      else lastError = r.error;

      if (!last) return { usdPerKoin: null, at: now, ageMs: null, stale: false, error: lastError };
      const ageMs = now - last.at;
      return { ...last, ageMs, stale: ageMs > staleMs, error: lastError };
    },
    /*
     * The price as of right now, WITHOUT waiting for the network.
     *
     * dashboard:summary is polled every few seconds and paints the whole
     * screen. An Ethereum RPC round trip inside it would stall balances, sync
     * state and the activity feed behind a number that is nice to have — so
     * this returns whatever is known instantly and refreshes in the
     * background. The first poll after launch reports no price; the one after
     * it has one. That is the correct trade: the dashboard is never late
     * because of a quote.
     */
    snapshot({ now = Date.now() } = {}) {
      const due = !last || now - last.at >= ttlMs;
      if (due && !inFlight && !controller.signal.aborted) {
        // Fire and forget: errors are recorded by get() and surface as
        // `error` on a later snapshot.
        this.get({ now }).catch(() => {});
      }
      if (!last) return { usdPerKoin: null, at: null, ageMs: null, stale: false, error: lastError, pending: !!inFlight || due };
      const ageMs = now - last.at;
      return {
        usdPerKoin: last.usdPerKoin, at: last.at, probeUsdt: last.probeUsdt, source: last.source,
        ageMs, stale: ageMs > staleMs, error: lastError, pending: !!inFlight,
      };
    },

    stop: () => controller.abort(new Error("Price service stopped")),
    _peek: () => last,
  };
}

module.exports = {
  SATS,
  USDT_UNITS,
  DEFAULT_PROBE_USDT,
  PRICE_TTL_MS,
  PRICE_STALE_MS,
  computeUsdPerKoin,
  removePoolFee,
  satsToUsd,
  valuation,
  fetchUsdPerKoin,
  createPriceCache,
};
