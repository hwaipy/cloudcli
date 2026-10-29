import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  closeConnection,
  getConnection,
  initializeDatabase,
  sessionDraftsDb,
  userPreferencesDb,
} from '@/modules/database/index.js';

const USER_ID = 1;

async function withDatabase(runTest: () => void | Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'user-prefs-db-'));
  const databasePath = path.join(tempDirectory, 'auth.db');

  closeConnection();
  process.env.DATABASE_PATH = databasePath;
  await writeFile(databasePath, '');
  await initializeDatabase();

  // Both tables cascade from users(id), so a row has to exist to write against.
  getConnection()
    .prepare('INSERT INTO users (id, username, password_hash) VALUES (?, ?, ?)')
    .run(USER_ID, 'tester', 'hash');

  try {
    await runTest();
  } finally {
    closeConnection();
    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

test('preferences round-trip every JSON shape a setting can take', async () => {
  await withDatabase(() => {
    userPreferencesDb.savePreferences(USER_ID, {
      theme: 'dark',
      tasksEnabled: false,
      claudePermissions: { allowedTools: ['Read'], skipPermissions: true },
    });

    assert.deepEqual(userPreferencesDb.getPreferences(USER_ID), {
      theme: 'dark',
      tasksEnabled: false,
      claudePermissions: { allowedTools: ['Read'], skipPermissions: true },
    });
  });
});

test('saving preferences merge-patches instead of replacing the whole set', async () => {
  await withDatabase(() => {
    userPreferencesDb.savePreferences(USER_ID, { theme: 'dark', userLanguage: 'de' });
    userPreferencesDb.savePreferences(USER_ID, { theme: 'light' });

    assert.deepEqual(userPreferencesDb.getPreferences(USER_ID), {
      theme: 'light',
      userLanguage: 'de',
    });
  });
});

test('a preference set to undefined is removed', async () => {
  await withDatabase(() => {
    userPreferencesDb.savePreferences(USER_ID, { theme: 'dark', userLanguage: 'de' });
    userPreferencesDb.savePreferences(USER_ID, { userLanguage: undefined });

    assert.deepEqual(userPreferencesDb.getPreferences(USER_ID), { theme: 'dark' });
  });
});

test('one unreadable preference value does not cost the user the others', async () => {
  await withDatabase(() => {
    userPreferencesDb.savePreferences(USER_ID, { theme: 'dark' });
    getConnection()
      .prepare(
        `INSERT INTO user_preferences (user_id, preference_key, preference_value)
         VALUES (?, ?, ?)`
      )
      .run(USER_ID, 'broken', 'not json');

    assert.deepEqual(userPreferencesDb.getPreferences(USER_ID), { theme: 'dark' });
  });
});

test('drafts round-trip text and queued message per scope', async () => {
  await withDatabase(() => {
    sessionDraftsDb.saveDraft(USER_ID, 'session-a', { text: 'half typed', queuedMessage: null });
    sessionDraftsDb.saveDraft(USER_ID, 'project:p1', {
      text: '',
      queuedMessage: { content: 'run it' },
    });

    const drafts = sessionDraftsDb.getDrafts(USER_ID);
    const byScope = new Map(drafts.map((draft) => [draft.scope, draft]));

    assert.equal(byScope.get('session-a')?.text, 'half typed');
    assert.equal(byScope.get('session-a')?.queuedMessage, null);
    assert.equal(byScope.get('project:p1')?.text, '');
    assert.deepEqual(byScope.get('project:p1')?.queuedMessage, { content: 'run it' });
  });
});

test('saving an empty draft deletes the row rather than keeping a blank one', async () => {
  await withDatabase(() => {
    sessionDraftsDb.saveDraft(USER_ID, 'session-a', { text: 'typed', queuedMessage: null });
    sessionDraftsDb.saveDraft(USER_ID, 'session-a', { text: '', queuedMessage: null });

    assert.deepEqual(sessionDraftsDb.getDrafts(USER_ID), []);
  });
});

test('deleteDraft removes only the named scope', async () => {
  await withDatabase(() => {
    sessionDraftsDb.saveDraft(USER_ID, 'session-a', { text: 'a', queuedMessage: null });
    sessionDraftsDb.saveDraft(USER_ID, 'session-b', { text: 'b', queuedMessage: null });

    sessionDraftsDb.deleteDraft(USER_ID, 'session-a');

    assert.deepEqual(
      sessionDraftsDb.getDrafts(USER_ID).map((draft) => draft.scope),
      ['session-b'],
    );
  });
});

const queuedIn = (scope: string) => (
  sessionDraftsDb.getDrafts(USER_ID).find((draft) => draft.scope === scope)?.queuedMessage as Array<{ id: string; content: string; attachments: unknown[] }> | null
);

const claimCandidate = (scope: string) => {
  const row = getConnection().prepare('SELECT queued_message FROM session_drafts WHERE user_id = ? AND draft_scope = ?')
    .get(USER_ID, scope) as { queued_message: string };
  const queued = JSON.parse(row.queued_message) as Array<{ id: string; content: string }>;
  return { userId: USER_ID, sessionId: scope, queuedMessage: queued[0], claimToken: row.queued_message };
};

test('queued follow-ups retain independent content, options, files and order', async () => {
  await withDatabase(() => {
    sessionDraftsDb.saveDraftText(USER_ID, 'session-a', 'typing');
    const a = sessionDraftsDb.appendQueuedMessage(USER_ID, 'session-a', {
      content: 'A', options: { model: 'sonnet' }, attachments: [{ name: 'a.png' }],
    });
    const b = sessionDraftsDb.appendQueuedMessage(USER_ID, 'session-a', {
      content: 'B', options: { model: 'opus' }, attachments: [],
    });
    assert.equal(a.appended, false);
    assert.equal(b.appended, true);
    assert.deepEqual(queuedIn('session-a')?.map((item) => item.content), ['A', 'B']);
    assert.equal(queuedIn('session-a')?.[0]?.id, a.queuedMessage.id);
    assert.equal(queuedIn('session-a')?.[1]?.id, b.queuedMessage.id);
    assert.equal(sessionDraftsDb.getDrafts(USER_ID)[0]?.text, 'typing');
  });
});

test('claim removes only the head and rejects a stale claim token', async () => {
  await withDatabase(() => {
    sessionDraftsDb.appendQueuedMessage(USER_ID, 'session-a', { content: 'A', attachments: [] });
    const stale = claimCandidate('session-a');
    sessionDraftsDb.appendQueuedMessage(USER_ID, 'session-a', { content: 'B', attachments: [] });
    assert.equal(sessionDraftsDb.claimQueuedMessage(stale), false);
    assert.equal(sessionDraftsDb.claimQueuedMessage(claimCandidate('session-a')), true);
    assert.deepEqual(queuedIn('session-a')?.map((item) => item.content), ['B']);
  });
});

test('reordering preserves message payloads and a prior claim cannot consume the old head', async () => {
  await withDatabase(() => {
    const a = sessionDraftsDb.appendQueuedMessage(USER_ID, 'session-a', { content: 'A', attachments: [{ name: 'a.txt' }] });
    const b = sessionDraftsDb.appendQueuedMessage(USER_ID, 'session-a', { content: 'B', attachments: [] });
    const staleClaim = claimCandidate('session-a');
    const order = [a.queuedMessage.id!, b.queuedMessage.id!];
    assert.deepEqual(sessionDraftsDb.reorderQueuedMessages(USER_ID, 'session-a', order, [...order].reverse())?.map((item) => item.content), ['B', 'A']);
    assert.equal(sessionDraftsDb.claimQueuedMessage(staleClaim), false);
    assert.equal(queuedIn('session-a')?.[1]?.attachments.length, 1);
    assert.equal(sessionDraftsDb.reorderQueuedMessages(USER_ID, 'session-a', order, [...order].reverse()), null);
  });
});

test('taking one queued turn prevents a stale dispatch claim and refusal restores its position', async () => {
  await withDatabase(() => {
    const a = sessionDraftsDb.appendQueuedMessage(USER_ID, 'session-a', { content: 'A', attachments: [] });
    const b = sessionDraftsDb.appendQueuedMessage(USER_ID, 'session-a', { content: 'B', attachments: [] });
    sessionDraftsDb.appendQueuedMessage(USER_ID, 'session-a', { content: 'C', attachments: [] });
    const staleClaim = claimCandidate('session-a');
    const taken = sessionDraftsDb.takeQueuedMessage(USER_ID, 'session-a', b.queuedMessage.id!);
    assert.equal(taken?.message.content, 'B');
    assert.deepEqual(queuedIn('session-a')?.map((item) => item.content), ['A', 'C']);
    assert.equal(sessionDraftsDb.claimQueuedMessage(staleClaim), false);
    assert.equal(sessionDraftsDb.takeQueuedMessage(USER_ID, 'session-a', b.queuedMessage.id!), null);
    sessionDraftsDb.restoreTakenQueuedMessage(USER_ID, 'session-a', taken!.message, taken!.index);
    sessionDraftsDb.restoreTakenQueuedMessage(USER_ID, 'session-a', taken!.message, taken!.index);
    assert.deepEqual(queuedIn('session-a')?.map((item) => item.content), ['A', 'B', 'C']);
    assert.equal(queuedIn('session-a')?.[0]?.id, a.queuedMessage.id);
  });
});

test('clearing one queued message preserves its neighbors and draft text', async () => {
  await withDatabase(() => {
    sessionDraftsDb.saveDraftText(USER_ID, 'session-a', 'keep me');
    sessionDraftsDb.appendQueuedMessage(USER_ID, 'session-a', { content: 'A', attachments: [] });
    const b = sessionDraftsDb.appendQueuedMessage(USER_ID, 'session-a', { content: 'B', attachments: [] });
    sessionDraftsDb.appendQueuedMessage(USER_ID, 'session-a', { content: 'C', attachments: [] });
    sessionDraftsDb.clearQueuedMessage(USER_ID, 'session-a', b.queuedMessage.id);
    assert.deepEqual(queuedIn('session-a')?.map((item) => item.content), ['A', 'C']);
    assert.equal(sessionDraftsDb.getDrafts(USER_ID)[0]?.text, 'keep me');
  });
});

test('a restored claim returns before messages appended meanwhile', async () => {
  await withDatabase(() => {
    sessionDraftsDb.appendQueuedMessage(USER_ID, 'session-a', { content: 'A', attachments: [] });
    const claimed = claimCandidate('session-a');
    assert.equal(sessionDraftsDb.claimQueuedMessage(claimed), true);
    sessionDraftsDb.appendQueuedMessage(USER_ID, 'session-a', { content: 'B', attachments: [] });
    sessionDraftsDb.restoreQueuedMessage(claimed);
    assert.deepEqual(queuedIn('session-a')?.map((item) => item.content), ['A', 'B']);
  });
});

test('slash commands remain independent queued turns', async () => {
  await withDatabase(() => {
    sessionDraftsDb.appendQueuedMessage(USER_ID, 'session-a', { content: 'A', attachments: [] });
    sessionDraftsDb.appendQueuedMessage(USER_ID, 'session-a', { content: '/compact', attachments: [] });
    assert.deepEqual(queuedIn('session-a')?.map((item) => item.content), ['A', '/compact']);
  });
});
