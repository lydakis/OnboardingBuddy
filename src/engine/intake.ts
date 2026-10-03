import type { EngineContext } from './context.ts';
import { postSlack, sendEmail } from './context.ts';
import { CHECKLIST, CV_ITEM, QUESTIONS, REQUIRED_KEYS, parseAnswers, questionnaireTemplate } from './questionnaire.ts';
import type { ParsedAnswer } from './questionnaire.ts';
import { extractFreeformAnswers } from './reply-extract.ts';
import type { CaseRow, InboundEmail } from '../types.ts';

const MAX_FOLLOW_UPS = 3;

export function normalizeAddress(raw: string): string {
  const m = raw.match(/<([^>]+)>/);
  return (m ? m[1]! : raw).trim().toLowerCase();
}

/** Exact match, the same mailbox without a +tag (Gmail replies to +aliases come from the base address), or a manager-approved address. */
export function senderMatches(ctx: EngineContext, c: CaseRow, from: string): boolean {
  if (from === c.worker_email) return true;
  const base = (a: string) => a.replace(/\+[^@]*@/, '@');
  if (base(from) === base(c.worker_email) && !from.includes('+')) return true;
  return Boolean(ctx.store.db.prepare('SELECT 1 FROM case_senders WHERE case_id = ? AND address = ?').get(c.id, from));
}

export async function startCase(
  ctx: EngineContext,
  input: { managerSlackId: string; workerName: string; workerEmail: string },
): Promise<{ case: CaseRow; created: boolean }> {
  const email = normalizeAddress(input.workerEmail);
  const existing = ctx.store.findOpenCasesByEmail(email)[0];
  if (existing) return { case: existing, created: false };

  const id = `FW-${String(ctx.store.nextCaseNumber()).padStart(3, '0')}`;
  const row = ctx.store.transaction(() => {
    const c = ctx.store.insertCase({ id, worker_name: input.workerName, worker_email: email, manager_slack_id: input.managerSlackId, status: 'intake' });
    for (const item of CHECKLIST) ctx.store.insertChecklistItem(id, item.key, item.label);
    ctx.store.audit(id, input.managerSlackId, 'case_started', { workerName: input.workerName });
    return c;
  });
  await sendWelcome(ctx, row);
  return { case: ctx.store.getCase(id)!, created: true };
}

async function sendWelcome(ctx: EngineContext, c: CaseRow): Promise<void> {
  const company = ctx.config.companyName;
  const text = [
    `Hi ${c.worker_name},`,
    '',
    `Welcome to ${company}! We're glad you accepted our offer. I'm the onboarding assistant and I'll help you get set up before your first day.`,
    '',
    'Please reply to this email with:',
    '  1. Your CV or résumé (attach it, or paste it under a line that says "CV:")',
    '  2. These three details (just fill in after each colon, or tell me in your own words):',
    '',
    questionnaireTemplate(),
    '',
    "Once you join our team Slack, I'll ask you a few quick questions there.",
    'Your answers are used to plan your training and to improve how we plan onboarding.',
    '',
    `— Onboarding assistant, ${company}`,
    '(This is a demo with a fictional company. Do not send real personal documents.)',
  ].join('\n');
  const r = await sendEmail(ctx, {
    actionKey: `email:welcome:${c.id}`,
    caseId: c.id,
    kind: 'welcome',
    to: c.worker_email,
    subject: `Welcome to ${company.split(' (')[0]} — a few things before your first day`,
    text,
  });
  if (r.state === 'sent') ctx.store.updateCase(c.id, { email_thread_id: r.threadId });
}

export type InboundOutcome =
  | { outcome: 'duplicate' }
  | { outcome: 'unmatched'; reason: string }
  | { outcome: 'quarantined'; caseId: string; reason: string; from?: string }
  | { outcome: 'updated'; caseId: string; completed: string[]; stillMissing: string[]; intakeComplete: boolean };

