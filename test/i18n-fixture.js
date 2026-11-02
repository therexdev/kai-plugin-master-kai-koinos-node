"use strict";
// Controllers use the production locale implementation with lightweight DOM fixtures.
const locale = require("../plugin/i18n.js");
module.exports = { ...locale, setAttr(node, attr, source) {
  if (!node) return;
  node.getAttribute ||= name => node.attrs?.[name] ?? null;
  node.setAttribute ||= (name, value) => { (node.attrs ||= {})[name] = value; };
  return locale.setAttr(node, attr, source);
} };
