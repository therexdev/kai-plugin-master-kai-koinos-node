"use strict";
const implementation = require("../plugin/service/electron/plugin-services/koinos-node-full");
module.exports = { ...implementation, create(ctx, dependencies) { ctx.wallet ||= ctx.core?.account.wallet; ctx.settings ||= { get: () => null }; ctx.version = "0.3.0"; return implementation.create(ctx, dependencies); } };
