import { createHmac, timingSafeEqual } from 'node:crypto';

import type { HubIdentityClaim } from '@/shared/types.js';

//----------------- HUB IDENTITY ASSERTIONS ------------

/** Signs a short-lived Hub user assertion with the private registration key belonging to the addressed backend. */
export function createHubIdentityAssertion(
  identity: Pick<HubIdentityClaim, 'hubUserId' | 'username' | 'isAdmin'>,
  backendId: string,
  backendKey: string,
  now = Date.now(),
): string {
  const payload: HubIdentityClaim = {
    ...identity,
    backendId,
    expiresAt: now + 60_000,
  };
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signature = createHmac('sha256', backendKey).update(encoded).digest('base64url');
  return `${encoded}.${signature}`;
}

/** Verifies a Hub assertion only for the backend whose registration key signed it and rejects expired or malformed claims. */
export function verifyHubIdentityAssertion(
  assertion: unknown,
  backendId: string,
  backendKey: string,
  now = Date.now(),
): HubIdentityClaim | null {
  if (typeof assertion !== 'string' || !backendKey) return null;
  const [encoded, signature, extra] = assertion.split('.');
  if (!encoded || !signature || extra !== undefined) return null;
  const expected = createHmac('sha256', backendKey).update(encoded).digest();
  let actual: Buffer;
  try { actual = Buffer.from(signature, 'base64url'); } catch { return null; }
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return null;
  try {
    const claim = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as Partial<HubIdentityClaim>;
    if (typeof claim.hubUserId !== 'string' || !claim.hubUserId
      || typeof claim.username !== 'string' || !claim.username
      || typeof claim.isAdmin !== 'boolean' || claim.backendId !== backendId
      || typeof claim.expiresAt !== 'number' || !Number.isFinite(claim.expiresAt) || claim.expiresAt <= now) return null;
    return claim as HubIdentityClaim;
  } catch { return null; }
}

// ---------------------------
