import assert from 'node:assert/strict';
import { test } from 'node:test';

// Opt-in read-only public routing check. No accounts, messages or production data are created.
const base = process.env.CLOUDCLI_TEST_PUBLIC_BASE;
for (const legacy of [false, true]) {
  for (const pathname of ['/', '/cloudcli/', '/cloudcli/session/routing-probe?hub_backend=office']) {
    test(`${legacy ? 'legacy port' : 'canonical'} ${pathname} loads the current frontend origin`, { skip: !base }, async () => {
      const canonical = new URL(base);
      const entry = new URL(pathname, canonical);
      if (legacy) entry.port = '3001';
      const response = await fetch(entry, { signal: AbortSignal.timeout(15_000) });
      assert.equal(response.status, 200);
      const final = new URL(response.url);
      assert.equal(final.origin, canonical.origin, 'an old port must not serve a second stale application');
      assert.equal(final.pathname, pathname === '/' ? '/cloudcli/' : new URL(pathname, canonical).pathname);
      assert.equal(final.search, new URL(pathname, canonical).search);
      const manifest = await fetch(new URL('/cloudcli/boot-assets.json', final), { signal: AbortSignal.timeout(15_000) }).then(r => r.json());
      const current = await fetch(new URL('/cloudcli/boot-assets.json', canonical), { signal: AbortSignal.timeout(15_000) }).then(r => r.json());
      assert.deepEqual(manifest.assets, current.assets);
    });
  }
}
