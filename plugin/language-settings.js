/* First launch and Settings share the same private desktop preference. */
(() => {
  'use strict';
  const i18n = window.KaiI18n, bridge = window.kaiLanguageBridge;
  const dialog = document.getElementById('language-dialog');
  const first = document.getElementById('first-language');
  const setting = document.getElementById('interface-language');
  const error = document.getElementById('language-error');
  const save = document.getElementById('language-continue');
  const status = document.getElementById('language-setting-status');
  let saved = i18n.preference, pending = false;
  function populate(select) {
    if (!select) return;
    for (const language of i18n.languages) {
      const option = document.createElement('option'); option.value = language.code;
      option.lang = language.code; option.textContent = language.name; option.translate = false;
      select.appendChild(option);
    }
    select.value = i18n.language;
  }
  populate(first); populate(setting);
  function apply(language, persist) {
    i18n.setLanguage(language, { persist });
    if (first) first.value = i18n.language;
    if (setting) setting.value = i18n.language;
  }
  async function commit(language, initial) {
    if (pending) return;
    pending = true;
    if (setting) setting.disabled = true;
    if (save) save.disabled = true;
    i18n.setText(error, '');
    i18n.setText(status, '');
    try {
      if (bridge) await bridge.save(language);
      else {
        // For the browser-served UI, confirm persistence before dismissing.
        localStorage.setItem(i18n.storageKey, language);
      }
      saved = language; apply(language, true);
      if (initial) dialog.close();
      else if (status) i18n.setText(status, 'Language saved.');
    } catch {
      if (!initial && saved) apply(saved, false);
      i18n.setText(initial ? error : status, 'Could not save the language. Please try again.');
    } finally {
      pending = false;
      if (setting) setting.disabled = false;
      if (save) save.disabled = false;
    }
  }
  first?.addEventListener('change', () => apply(first.value, false));
  setting?.addEventListener('change', () => commit(setting.value, false));
  save?.addEventListener('click', () => commit(first.value, true));
  dialog?.addEventListener('cancel', event => event.preventDefault());
  document.addEventListener('kai:language-changed', () => {
    if (first) first.value = i18n.language;
    if (setting) setting.value = i18n.language;
  });
  bridge?.onChanged(value => { if (value.selected) { saved = value.language; apply(value.language, true); } });
  async function init() {
    try {
      const value = bridge ? await bridge.get() : { language: i18n.language, selected: !!saved };
      saved = value.selected ? value.language : null;
      apply(value.language, value.selected);
      if (!value.selected && dialog && bridge) { dialog.showModal(); first.focus(); }
    } catch {
      // Don't silently dismiss first launch when the desktop preference read fails.
      if (dialog) { dialog.showModal(); i18n.setText(error, 'Could not load the language setting. Choose a language and try again.'); first.focus(); }
    } finally { document.documentElement.classList.remove('language-loading'); }
  }
  window.kaiLanguageReady = init();
})();
