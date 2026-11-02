"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path"), vm = require("node:vm");
const read = file => fs.readFileSync(path.join(__dirname, "../plugin", file), "utf8");
function fixture(get) {
  let listener, unsubscribe = 0, pagehide;
  const context = { console, navigator: { languages: ["en-US"] }, localStorage: { getItem: () => "de" } }; context.window = context;
  vm.runInNewContext(read("locales/catalogs.js"), context); vm.runInNewContext(read("i18n.js"), context);
  // Keep the actual translator in non-DOM mode; the adapter still has its
  // lifecycle surface. The native Core smoke exercises actual DOM bindings.
  const document = { getElementById: () => null, documentElement: { classList: { remove() {} } } };
  context.kai = { locale: { get, onChange(callback) { listener = callback; return () => unsubscribe++; } } };
  context.addEventListener = (name, callback) => { if (name === "pagehide") pagehide = callback; };
  vm.runInNewContext(read("core-language.js"), { window: context, document, console });
  return { context, change: value => listener(value), close: () => pagehide(), unsubscribed: () => unsubscribe };
}
test("all five Core languages override the old partition preference and remain live", async () => {
  const f = fixture(async () => ({ language: "es", selected: true })); await f.context.kaiLanguageReady;
  assert.equal(f.context.KaiI18n.language, "es");
  for (const language of ["en", "es", "pt-BR", "fr", "de"]) {
    f.change({ language }); assert.equal(f.context.KaiI18n.language, language);
    if (language !== "en") assert.notEqual(f.context.KaiI18n.t("Settings"), "Settings");
  }
  f.close(); assert.equal(f.unsubscribed(), 1);
});
test("a delayed initial read cannot undo a newer Core language event", async () => {
  let resolve; const f = fixture(() => new Promise(done => { resolve = done; }));
  f.change({ language: "fr" }); resolve({ language: "en" }); await f.context.kaiLanguageReady;
  assert.equal(f.context.KaiI18n.language, "fr");
});
test("unknown translation keys and parameter data stay literal", async () => {
  const f = fixture(async () => ({ language: "de" })); await f.context.kaiLanguageReady;
  assert.equal(f.context.KaiI18n.t("my-user-supplied-name"), "my-user-supplied-name");
  assert.equal(f.context.KaiI18n.t("unknown {0}", ["<script>Settings</script>"]), "unknown <script>Settings</script>");
  assert.equal(f.context.KaiI18n.literal("Settings").value, "Settings");
});
