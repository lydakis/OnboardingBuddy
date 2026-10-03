import type { Config } from '../config.ts';
import type { Store } from '../db/store.ts';
import { DefiniteSendFailure } from '../types.ts';
import type { Adapters, OutboxRow, SlackButton } from '../types.ts';

export interface EngineContext {
  store: Store;
  adapters: Adapters;
  config: Config;
}

export type SendResult =
  | { state: 'sent'; providerMessageId: string; threadId: string | null; duplicate: boolean }
  | { state: 'uncertain' | 'failed' | 'pending'; duplicate: boolean };

/**
 * Exactly-once-ish outbound delivery keyed by a stable action key.
 * - Already sent: returns the stored result without calling the provider.
 * - Outcome unknown (timeout, crash mid-send): flagged for a human to verify, never retried blindly.
 * - Definite failure: recorded; a later call with the same key may retry.
 */
async function sendOnce(
  ctx: EngineContext,
  o: { actionKey: string; caseId: string | null; channel: 'email' | 'slack'; kind: string; recipient: string; summary: string },
  deliver: () => Promise<{ providerMessageId: string; threadId: string | null }>,
): Promise<SendResult> {
  const { store } = ctx;
  const existing = store.getOutbox(o.actionKey);
  if (existing) {
    if (existing.status === 'sent') {
      return { state: 'sent', providerMessageId: existing.provider_message_id!, threadId: existing.thread_id, duplicate: true };
    }
    if (existing.status !== 'failed') return { state: existing.status, duplicate: true };
    store.deleteOutbox(o.actionKey);
  }
  store.insertOutbox(o);
  try {
    const r = await deliver();
    store.updateOutbox(o.actionKey, { status: 'sent', providerMessageId: r.providerMessageId, threadId: r.threadId });
    return { state: 'sent', providerMessageId: r.providerMessageId, threadId: r.threadId, duplicate: false };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (err instanceof DefiniteSendFailure) {
      store.updateOutbox(o.actionKey, { status: 'failed', error: message });
      store.audit(o.caseId, 'system', 'send_failed', { actionKey: o.actionKey, error: message });
      return { state: 'failed', duplicate: false };
    }
    store.updateOutbox(o.actionKey, { status: 'uncertain', error: message });
    store.audit(o.caseId, 'system', 'send_uncertain', { actionKey: o.actionKey, error: message });
    if (o.caseId) store.updateCase(o.caseId, { needs_attention: `Send "${o.kind}" outcome unknown; verify before resending (${o.actionKey})` });
    return { state: 'uncertain', duplicate: false };
  }
}

export async function sendEmail(
  ctx: EngineContext,
  input: { actionKey: string; caseId: string; kind: string; to: string; subject: string; text: string; replyTo?: string | null },
): Promise<SendResult> {
  const result = await sendOnce(
    ctx,
    { actionKey: input.actionKey, caseId: input.caseId, channel: 'email', kind: input.kind, recipient: input.to, summary: input.subject },
    async () => {
      assertLiveRecipientAllowed(ctx, input.to);
      const sent = await ctx.adapters.email.send({
        to: input.to,
        subject: input.subject,
        text: input.text,
        replyToProviderMessageId: input.replyTo ?? undefined,
        idempotencyKey: input.actionKey,
      });
      return { providerMessageId: sent.providerMessageId, threadId: sent.threadId };
    },
  );
  if (result.state === 'sent' && !result.duplicate) {
    ctx.store.insertMessage({
      caseId: input.caseId,
      channel: 'email',
      direction: 'out',
      providerMessageId: result.providerMessageId,
      threadId: result.threadId,
      from: ctx.config.email.fromAddress,
      to: input.to,
      subject: input.subject,
      body: input.text,
    });
    ctx.store.audit(input.caseId, 'agent', 'email_sent', { kind: input.kind, actionKey: input.actionKey });
  }
  return result;
}

export async function postSlack(
  ctx: EngineContext,
  input: { actionKey: string; caseId: string | null; kind: string; channel: string; text: string; buttons?: SlackButton[] },
): Promise<SendResult> {
  return sendOnce(
    ctx,
    { actionKey: input.actionKey, caseId: input.caseId, channel: 'slack', kind: input.kind, recipient: input.channel, summary: input.text.split('\n')[0]!.slice(0, 120) },
    async () => {
      const r = await ctx.adapters.slack.post({ channel: input.channel, text: input.text, buttons: input.buttons, idempotencyKey: input.actionKey });
      return { providerMessageId: r.ts, threadId: null };
    },
  );
}

/** Live connectors may only reach addresses the team explicitly listed. Mocks are unrestricted. */
export function assertLiveRecipientAllowed(ctx: EngineContext, address: string, adapterMode = ctx.adapters.email.mode): void {
  if (adapterMode === 'mock') return;
  if (!ctx.config.liveRecipientAllowlist.includes(address.toLowerCase())) {
    throw new DefiniteSendFailure(`${address} is not on OB_LIVE_RECIPIENT_ALLOWLIST; nothing was sent`);
  }
}

export function isManager(ctx: EngineContext, slackUserId: string): boolean {
  return ctx.config.managerSlackIds.includes(slackUserId);
}

export function pendingVerification(ctx: EngineContext): OutboxRow[] {
  return ctx.store.outbox().filter((o) => o.status === 'uncertain');
}