export async function processInboundEmail(ctx: EngineContext, msg: InboundEmail): Promise<InboundOutcome> {
  const { store } = ctx;
  const eventKey = `email:${msg.providerMessageId}`;
  const from = normalizeAddress(msg.from);

  // Phase A: state changes in one transaction, including the dedupe claim.
  const phaseA = store.transaction((): InboundOutcome | { outcome: 'accepted'; caseRow: CaseRow; messageId: string; correlation: string } => {
    if (!store.claimEvent(eventKey, null, 'processing')) return { outcome: 'duplicate' };

    const threadMatch = store.findOutboundEmail([msg.inReplyTo, ...(msg.references ?? [])].filter((x): x is string => Boolean(x)));
    let caseRow: CaseRow | undefined;
    let correlation: string;
    if (threadMatch) {
      caseRow = store.getCase(threadMatch.case_id);
      correlation = 'thread+sender';
      if (caseRow && !senderMatches(ctx, caseRow, from)) {
        // Right thread, wrong sender: a forward, a shared inbox, or spoofing. Never apply it.
        const reason = `Reply on ${caseRow.id}'s thread came from ${from}, expected ${caseRow.worker_email}`;
        store.insertMessage({ caseId: null, channel: 'email', direction: 'in', providerMessageId: msg.providerMessageId, threadId: msg.threadId, inReplyTo: msg.inReplyTo, from, to: msg.to, subject: msg.subject, body: msg.text, correlation: 'quarantined:sender_mismatch' });
        store.audit(caseRow.id, 'system', 'reply_quarantined', { reason });
        store.updateCase(caseRow.id, { needs_attention: reason });
        store.setEventOutcome(eventKey, caseRow.id, 'quarantined');
        return { outcome: 'quarantined', caseId: caseRow.id, reason, from } as InboundOutcome;
      }
    } else {
      const candidates = store.findOpenCasesByEmail(from);
      correlation = 'sender_only';
      caseRow = candidates.length === 1 ? candidates[0] : undefined;
      if (candidates.length > 1) {
        const reason = `Sender ${from} matches ${candidates.length} open cases and no thread id`;
        store.insertMessage({ caseId: null, channel: 'email', direction: 'in', providerMessageId: msg.providerMessageId, from, to: msg.to, subject: msg.subject, body: msg.text, correlation: 'unmatched:ambiguous' });
        store.setEventOutcome(eventKey, null, 'unmatched');
        return { outcome: 'unmatched', reason };
      }
    }
    if (!caseRow) {
      store.insertMessage({ caseId: null, channel: 'email', direction: 'in', providerMessageId: msg.providerMessageId, from, to: msg.to, subject: msg.subject, body: msg.text, correlation: 'unmatched' });
      store.audit(null, 'system', 'email_unmatched', { from, subject: msg.subject });
      store.setEventOutcome(eventKey, null, 'unmatched');
      return { outcome: 'unmatched', reason: `No open case for ${from}` };
    }
    const messageId = store.insertMessage({
      caseId: caseRow.id, channel: 'email', direction: 'in', providerMessageId: msg.providerMessageId, threadId: msg.threadId,
      inReplyTo: msg.inReplyTo, from, to: msg.to, subject: msg.subject, body: msg.text, correlation,
    });
    store.setEventOutcome(eventKey, caseRow.id, 'accepted');
    return { outcome: 'accepted', caseRow, messageId, correlation };
  });

  if (phaseA.outcome !== 'accepted') {
    await ctx.adapters.email.acknowledge(msg.providerMessageId);
    if (phaseA.outcome === 'quarantined') {
      const c = store.getCase(phaseA.caseId)!;
      await postSlack(ctx, {
        actionKey: `slack:quarantine:${msg.providerMessageId}`, caseId: c.id, kind: 'quarantine', channel: c.manager_slack_id,
        text: `🔒 A reply on *${c.worker_name}*'s onboarding thread came from *${from}*, not ${c.worker_email}. I haven't used it. If ${from} is ${c.worker_name}, accept it and I'll process this and future replies from that address.`,
        buttons: [{ text: `It's ${c.worker_name.split(' ')[0]}, accept`, command: `accept-sender ${c.id} ${from} ${msg.providerMessageId}`, style: 'primary' }],
      });
    }
    return phaseA;
  }

  const { caseRow, messageId } = phaseA;
  // Questions still open after the labelled parse go to the local model (validated, verbatim excerpts).
  const labelled = new Set(parseAnswers(msg.text).answers.filter((a) => 'value' in a.result).map((a) => a.key));
  const open = store.checklist(caseRow.id).filter((i) => i.status !== 'complete' && i.key !== CV_ITEM.key && !labelled.has(i.key)).map((i) => i.key);
  const modelAnswers = await extractFreeformAnswers(ctx, caseRow, msg.text, open);
  const completed = store.transaction(() => applyReply(ctx, caseRow, msg, messageId, modelAnswers));
  const items = store.checklist(caseRow.id);
  const stillMissing = items.filter((i) => REQUIRED_KEYS.has(i.key) && i.status !== 'complete').map((i) => i.key);
  const intakeComplete = stillMissing.length === 0;

  if (intakeComplete && caseRow.status === 'intake') {
    store.setStatus(caseRow.id, 'intake_complete');
    store.audit(caseRow.id, 'agent', 'intake_complete');
    await sendEmail(ctx, {
      actionKey: `email:intake-thanks:${caseRow.id}`, caseId: caseRow.id, kind: 'intake_thanks', to: caseRow.worker_email,
      subject: 'Thanks — we have everything we need', replyTo: msg.providerMessageId,
      text: `Hi ${preferredName(ctx, caseRow)},\n\nThanks, that's everything for now. Next, you'll get an invitation to our team Slack. Once you're in, I'll ask you a few quick questions there.\n\n— Onboarding assistant`,
    });
    // Read the CV now and pick the tailored Slack questions for this worker.
    const { extractExperience } = await import('./plan.ts');
    const { generateItems, labelFor } = await import('./slack-questionnaire.ts');
    const extraction = await extractExperience(ctx, caseRow);
    const cvText = String(store.documents(caseRow.id, 'cv').at(-1)?.content_text ?? '');
    const planned = generateItems(ctx, caseRow, extraction.facts, cvText);
    await postSlack(ctx, {
      actionKey: `slack:intake-complete:${caseRow.id}`, caseId: caseRow.id, kind: 'intake_complete', channel: caseRow.manager_slack_id,
      text: `✅ Intake complete for *${caseRow.worker_name}* (${caseRow.id}). CV, name and Slack email received.\nAfter they join Slack I'll ask ${planned.length} questions: ${planned.map((q) => labelFor(q.field)).join(', ')}.`,
      buttons: [{ text: 'Invite to Slack', command: `invite ${caseRow.id}`, style: 'primary' }, { text: 'Status', command: `status ${caseRow.id}` }],
    });
  } else if (!intakeComplete) {
    await followUp(ctx, caseRow, msg.providerMessageId);
    const labels = new Map(items.map((i) => [i.key, i.label]));
    await postSlack(ctx, {
      actionKey: `slack:reply-update:${caseRow.id}:${msg.providerMessageId}`, caseId: caseRow.id, kind: 'reply_update', channel: caseRow.manager_slack_id,
      text: `📩 *${caseRow.worker_name}* replied${completed.length ? ` with ${completed.map((k) => labels.get(k)).join(', ')}` : ''}. Still missing: ${stillMissing.map((k) => labels.get(k)).join(', ')}. I've emailed them about it.`,
      buttons: [{ text: 'Status', command: `status ${caseRow.id}` }],
    });
  }
  await ctx.adapters.email.acknowledge(msg.providerMessageId);
  return { outcome: 'updated', caseId: caseRow.id, completed, stillMissing, intakeComplete };
}

