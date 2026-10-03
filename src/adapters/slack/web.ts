import type { SlackAdapter, SlackPost, SlackUser } from '../../types.ts';

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

  async post(message: SlackPost): Promise<{ ts: string }> {
    let channel = message.channel;
    if (/^[UW][A-Z0-9]+$/.test(channel)) {
      const im = await this.call<{ channel: { id: string } }>('conversations.open', { users: channel });
      channel = im.channel.id;
    }
    const blocks: unknown[] = [{ type: 'section', text: { type: 'mrkdwn', text: message.text.slice(0, 2900) } }];
    if (message.buttons?.length) {
      blocks.push({
        type: 'actions',
        elements: message.buttons.map((b, i) => ({
          type: 'button',
          action_id: `onboard_${i}`,
          text: { type: 'plain_text', text: b.text },
          value: b.command,
          ...(b.style ? { style: b.style } : {}),
        })),
      });
    }
    const r = await this.call<{ ts: string }>('chat.postMessage', { channel, text: message.text, blocks });
    return { ts: r.ts };
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
