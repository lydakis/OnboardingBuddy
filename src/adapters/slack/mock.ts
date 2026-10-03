import type { DatabaseSync } from 'node:sqlite';
import type { SlackAdapter, SlackButton, SlackPost, SlackUser } from '../../types.ts';

// MOCK Slack workspace. Posts, the member directory and channel membership live in
// mock_ tables so the status page can show the "Slack" side of the conversation.
export class MockSlackAdapter implements SlackAdapter {
  readonly mode = 'mock';
  private readonly db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
    db.exec(`
      CREATE TABLE IF NOT EXISTS mock_slack_posts (
        seq INTEGER PRIMARY KEY AUTOINCREMENT, idempotency_key TEXT UNIQUE, channel TEXT NOT NULL,
        text TEXT NOT NULL, buttons TEXT, ts TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS mock_slack_users (
        id TEXT PRIMARY KEY, email TEXT, real_name TEXT, is_bot INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS mock_slack_channel_members (
        channel TEXT NOT NULL, user_id TEXT NOT NULL, PRIMARY KEY (channel, user_id));
    `);
    this.addUser({ id: 'U_MGR_DANA', email: 'dana.ruiz@fleetwing.example', realName: 'Dana Ruiz (manager)' });
    this.addUser({ id: 'U_MGR_SAM', email: 'sam.okafor@fleetwing.example', realName: 'Sam Okafor (manager)' });
    this.addUser({ id: 'U_DISPATCH_LEE', email: 'lee.park@fleetwing.example', realName: 'Lee Park (dispatcher)' });
  }

  async post(message: SlackPost): Promise<{ ts: string }> {
    const existing = this.db.prepare('SELECT ts FROM mock_slack_posts WHERE idempotency_key = ?').get(message.idempotencyKey) as
      | { ts: string }
      | undefined;
    if (existing) return existing;
    const ts = `${Math.floor(Date.now() / 1000)}.${String(this.count() + 1).padStart(6, '0')}`;
    this.db
      .prepare('INSERT INTO mock_slack_posts (idempotency_key, channel, text, buttons, ts) VALUES (?, ?, ?, ?, ?)')
      .run(message.idempotencyKey, message.channel, message.text, message.buttons || message.rows ? JSON.stringify([...(message.buttons ?? []), ...(message.rows ?? []).flatMap((r) => r.buttons)]) : null, ts);
    return { ts };
  }

  async update(channel: string, ts: string, text: string, buttons?: SlackButton[]): Promise<void> {
    this.db
      .prepare('UPDATE mock_slack_posts SET text = ?, buttons = ? WHERE channel = ? AND ts = ?')
      .run(text, buttons?.length ? JSON.stringify(buttons) : null, channel, ts);
  }

  /** Mock "Slack file URLs" are local paths (file://...). */
  async downloadFile(url: string): Promise<Buffer> {
    const { readFileSync } = await import('node:fs');
    return readFileSync(new URL(url));
  }

  async lookupUserByEmail(email: string): Promise<SlackUser | null> {
    const row = this.db.prepare('SELECT * FROM mock_slack_users WHERE lower(email) = lower(?)').get(email) as Record<string, unknown> | undefined;
    return row ? toUser(row) : null;
  }

  async findUsersByName(name: string): Promise<SlackUser[]> {
    const rows = this.db.prepare('SELECT * FROM mock_slack_users WHERE lower(real_name) LIKE lower(?)').all(`%${name}%`) as Record<string, unknown>[];
    return rows.map(toUser);
  }

  async addToChannel(channel: string, userId: string): Promise<void> {
    const user = this.db.prepare('SELECT id FROM mock_slack_users WHERE id = ?').get(userId);
    if (!user) throw new Error(`user_not_found: ${userId} is not a workspace member (conversations.invite only works for members)`);
    this.db.prepare('INSERT OR IGNORE INTO mock_slack_channel_members VALUES (?, ?)').run(channel, userId);
  }

  // ---- simulation helpers ----
  addUser(user: SlackUser): void {
    this.db
      .prepare('INSERT OR IGNORE INTO mock_slack_users (id, email, real_name, is_bot) VALUES (?, ?, ?, ?)')
      .run(user.id, user.email ?? null, user.realName ?? null, user.isBot ? 1 : 0);
  }

  posts(channel?: string): { channel: string; text: string; buttons: string | null; ts: string }[] {
    return (channel
      ? this.db.prepare('SELECT * FROM mock_slack_posts WHERE channel = ? ORDER BY seq').all(channel)
      : this.db.prepare('SELECT * FROM mock_slack_posts ORDER BY seq').all()) as never;
  }

  channelMembers(channel: string): string[] {
    return (this.db.prepare('SELECT user_id FROM mock_slack_channel_members WHERE channel = ?').all(channel) as { user_id: string }[]).map(
      (r) => r.user_id,
    );
  }

  private count(): number {
    return (this.db.prepare('SELECT COUNT(*) AS n FROM mock_slack_posts').get() as { n: number }).n;
  }
}

function toUser(row: Record<string, unknown>): SlackUser {
  return {
    id: String(row.id),
    email: (row.email as string | null) ?? undefined,
    realName: (row.real_name as string | null) ?? undefined,
    isBot: row.is_bot === 1,
  };
}
