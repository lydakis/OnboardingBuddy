// LIVE Slack Socket Mode transport (no public webhook needed). Uses Node's built-in
// WebSocket. Receives slash commands, button clicks and events, acks each envelope,
// and hands them to the engine. UNVERIFIED until run against the sandbox.
import type { SlackCommandEvent, SlackTeamJoinEvent } from '../../types.ts';

export interface SlackMessageEvent {
  eventId: string;
  userId: string;
  channel: string;
  channelType: string;
  text: string;
}

export interface SocketHandlers {
  onCommand(e: SlackCommandEvent): Promise<unknown>;
  onTeamJoin(e: SlackTeamJoinEvent): Promise<unknown>;
  onMessage?(e: SlackMessageEvent): Promise<unknown>;
  onFileShare?(e: SlackFileShareEvent): Promise<unknown>;
}

export interface SlackFileShareEvent {
  eventId: string;
  userId: string;
  channel: string;
  files: { id: string; name: string; url: string }[];
}

type Log = (msg: string) => void;

export class SocketModeClient {
  private readonly appToken: string;
  private readonly handlers: SocketHandlers;
  private readonly log: Log;
  private ws: WebSocket | null = null;
  private stopped = false;

  constructor(appToken: string, handlers: SocketHandlers, log: Log = console.log) {
    this.appToken = appToken;
    this.handlers = handlers;
    this.log = log;
  }

  async start(): Promise<void> {
    this.stopped = false;
    await this.connect();
  }

  stop(): void {
    this.stopped = true;
    this.ws?.close();
  }

  private async connect(): Promise<void> {
    const res = await fetch('https://slack.com/api/apps.connections.open', {
      method: 'POST',
      headers: { authorization: `Bearer ${this.appToken}`, 'content-type': 'application/x-www-form-urlencoded' },
      signal: AbortSignal.timeout(15000),
    });
    const json = (await res.json()) as { ok: boolean; url?: string; error?: string };
    if (!json.ok || !json.url) throw new Error(`apps.connections.open failed: ${json.error ?? res.status}`);
    const ws = new WebSocket(json.url);
    this.ws = ws;
    ws.addEventListener('message', (ev) => void this.onFrame(ws, String(ev.data)));
    ws.addEventListener('close', () => {
      if (this.stopped) return;
      this.log('slack socket closed; reconnecting in 2s');
      setTimeout(() => void this.connect().catch((err) => this.log(`slack reconnect failed: ${String(err)}`)), 2000);
    });
  }

  private async onFrame(ws: WebSocket, data: string): Promise<void> {
    let msg: { type: string; envelope_id?: string; payload?: Record<string, any>; reason?: string };
    try {
      msg = JSON.parse(data);
    } catch {
      return;
    }
    if (msg.type === 'hello') return this.log('slack socket connected');
    if (msg.type === 'disconnect') {
      this.log(`slack asked to reconnect (${msg.reason ?? 'unknown'})`);
      ws.close();
      return;
    }
    if (!msg.envelope_id) return;
    ws.send(JSON.stringify({ envelope_id: msg.envelope_id })); // ack first; work happens async
    const p = msg.payload ?? {};
    try {
      if (msg.type === 'slash_commands') {
        await this.handlers.onCommand({ eventId: `env:${msg.envelope_id}`, userId: p.user_id, channel: p.user_id, text: String(p.text ?? '') });
      } else if (msg.type === 'interactive' && p.type === 'block_actions') {
        const action = p.actions?.[0];
        if (action?.value) await this.handlers.onCommand({ eventId: `act:${p.user?.id}:${action.action_ts}`, userId: p.user?.id, channel: p.user?.id, text: String(action.value) });
      } else if (msg.type === 'events_api') {
        const event = p.event ?? {};
        if (event.type === 'team_join') {
          await this.handlers.onTeamJoin({
            eventId: `evt:${p.event_id}`,
            user: { id: event.user?.id, email: event.user?.profile?.email, realName: event.user?.real_name ?? event.user?.profile?.real_name, isBot: event.user?.is_bot, deleted: event.user?.deleted },
          });
        } else if (event.type === 'message' && event.subtype === 'file_share' && event.channel_type === 'im' && !event.bot_id) {
          await this.handlers.onFileShare?.({
            eventId: `evt:${p.event_id}`,
            userId: event.user,
            channel: event.channel,
            files: (event.files ?? []).map((f: Record<string, string>) => ({ id: f.id, name: f.name, url: f.url_private_download ?? f.url_private })),
          });
        } else if ((event.type === 'message' && event.channel_type === 'im' && !event.bot_id && !event.subtype) || event.type === 'app_mention') {
          await this.handlers.onMessage?.({ eventId: `evt:${p.event_id}`, userId: event.user, channel: event.channel, channelType: event.channel_type ?? 'channel', text: String(event.text ?? '') });
        }
      }
    } catch (err) {
      this.log(`slack handler error (${msg.type}): ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
