import { getConnection, userDb } from '@/modules/database/index.js';

/** Store upload ownership separately from the shared on-disk asset format. */
export function recordAssetOwners(files: Array<{ filename: string }>, userId: number): void {
  const database = getConnection();
  const insert = database.prepare('INSERT INTO asset_owners (filename, user_id) VALUES (?, ?)');
  database.transaction(() => {
    for (const file of files) insert.run(file.filename, userId);
  })();
}

/** Pre-account assets stay visible only to the original (first) account. */
export function canReadAsset(filename: string, userId: number): boolean {
  const row = getConnection().prepare('SELECT user_id FROM asset_owners WHERE filename = ?')
    .get(filename) as { user_id: number } | undefined;
  return row ? row.user_id === userId : userDb.getFirstUser()?.id === userId;
}
