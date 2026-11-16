// @ts-expect-error -- web-push has no bundled declarations; the service's public contract stays typed.
import webPush from 'web-push';

import { vapidKeysDb } from '@/modules/database/index.js';

function ensureVapidKeys(): NonNullable<ReturnType<typeof vapidKeysDb.getVapidKeys>> {
  return vapidKeysDb.getOrCreateVapidKeys(() => webPush.generateVAPIDKeys());
}

/** Used by notification routes to expose this database's stable Web Push subscription identity. */
export function getPublicKey(): string {
  return ensureVapidKeys().publicKey;
}

/** Used by server startup to configure Web Push without caching a closed database connection. */
export function configureWebPush(): void {
  const keys = ensureVapidKeys();
  webPush.setVapidDetails('mailto:noreply@claudecodeui.local', keys.publicKey, keys.privateKey);
  console.log('Web Push notifications configured');
}
