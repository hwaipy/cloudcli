import assert from 'node:assert/strict';
import test from 'node:test';
import { networkForwardingOptions } from '../network-forwarding.mjs';

test('explicit forwarding preserves renderer Origin, authorization and POST body', async () => {
  const request = new Request('https://example.invalid/hub/auth/login', {
    method: 'POST', headers: { Origin: 'https://example.invalid', Authorization: 'Bearer test' }, body: '{"username":"fixture"}',
  });
  const options = networkForwardingOptions(request);
  assert.equal(options.headers.get('origin'), 'https://example.invalid');
  assert.equal(options.headers.get('authorization'), 'Bearer test');
  assert.equal(await new Response(options.body).text(), '{"username":"fixture"}');
  assert.equal(options.method, 'POST');
  assert.equal(options.bypassCustomProtocolHandlers, true);
});

test('forwarding never invents trusted Origin for foreign or originless requests', () => {
  for (const origin of [undefined, 'null', 'https://untrusted.invalid']) {
    const request = new Request('https://example.invalid/hub/auth/login', { method: 'POST', ...(origin ? { headers: { Origin: origin } } : {}) });
    const options = networkForwardingOptions(request);
    assert.equal(options.headers.get('origin'), origin ?? null);
    assert.equal(options.body, undefined);
  }
});

test('Electron protocol writes recover Origin only from a trusted application referrer', () => {
  const base = 'https://example.invalid/cloudcli/';
  const options = (referrer, url = 'https://example.invalid/hub/auth/login', origin) => networkForwardingOptions(new Request(url, {
    method: 'POST', referrer, ...(origin ? { headers: { Origin: origin } } : {}),
  }), base);
  assert.equal(options('https://example.invalid/cloudcli/session/one').headers.get('origin'), 'https://example.invalid');
  assert.equal(options('https://untrusted.invalid/').headers.get('origin'), null);
  assert.equal(options('https://example.invalid/another-app/').headers.get('origin'), null);
  assert.equal(options('').headers.get('origin'), null);
  assert.equal(options('https://example.invalid/cloudcli/', 'https://untrusted.invalid/api').headers.get('origin'), null);
  assert.equal(options('https://example.invalid/cloudcli/', undefined, 'null').headers.get('origin'), 'null');
  assert.equal(options('https://example.invalid/cloudcli/', undefined, 'https://untrusted.invalid').headers.get('origin'), 'https://untrusted.invalid');
});
