"use strict";
(function (root) {
  const attached = new WeakMap();
  function attach(container, { focusTarget } = {}) {
    if (attached.has(container)) return attached.get(container);
    const document = container.ownerDocument, initial = container.textContent;
    const message = document.createElement("span"), close = document.createElement("button"), symbol = document.createElement("span");
    message.className = "kai-notice-text"; message.setAttribute("role", "status"); message.setAttribute("aria-atomic", "true");
    close.className = "kai-notice-close"; close.type = "button"; close.title = "Dismiss message"; close.setAttribute("aria-label", "Dismiss message");
    symbol.textContent = "×"; symbol.setAttribute("aria-hidden", "true"); close.append(symbol);
    container.classList.add("kai-notice"); container.removeAttribute("role"); container.removeAttribute("aria-live"); container.replaceChildren(message, close);
    let current = "", dismissed = null;
    function show(value, { error = false, dismissible = true, force = false } = {}) {
      const content = String(value ?? ""), key = JSON.stringify([content, error, dismissible]);
      if (force || key !== current) dismissed = null;
      current = key;
      if (message.textContent !== content) message.textContent = content;
      container.classList.toggle("error", error); close.hidden = !dismissible;
      container.hidden = !content || current === dismissed;
    }
    function dismiss() {
      if (container.hidden || close.hidden) return;
      const hadFocus = document.activeElement === close;
      dismissed = current; container.hidden = true;
      if (hadFocus) {
        const target = focusTarget?.();
        if (target && !target.disabled && target.getClientRects().length) target.focus({ preventScroll: true });
      }
    }
    close.onclick = dismiss;
    const api = { show, dismiss, clear() { show(""); } };
    attached.set(container, api); show(initial);
    return api;
  }
  root.KaiPluginNotice = { attach };
})(window);