function applyReply(ctx: EngineContext, c: CaseRow, msg: InboundEmail, messageId: string, modelAnswers: ParsedAnswer[] = []): string[] {
  const { store } = ctx;
  const completed: string[] = [];
  const current = new Map(store.checklist(c.id).map((i) => [i.key, i]));
  const parsed = parseAnswers(msg.text);
  const { cvText } = parsed;
  const answers = [...parsed.answers, ...modelAnswers.filter((m) => !parsed.answers.some((a) => a.key === m.key))];

  for (const a of answers) {
    const before = current.get(a.key);
    if ('value' in a.result) {
      if (before?.status === 'complete' && before.value === a.result.value) continue;
      store.updateChecklistItem(c.id, a.key, { status: 'complete', value: a.result.value, excerpt: a.excerpt, sourceMessageId: messageId });
      store.audit(c.id, 'worker', before?.status === 'complete' ? 'answer_updated' : 'answer_recorded', { key: a.key, source: modelAnswers.includes(a) ? 'model' : 'labelled' });
      completed.push(a.key);
    } else if (before?.status !== 'complete') {
      store.updateChecklistItem(c.id, a.key, { status: 'missing', value: null, excerpt: a.excerpt, note: a.result.error, sourceMessageId: messageId });
      store.audit(c.id, 'worker', 'answer_invalid', { key: a.key, error: a.result.error });
    }
  }

  const docs = msg.attachments.filter((a) => /pdf|word|officedocument|text\/|rtf/i.test(a.contentType) || /\.(pdf|docx?|txt|md|rtf)$/i.test(a.filename));
  const cvAttachment = docs.find((a) => /cv|resume|résumé/i.test(a.filename)) ?? docs[0];
  if (cvAttachment || cvText) {
    const text = cvAttachment ? (cvAttachment.text ?? null) : cvText;
    const filename = cvAttachment?.filename ?? 'cv-pasted-in-email.txt';
    store.insertDocument({ caseId: c.id, kind: 'cv', filename, contentType: cvAttachment?.contentType ?? 'text/plain', text, sourceMessageId: messageId });
    if (text && text.trim().length > 40) {
      const firstLine = text.trim().split('\n').find((l) => l.trim())!.trim().slice(0, 140);
      store.updateChecklistItem(c.id, CV_ITEM.key, { status: 'complete', value: filename, excerpt: firstLine, sourceMessageId: messageId });
      completed.push(CV_ITEM.key);
    } else {
      store.updateChecklistItem(c.id, CV_ITEM.key, {
        status: 'needs_review', value: filename, sourceMessageId: messageId,
        note: `Received ${filename} (${cvAttachment?.contentType ?? 'unknown'}) but could not read its text. Ask for a text or DOCX copy, or review manually.`,
      });
      store.audit(c.id, 'system', 'cv_unreadable', { filename });
    }
    store.audit(c.id, 'worker', 'cv_received', { filename });
  }
  return completed;
}

