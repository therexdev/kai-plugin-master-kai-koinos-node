"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path"), vm = require("node:vm");
const root = path.resolve(__dirname, "..");
const catalogs = require("../locales/ui.json");
const placeholders = text => [...text.matchAll(/\{\d+\}/g)].map(m => m[0]).sort();
function fixture() {
  const context = { navigator: { language: "en" }, CustomEvent: class { constructor(type, init) { this.type = type; this.detail = init.detail; } } };
  context.window = context;
  for (const file of ["locales/catalogs.js", "locales/core.js", "locales/ui.js", "i18n.js"]) vm.runInNewContext(fs.readFileSync(path.join(root, "plugin", file), "utf8"), context);
  context.document = { documentElement: {}, dispatchEvent() {} };
  return context;
}
test("all four translated catalogs cover the same UI keys and retain each parameter", () => {
  const keys = Object.keys(catalogs.es).sort();
  for (const language of ["es", "pt-BR", "fr", "de"]) {
    assert.deepEqual(Object.keys(catalogs[language]).sort(), keys);
    for (const [source, translation] of Object.entries(catalogs[language])) {
      assert.equal(typeof translation, "string"); assert.ok(translation.trim(), language + " " + source);
      assert.deepEqual(placeholders(translation), placeholders(source), language + " " + source);
    }
  }
});
test("generated offline catalogs match their reviewed source", () => {
  require("node:child_process").execFileSync(process.execPath, [path.join(root, "scripts/build-locales.js"), "--check"]);
});
test("live text, attributes and nested labels change language without translating user values", () => {
  const context = fixture(), api = context.KaiI18n;
  const label = { isConnected: true, textContent: "" };
  const user = { isConnected: true, textContent: "" };
  const input = { isConnected: true, textContent: "", value: "Settings <script> & {0}", attrs: {}, getAttribute(name) { return this.attrs[name]; }, setAttribute(name, value) { this.attrs[name] = value; } };
  api.setText(label, "Settings"); api.setText(user, api.literal("Settings")); api.setAttr(input, "placeholder", "Settings");
  for (const language of ["es", "pt-BR", "fr", "de", "en"]) {
    api.setLanguage(language);
    assert.equal(label.textContent, api.t("Settings")); assert.equal(input.attrs.placeholder, api.t("Settings"));
    assert.equal(user.textContent, "Settings"); assert.equal(input.value, "Settings <script> & {0}");
    if (language !== "en") assert.notEqual(label.textContent, "Settings");
    const nested = api.message(["", " · ", ""], api.message(["Settings"]), api.literal("Settings"));
    assert.equal(api.t(nested), api.t("Settings") + " · Settings");
  }
  // Busy controls restore source descriptors, so a language change is retained.
  const saved = api.getText(label); api.setText(label, "Loading…"); api.setLanguage("de"); api.setText(label, saved);
  assert.equal(label.textContent, api.t("Settings"));
  // A subsequent controller value wins over a previously registered status.
  label.textContent = "server supplied detail"; api.setLanguage("fr"); assert.equal(label.textContent, "server supplied detail");
  assert.equal(api.content(api.literal("<Settings> &")), "&lt;Settings&gt; &amp;");
  assert.match(api.content("Settings"), /<!--\/kai-i18n-->$/);
  api.setAttr(input, "placeholder", api.literal("Settings")); api.setLanguage("es"); assert.equal(input.attrs.placeholder, "Settings");
});
