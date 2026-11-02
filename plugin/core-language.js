/* Public Core locale API. Ship this adapter with the plugin, never import Core. */
(() => {
  "use strict";
  const i18n = window.KaiI18n;
  const bridge = window.kai?.locale || (window.kaiLanguageBridge && {
    get: () => window.kaiLanguageBridge.get(), onChange: callback => window.kaiLanguageBridge.onChanged(callback),
  });
  let revision = 0;
  function apply(value) {
    const language = i18n.normalize(value?.language);
    if (!language) return;
    i18n.setLanguage(language);
    const select = document.getElementById("interface-language");
    if (select) {
      select.replaceChildren();
      for (const row of i18n.languages) {
        const option = document.createElement("option"); option.value = row.code;
        option.lang = row.code; option.translate = false; option.textContent = row.name; select.appendChild(option);
      }
      select.value = language; select.disabled = true;
      i18n.setText(document.getElementById("language-setting-status"), "Language follows Core Settings.");
    }
    document.getElementById("language-dialog")?.close();
  }
  // Subscribe first: a late initial read must never undo a newer saved choice.
  const unsubscribe = bridge?.onChange(value => { revision++; apply(value); });
  window.addEventListener("pagehide", () => unsubscribe?.(), { once: true });
  window.kaiLanguageReady = (async () => {
    const requestRevision = revision;
    try { const value = await bridge?.get(); if (requestRevision === revision && value) apply(value); }
    catch (error) { console.warn("Could not read Core language", error); }
    finally { document.documentElement.classList.remove("language-loading"); }
  })();
})();
