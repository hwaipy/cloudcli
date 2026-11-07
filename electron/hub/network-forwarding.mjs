/** Preserve renderer request headers explicitly when forwarding through Electron's main-process fetch. */
export function networkForwardingOptions(request, baseUrl) {
  const headers = new Headers(request.headers);
  // Electron's protocol Request omits Chromium's generated Origin header,
  // but retains the browser-controlled referrer. Restore it only for writes
  // from our own application pages to the configured server, never from the destination alone.
  if (!headers.has('origin') && !['GET', 'HEAD', 'OPTIONS'].includes(request.method)) {
    try {
      const base = new URL(baseUrl);
      const target = new URL(request.url);
      const source = new URL(request.referrer);
      if (target.origin === base.origin && source.origin === base.origin && source.pathname.startsWith(base.pathname)) {
        headers.set('Origin', source.origin);
      }
    } catch { /* Originless or foreign requests remain subject to the server's rejection. */ }
  }
  return {
    method: request.method,
    headers,
    ...(request.body ? { body: request.body, duplex: 'half' } : {}),
    credentials: request.credentials,
    redirect: request.redirect,
    referrer: request.referrer,
    referrerPolicy: request.referrerPolicy,
    signal: request.signal,
    bypassCustomProtocolHandlers: true,
  };
}
