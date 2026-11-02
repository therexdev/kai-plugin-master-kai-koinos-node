"use strict";
// Legacy UI adapter; Core remains the only owner of the saved language.
window.kaiLanguageBridge = Object.freeze({ get: () => window.kai.locale.get(), onChanged: callback => window.kai.locale.onChange(callback) });
