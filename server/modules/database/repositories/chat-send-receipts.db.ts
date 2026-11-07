import { getConnection } from '@/modules/database/connection.js';

/** Persists accepted websocket message IDs so lost ACK retries remain idempotent across backend restarts. */
export const chatSendReceiptsDb = {
  hasAccepted(userId: number, sessionId: string, clientMessageId: string): boolean {
    const row = getConnection()
      .prepare(`
        SELECT 1 FROM chat_send_receipts
        WHERE user_id = ? AND session_id = ? AND client_message_id = ?
          AND accepted_at >= datetime('now', '-30 days')
      `)
      .get(userId, sessionId, clientMessageId);
    return row !== undefined;
  },

  recordAccepted(userId: number, sessionId: string, clientMessageId: string): void {
    const db = getConnection();
    db.prepare(`DELETE FROM chat_send_receipts WHERE accepted_at < datetime('now', '-30 days')`).run();
    db
      .prepare(`
        INSERT INTO chat_send_receipts (user_id, session_id, client_message_id)
        VALUES (?, ?, ?)
        ON CONFLICT (user_id, session_id, client_message_id) DO NOTHING
      `)
      .run(userId, sessionId, clientMessageId);
  },
};
