import { DefiniteSendFailure } from '../../types.ts';
import type { EmailAdapter, InboundEmail, OutboundEmail, SentEmail } from '../../types.ts';

// LIVE AgentMail adapter over its REST API (docs/INTEGRATION-RESEARCH.md).
// UNTESTED: no AgentMail credentials were available while building the demo.
// Polling uses the "unread" label; acknowledge() swaps it for "processed".
export class AgentMailAdapter implements EmailAdapter {
  readonly mode = 'agentmail';
  private readonly apiKey: string;
  private readonly inbox: string;
  private readonly baseUrl: string;

  constructor(opts: { apiKey: string; inboxId: string; baseUrl: string }) {
    this.apiKey = opts.apiKey;
    this.inbox = encodeURIComponent(opts.inboxId);
    this.baseUrl = opts.baseUrl.replace(/\/$/, '');
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: { authorization: `Bearer ${this.apiKey}`, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(20000),
    });
    if (res.status >= 400 && res.status < 500) throw new DefiniteSendFailure(`agentmail ${method} ${path}: HTTP ${res.status}`);
    if (!res.ok) throw new Error(`agentmail ${method} ${path}: HTTP ${res.status}`);
    return (await res.json()) as T;
  }

  async send(message: OutboundEmail): Promise<SentEmail> {
    const r = message.replyToProviderMessageId
      ? await this.request<{ message_id: string; thread_id: string }>(
          'POST',
          `/inboxes/${this.inbox}/messages/${encodeURIComponent(message.replyToProviderMessageId)}/reply`,
          { text: message.text, headers: { 'X-Onboarding-Action': message.idempotencyKey } },
        )
      : await this.request<{ message_id: string; thread_id: string }>('POST', `/inboxes/${this.inbox}/messages/send`, {
          to: [message.to],
          subject: message.subject,
          text: message.text,
          headers: { 'X-Onboarding-Action': message.idempotencyKey },
        });
    return { providerMessageId: r.message_id, threadId: r.thread_id };
  }

  async poll(): Promise<InboundEmail[]> {
    const list = await this.request<{ messages: { message_id: string }[] }>('GET', `/inboxes/${this.inbox}/messages?labels=unread&ascending=true&limit=50`);
    const out: InboundEmail[] = [];
    for (const item of list.messages) {
      const m = await this.request<RawMessage>('GET', `/inboxes/${this.inbox}/messages/${encodeURIComponent(item.message_id)}`);
      const attachments: InboundEmail['attachments'] = [];
      for (const a of m.attachments ?? []) {
        let text: string | undefined;
        if (/^text\//.test(a.content_type ?? '')) {
          const meta = await this.request<{ download_url: string }>(
            'GET',
            `/inboxes/${this.inbox}/messages/${encodeURIComponent(m.message_id)}/attachments/${encodeURIComponent(a.attachment_id)}`,
          );
          const res = await fetch(meta.download_url, { signal: AbortSignal.timeout(20000) });
          if (res.ok) text = (await res.text()).slice(0, 200_000);
        }
        attachments.push({ filename: a.filename ?? 'attachment', contentType: a.content_type ?? 'application/octet-stream', text });
      }
      out.push({
        providerMessageId: m.message_id,
        threadId: m.thread_id,
        inReplyTo: m.in_reply_to ?? undefined,
        references: m.references ?? [],
        from: Array.isArray(m.from) ? m.from[0] ?? '' : m.from,
        to: Array.isArray(m.to) ? m.to.join(',') : String(m.to ?? ''),
        subject: m.subject ?? '',
        text: m.text ?? m.extracted_text ?? '',
        attachments,
        receivedAt: m.timestamp ?? new Date().toISOString(),
      });
    }
    return out;
  }

  async acknowledge(providerMessageId: string): Promise<void> {
    await this.request('PATCH', `/inboxes/${this.inbox}/messages/${encodeURIComponent(providerMessageId)}`, {
      add_labels: ['processed'],
      remove_labels: ['unread'],
    });
  }
}

interface RawMessage {
  message_id: string;
  thread_id: string;
  in_reply_to?: string | null;
  references?: string[] | null;
  from: string | string[];
  to?: string | string[];
  subject?: string;
  text?: string;
  extracted_text?: string;
  timestamp?: string;
  attachments?: { attachment_id: string; filename?: string; content_type?: string }[];
}