async function followUp(ctx: EngineContext, c: CaseRow, triggeringMessageId: string): Promise<void> {
  const items = ctx.store.checklist(c.id).filter((i) => REQUIRED_KEYS.has(i.key) && i.status !== 'complete');
  const sentFollowUps = ctx.store.outbox(c.id).filter((o) => o.kind === 'follow_up' && o.status === 'sent').length;
  if (sentFollowUps >= MAX_FOLLOW_UPS) {
    await postSlack(ctx, {
      actionKey: `slack:followup-escalation:${c.id}:${triggeringMessageId}`, caseId: c.id, kind: 'escalation', channel: c.manager_slack_id,
      text: `⚠️ ${c.worker_name} (${c.id}) still has ${items.length} open intake item(s) after ${sentFollowUps} follow-ups: ${items.map((i) => i.label).join(', ')}.`,
      buttons: [{ text: 'Status', command: `status ${c.id}` }],
    });
    return;
  }
  const lines = items.map((i) => {
    if (i.key === CV_ITEM.key) return i.status === 'needs_review' ? `• CV: ${i.note}` : '• CV: please attach your CV/résumé, or paste it under a line that says "CV:".';
    const q = QUESTIONS.find((x) => x.key === i.key)!;
    return `• ${q.label}: ${i.note ?? q.prompt}`;
  });
  await sendEmail(ctx, {
    actionKey: `email:followup:${c.id}:${triggeringMessageId}`, caseId: c.id, kind: 'follow_up', to: c.worker_email,
    subject: 'A few more details for your onboarding', replyTo: triggeringMessageId,
    text: [
      `Hi ${preferredName(ctx, c)},`, '', 'Thanks for your reply! We still need:', '', ...lines, '',
      'You can reply in the same "Label: answer" format, for example:', '',
      ...items.filter((i) => i.key !== CV_ITEM.key).map((i) => `${i.label}: `), '', '— Onboarding assistant',
    ].join('\n'),
  });
}

function preferredName(ctx: EngineContext, c: CaseRow): string {
  const item = ctx.store.checklist(c.id).find((i) => i.key === 'preferred_name');
  return item?.status === 'complete' && item.value ? item.value : c.worker_name.split(' ')[0]!;
}

export async function pollEmail(ctx: EngineContext): Promise<InboundOutcome[]> {
  const inbound = await ctx.adapters.email.poll();
  const results: InboundOutcome[] = [];
  for (const msg of inbound) results.push(await processInboundEmail(ctx, msg));
  return results;
}

export function statusText(ctx: EngineContext, c: CaseRow): string {
  const icon = { complete: '✅', missing: '⬜', needs_review: '⚠️' } as const;
  const items = ctx.store.checklist(c.id).filter((i) => CHECKLIST.some((x) => x.key === i.key));
  const done = items.filter((i) => i.status === 'complete').length;
  const lines = [
    `*${c.worker_name}* (${c.id}) — status: *${c.status}*  ·  intake ${done}/${items.length}`,
    ...items.map((i) => `${icon[i.status]} ${i.label}${i.status === 'complete' ? `: ${truncate(i.value ?? '', 60)}` : i.note ? ` — ${truncate(i.note, 90)}` : ''}`),
  ];
  if (c.needs_attention) lines.push(`⚠️ Needs attention: ${c.needs_attention}`);
  const inv = ctx.store.db.prepare('SELECT state, email, slack_user_id, review_reason FROM invitations WHERE case_id = ?').get(c.id) as Record<string, string | null> | undefined;
  if (inv) lines.push(`Slack: invitation *${inv.state}* (${inv.email})${inv.slack_user_id ? ` · linked <@${inv.slack_user_id}>` : ''}${inv.review_reason ? ` · ${inv.review_reason}` : ''}`);
  return lines.join('\n');
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}
