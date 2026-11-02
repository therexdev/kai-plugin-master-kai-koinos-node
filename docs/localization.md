# Interface language

Core owns the saved interface language and the first-install language choice. This plugin follows English (`en`), Spanish (`es`), Brazilian Portuguese (`pt-BR`), French (`fr`) and German (`de`) through the public Core locale API. Change it in **Core Settings → Language**. Open plugin views update without losing drafts.

The renderer loads `core-language.js` before the feature scripts and waits for `window.kaiLanguageReady` before its first render. The adapter subscribes to `window.kai.locale.onChange` before reading `window.kai.locale.get`, so an older initial response cannot replace a newer preference. Native services can use `api.locale.get()` and `api.locale.onChange()` when they need the saved preference. Do not store a separate plugin language or infer it from the webview origin.

## Add or change interface text

`plugin/i18n.js` is the plugin's offline renderer helper. Core supplies the preference; these helpers and catalogs belong to this plugin.

- Keep English source text as the translation key. Add the same key to all four languages in `locales/ui.json`, preserving every numbered parameter such as `{0}`.
- Run `npm run build:locales` and commit both the readable source and generated `plugin/locales/ui.js`. Assistant also generates the companion catalog in `plugin/service/ui/locales/ui.js`; its native asset allowlist must serve it.
- Use `KaiI18n.html` for static template prose. Wrap a dynamic interface label with `KaiI18n.content(label)`. Put prose next to an interpolated HTML component in its own element, so it receives an independent text binding.
- Use `KaiI18n.setText(element, source)` for status messages and button labels, and `KaiI18n.setAttr(element, "title" | "placeholder" | "aria-label", source)` for interface attributes. These retain the English source for subsequent language changes.
- Use `KaiI18n.message` for values inside prose. Nested messages translate nested interface labels. Strings interpolated as values remain literal.
- Preserve names, account identifiers, model output, drafts, addresses, keys and code with ordinary text assignment or `KaiI18n.literal(value)`. Never translate arbitrary document or chat content by matching it against the catalog.
- Before temporarily replacing a busy button label, capture `KaiI18n.getText(button)`, then restore that descriptor with `setText`. Saving the already translated text loses its source.

```js
KaiI18n.setText(status, KaiI18n.message`Connected to ${account.name}`);
KaiI18n.setText(name, KaiI18n.literal(account.name));
menu.innerHTML = KaiI18n.html`<button>${KaiI18n.content("Settings")}</button>`;
KaiI18n.setAttr(search, "placeholder", "Search");
```

Add `Connected to {0}` and `Search` to every translated catalog when using the example. Do not turn translated display strings into RPC actions, stored enum values, URLs or model instructions.

## Verify before publishing

Run `npm test`; it checks catalog parity, parameters, generated assets, Core preference updates and literal-value preservation. Exercise dynamic menus, dialogs, progress states and settings in an installed plugin. Switch among all five languages while a view is open, verify the next view opens translated, and check an unsaved input retains its value. Keep identifiers and logs readable as their original data. Assistant's native smoke also verifies the companion actually receives its catalog and follows live language changes.
