// Injected only by the development Vite configuration, before application code.
(() => {
  const base = '/cloudcli';
  window.__ROUTER_BASENAME__ = base;
  const rewrite = (input) => {
    const url = new URL(String(input), location.href);
    if (url.host === location.host && /^\/(api|ws|shell|plugin-ws)(\/|\?|$)/.test(url.pathname)) {
      url.pathname = base + url.pathname;
    }
    return url.href;
  };
  const fetchOriginal = window.fetch.bind(window);
  window.fetch = (input, init) => fetchOriginal(
    input instanceof Request ? new Request(rewrite(input.url), input) : rewrite(input), init,
  );
  for (const name of ['WebSocket', 'EventSource']) {
    const Original = window[name];
    if (Original) window[name] = new Proxy(Original, {
      construct(target, args) {
        return Reflect.construct(target, [rewrite(args[0]), ...args.slice(1)]);
      },
    });
  }
  const open = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function(method, url, ...args) {
    return open.call(this, method, rewrite(url), ...args);
  };
  // Retain the development storage namespace across the move to /cloudcli/.
  const prefix = 'cloudcli-debug:';
  for (const name of ['getItem', 'setItem', 'removeItem']) {
    const original = Storage.prototype[name];
    Storage.prototype[name] = function(key, ...args) {
      return original.call(this, prefix + key, ...args);
    };
  }
  const keyAt = Storage.prototype.key;
  const remove = Storage.prototype.removeItem;
  Storage.prototype.clear = function() {
    for (let i = this.length - 1; i >= 0; i--) {
      const key = keyAt.call(this, i);
      if (key?.startsWith(prefix)) remove.call(this, key.slice(prefix.length));
    }
  };
  // Never register or replace production's root-scoped service worker.
  if ('serviceWorker' in navigator) {
    const register = navigator.serviceWorker.register.bind(navigator.serviceWorker);
    navigator.serviceWorker.register = () => register(base + '/debug-sw.js', { scope: base + '/' });
  }
})();
