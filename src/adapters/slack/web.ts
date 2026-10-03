import type { SlackAdapter, SlackButton, SlackButtonRow, SlackPost, SlackUser } from '../../types.ts';

// LIVE Slack Web API adapter (bot token). UNVERIFIED until run against the demo workspace.
// Scopes: chat:write, im:write, users:read, users:read.email, channels:manage (or channels:write.invites).
export class SlackWebAdapter implements SlackAdapter {
  readonly mode = 'slack-web';
  private readonly token: string;

  constructor(botToken: string) {
    this.token = botToken;
  }

  private async call<T>(method: string, body: Record<string, unknown>): Promise<T> {
    const res = await fetch(`https://slack.com/api/${method}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${this.token}`, 'content-type': 'application/json; charset=utf-8' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15000),
    });
    const json = (await res.json()) as { ok: boolean; error?: string } & T;
    if (!json.ok) throw new Error(`slack ${method}: ${json.error ?? res.status}`);
    return json;
  }

  private blocks(text: string, buttons?: SlackButton[], rows?: SlackButtonRow[]): unknown[] {
    const blocks: unknown[] = [{ type: 'section', text: { type: 'mrkdwn', text: text.slice(0, 2900) } }];
    if (buttons?.length) {
      blocks.push({
        type: 'actions',
        elements: buttons.map((b, i) => ({
          type: 'button',
          action_id: `onboard_${i}`,
          text: { type: 'plain_text', text: b.text },
          value: b.command,
          ...(b.style ? { style: b.style } : {}),
        })),
      });
    }
    for (const [r, row] of (rows ?? []).entries()) {
      blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: `*${row.label}*` }] });
      blocks.push({
        type: 'actions',
        elements: row.buttons.map((b, i) => ({ type: 'button', action_id: `onboard_r${r}_${i}`, text: { type: 'plain_text', text: b.text }, value: b.command })),
      });
    }
    return blocks;
  }

  /** A user id means "DM this user": resolve it to the IM channel. */
  private async resolveChannel(channel: string): Promise<string> {
    if (!/^[UW][A-Z0-9]+$/.test(channel)) return channel;
    const im = await this.call<{ channel: { id: string } }>('conversations.open', { users: channel });
    return im.channel.id;
  }

  async post(message: SlackPost): Promise<{ ts: string; channel: string }> {
    const channel = await this.resolveChannel(message.channel);
    const r = await this.call<{ ts: string; channel: string }>('chat.postMessage', { channel, text: message.text, blocks: this.blocks(message.text, message.buttons, message.rows) });
    return { ts: r.ts, channel: r.channel };
  }

  async update(channel: string, ts: string, text: string, buttons?: SlackButton[]): Promise<void> {
    await this.call('chat.update', { channel: await this.resolveChannel(channel), ts, text, blocks: this.blocks(text, buttons) });
  }

  async downloadFile(url: string): Promise<Buffer> {
    if (!/^https:\/\/files\.slack\.com\//.test(url)) throw new Error('refusing to download a non-Slack file URL');
    const res = await fetch(url, { headers: { authorization: `Bearer ${this.token}` }, signal: AbortSignal.timeout(30000) });
    if (!res.ok) throw new Error(`file download failed: HTTP ${res.status} (the app needs the files:read scope)`);
    const type = res.headers.get('content-type') ?? '';
    if (type.includes('text/html')) throw new Error('file download returned a login page (the app needs the files:read scope)');
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > 5 * 1024 * 1024) throw new Error('file is larger than 5 MB');
    return buf;
  }

  async lookupUserByEmail(email: string): Promise<SlackUser | null> {
    try {
      const r = await this.call<{ user: RawUser }>('users.lookupByEmail', { email });
      return toUser(r.user);
    } catch (err) {
      if (err instanceof Error && err.message.includes('users_not_found')) return null;
      throw err;
    }
  }

  async findUsersByName(name: string): Promise<SlackUser[]> {
    const r = await this.call<{ members: RawUser[] }>('users.list', { limit: 500 });
    const needle = name.toLowerCase();
    return r.members.filter((m) => (m.real_name ?? m.profile?.real_name ?? '').toLowerCase().includes(needle)).map(toUser);
  }

  async addToChannel(channel: string, userId: string): Promise<void> {
    await this.call('conversations.invite', { channel, users: userId });
  }
}

interface RawUser {
  id: string;
  real_name?: string;
  deleted?: boolean;
  is_bot?: boolean;
  profile?: { email?: string; real_name?: string };
}

function toUser(u: RawUser): SlackUser {
  return { id: u.id, email: u.profile?.email, realName: u.real_name ?? u.profile?.real_name, isBot: u.is_bot, deleted: u.deleted };
}
