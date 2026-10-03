import { DefiniteSendFailure } from '../../types.ts';
import type { EmailAdapter, InboundEmail, OutboundEmail, SentEmail } from '../../types.ts';

// LIVE AgentMail adapter over its REST API (docs/INTEGRATION-RESEARCH.md).
// Live outbound smoke verified; acceptance evidence is in docs/EMAIL-SETUP.md.
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
          // Keep the engine's allowlisted recipient even if the inbound email
          // has a different Reply-To address. Replies must not inherit recipients.
          { to: [message.to], text: message.text, headers: { 'X-Onboarding-Action': message.idempotencyKey } },
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
        try {
          text = await this.attachmentText(m.message_id, a);
        } catch {
          text = undefined; // unreadable attachments become a review item, never a crash
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
        text: m.extracted_text ?? m.text ?? '',
        attachments,
        receivedAt: m.timestamp ?? new Date().toISOString(),
      });
    }
    return out;
  }

  /** Text of a CV-like attachment: plain text directly, PDFs via unpdf, otherwise AgentMail's text_url if offered. */
  private async attachmentText(messageId: string, a: { attachment_id: string; filename?: string; content_type?: string }): Promise<string | undefined> {
    const type = a.content_type ?? '';
    const isPdf = /pdf/i.test(type) || /\.pdf$/i.test(a.filename ?? '');
    const isText = /^text\//.test(type) || /\.(txt|md)$/i.test(a.filename ?? '');
    const meta = await this.request<{ download_url: string; text_url?: string; size?: number }>(
      'GET',
      `/inboxes/${this.inbox}/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(a.attachment_id)}`,
    );
    if ((meta.size ?? 0) > 10 * 1024 * 1024) return undefined;
    if (!isPdf && !isText && meta.text_url) {
      const res = await fetch(meta.text_url, { signal: AbortSignal.timeout(20000) });
      return res.ok ? (await res.text()).slice(0, 200_000) : undefined;
    }
    if (!isPdf && !isText) return undefined;
    const res = await fetch(meta.download_url, { signal: AbortSignal.timeout(20000) });
    if (!res.ok) return undefined;
    if (isText) return (await res.text()).slice(0, 200_000);
    const { extractText, getDocumentProxy } = await import('unpdf');
    const pdf = await getDocumentProxy(new Uint8Array(await res.arrayBuffer()));
    const { text } = await extractText(pdf, { mergePages: true });
    return String(text).slice(0, 200_000);
  }

  async requeue(providerMessageId: string): Promise<void> {
    await this.request('PATCH', `/inboxes/${this.inbox}/messages/${encodeURIComponent(providerMessageId)}`, {
      add_labels: ['unread'],
      remove_labels: ['processed'],
    });
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
  html?: string;
  timestamp?: string;
  attachments?: { attachment_id: string; filename?: string; content_type?: string }[];
}
