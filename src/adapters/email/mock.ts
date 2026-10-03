import type { DatabaseSync } from 'node:sqlite';
import { DefiniteSendFailure } from '../../types.ts';
import type { EmailAdapter, InboundEmail, OutboundEmail, SentEmail } from '../../types.ts';

// MOCK email provider. Keeps its own mailbox tables (prefixed mock_) so the demo
// and tests survive restarts exactly like a real provider would.
export class MockEmailAdapter implements EmailAdapter {
  readonly mode = 'mock';
  private readonly db: DatabaseSync;
  private readonly fromAddress: string;
  /** Test hook: make the next send fail definitely or with an unknown outcome. */
  failNextSend: 'definite' | 'uncertain' | null = null;

  constructor(db: DatabaseSync, fromAddress: string) {
    this.db = db;
    this.fromAddress = fromAddress;
    db.exec(`
      CREATE TABLE IF NOT EXISTS mock_email_sent (
        provider_message_id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, idempotency_key TEXT UNIQUE,
        to_addr TEXT NOT NULL, subject TEXT NOT NULL, body TEXT NOT NULL, sent_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS mock_email_inbox (
        seq INTEGER PRIMARY KEY AUTOINCREMENT, provider_message_id TEXT NOT NULL, payload TEXT NOT NULL,
        acknowledged INTEGER NOT NULL DEFAULT 0);
    `);
  }

  async send(message: OutboundEmail): Promise<SentEmail> {
    const mode = this.failNextSend;
    this.failNextSend = null;
    if (mode === 'definite') throw new DefiniteSendFailure('mock provider rejected the message (422)');
    const existing = this.db
      .prepare('SELECT provider_message_id, thread_id FROM mock_email_sent WHERE idempotency_key = ?')
      .get(message.idempotencyKey) as { provider_message_id: string; thread_id: string } | undefined;
    if (existing) return { providerMessageId: existing.provider_message_id, threadId: existing.thread_id };

    const count = (this.db.prepare('SELECT COUNT(*) AS n FROM mock_email_sent').get() as { n: number }).n;
    const providerMessageId = `<mock-${count + 1}.${Date.now()}@${this.fromAddress.split('@')[1]}>`;
    let threadId = providerMessageId;
    if (message.replyToProviderMessageId) {
      const parent = this.findThread(message.replyToProviderMessageId);
      if (parent) threadId = parent;
    }
    this.db
      .prepare('INSERT INTO mock_email_sent VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(providerMessageId, threadId, message.idempotencyKey, message.to, message.subject, message.text, new Date().toISOString());
    // Simulates a timeout after the provider accepted the message.
    if (mode === 'uncertain') throw new Error('mock provider timed out after 30s');
    return { providerMessageId, threadId };
  }

  private findThread(providerMessageId: string): string | undefined {
    const sent = this.db.prepare('SELECT thread_id FROM mock_email_sent WHERE provider_message_id = ?').get(providerMessageId) as
      | { thread_id: string }
      | undefined;
    if (sent) return sent.thread_id;
    const rows = this.db.prepare('SELECT payload FROM mock_email_inbox WHERE provider_message_id = ?').all(providerMessageId) as {
      payload: string;
    }[];
    const first = rows[0];
    return first ? (JSON.parse(first.payload) as InboundEmail).threadId : undefined;
  }

  async poll(): Promise<InboundEmail[]> {
    const rows = this.db.prepare('SELECT payload FROM mock_email_inbox WHERE acknowledged = 0 ORDER BY seq').all() as { payload: string }[];
    return rows.map((r) => JSON.parse(r.payload) as InboundEmail);
  }

  async acknowledge(providerMessageId: string): Promise<void> {
    this.db.prepare('UPDATE mock_email_inbox SET acknowledged = 1 WHERE provider_message_id = ?').run(providerMessageId);
  }

  // ---- simulation helpers (demo + tests) ----

  /** Queue an inbound message, as if a worker replied. Re-delivery of the same id is allowed on purpose. */
  deliver(message: Omit<InboundEmail, 'receivedAt' | 'threadId'> & { receivedAt?: string; threadId?: string }): InboundEmail {
    const full: InboundEmail = {
      ...message,
      threadId: message.threadId ?? (message.inReplyTo ? this.findThread(message.inReplyTo) : undefined),
      receivedAt: message.receivedAt ?? new Date().toISOString(),
    };
    this.db.prepare('INSERT INTO mock_email_inbox (provider_message_id, payload) VALUES (?, ?)').run(full.providerMessageId, JSON.stringify(full));
    return full;
  }

  /** Simulate a worker replying to the latest message we sent them. */
  replyAsWorker(input: { from: string; text: string; attachments?: InboundEmail['attachments']; id?: string }): InboundEmail {
    const last = this.db
      .prepare('SELECT provider_message_id, subject FROM mock_email_sent WHERE to_addr = ? ORDER BY rowid DESC LIMIT 1')
      .get(input.from.toLowerCase()) as { provider_message_id: string; subject: string } | undefined;
    const seq = (this.db.prepare('SELECT COUNT(*) AS n FROM mock_email_inbox').get() as { n: number }).n + 1;
    return this.deliver({
      providerMessageId: input.id ?? `<reply-${seq}@worker.example>`,
      inReplyTo: last?.provider_message_id,
      references: last ? [last.provider_message_id] : [],
      from: input.from,
      to: this.fromAddress,
      subject: last ? `Re: ${last.subject}` : 'Hello',
      text: input.text,
      attachments: input.attachments ?? [],
    });
  }

  sent(to?: string): { provider_message_id: string; thread_id: string; to_addr: string; subject: string; body: string }[] {
    return (to
      ? this.db.prepare('SELECT * FROM mock_email_sent WHERE to_addr = ? ORDER BY rowid').all(to.toLowerCase())
      : this.db.prepare('SELECT * FROM mock_email_sent ORDER BY rowid').all()) as never;
  }
}
