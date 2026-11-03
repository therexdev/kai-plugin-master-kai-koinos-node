"use strict";

// Display composition only. No local reward is added to indexed lifetime
// totals or passed to either payment engine.
((root) => {
  function compose(dashboard, local) {
    const stats = dashboard?.stats;
    const matching = !!local && local.network === dashboard?.network?.id && local.address === dashboard?.wallet?.address;
    const activity = matching ? local : null;
    const history = stats?.available ? stats.feed || [] : [];
    const verified = activity?.available ? activity.feed || [] : [];
    const newestHistory = Math.max(0, ...history.filter(r => r.type === "block").map(r => r.height));
    const historyBehind = !!verified.length && verified[0].height > newestHistory;
    // The verified local interval replaces history rows at those heights,
    // including orphaned rows. Indexed entries above finality wait for it.
    const older = activity?.available ? history.filter(r => r.type !== "block" || r.height < activity.fromHeight) : history;
    const seen = new Set();
    const feed = [...verified, ...older].filter(r => {
      const key = r.type === "block" ? "block:" + r.height : r.id ? "tx:" + r.id : "seq:" + r.seqNum;
      if (seen.has(key)) return false;
      seen.add(key); return true;
    }).slice(0, 60);
    return { local: activity, feed, historyBehind, historyUnavailable: !stats?.available,
      historyUncertain: historyBehind || !stats?.available || !!stats?.syncing };
  }
  if (typeof module !== "undefined" && module.exports) module.exports = { compose };
  else root.KaiDashboardActivity = { compose };
})(typeof window === "undefined" ? globalThis : window);
