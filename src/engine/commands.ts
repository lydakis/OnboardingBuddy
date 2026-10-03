import type { EngineContext } from './context.ts';
import { isManager, postSlack } from './context.ts';
import { startCase, statusText } from './intake.ts';
import type { CaseRow, SlackButton, SlackCommandEvent } from '../types.ts';

export interface CommandReply {
  text: string;
  buttons?: SlackButton[];
}

export type CommandHandler = (ctx: EngineContext, args: string[], event: SlackCommandEvent) => Promise<CommandReply>;

/** Commands any phase module can register. Manager-only unless listed in OPEN_COMMANDS. */
const handlers = new Map<string, { handler: CommandHandler; usage: string }>();
const OPEN_COMMANDS = new Set(['help']);

export function registerCommand(name: string, usage: string, handler: CommandHandler, open = false): void {
  handlers.set(name, { handler, usage });
  if (open) OPEN_COMMANDS.add(name);
}

export function isCommand(name: string): boolean {
  return handlers.has(name.toLowerCase());
}

export function commandUsages(): string[] {
  return [...handlers.values()].map((h) => h.usage);
}

export function tokenize(text: string): string[] {
  const out: string[] = [];
  const re = /"([^"]*)"|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) out.push(m[1] ?? m[2]!);
  return out;
}

export function findCase(ctx: EngineContext, ref: string | undefined): CaseRow {
  if (!ref) throw new UserError('Which case? Give a case id like FW-001 or the worker email.');
  const c = ctx.store.getCase(ref.toUpperCase()) ?? ctx.store.findOpenCasesByEmail(ref.toLowerCase())[0];
  if (!c) throw new UserError(`No case found for "${ref}".`);
  return c;
}

export class UserError extends Error {}

/** Entry point for every manager command (slash command, button click, or mock CLI). */
export async function handleSlackCommand(ctx: EngineContext, event: SlackCommandEvent): Promise<CommandReply & { duplicate?: boolean }> {
  if (!ctx.store.claimEvent(`slack:${event.eventId}`, null, 'processing')) {
    return { text: '(duplicate Slack event ignored)', duplicate: true };
  }
  const [rawName, ...args] = tokenize(event.text.replace(/^\/onboard\s*/, ''));
  const name = (rawName ?? 'help').toLowerCase();
  const entry = handlers.get(name);
  let reply: CommandReply;
  if (!entry) {
    reply = { text: `Unknown command "${name}".\n${helpText()}` };
  } else if (!OPEN_COMMANDS.has(name) && !isManager(ctx, event.userId)) {
    ctx.store.audit(null, event.userId, 'unauthorized_command', { command: name });
    reply = { text: `Sorry, only an authorized onboarding manager can run "${name}".` };
  } else {
    try {
      reply = await entry.handler(ctx, args, event);
    } catch (err) {
      if (!(err instanceof UserError)) throw err;
      reply = { text: `⚠️ ${err.message}` };
    }
  }
  ctx.store.setEventOutcome(`slack:${event.eventId}`, null, 'handled');
  await postSlack(ctx, { actionKey: `slack:reply:${event.eventId}`, caseId: null, kind: 'command_reply', channel: event.channel, text: reply.text, buttons: reply.buttons });
  return reply;
}

function helpText(): string {
  return ['*Onboarding commands* (`/onboard ...`):', ...[...handlers.values()].map((h) => `• \`${h.usage}\``)].join('\n');
}

registerCommand('help', 'help', async () => ({ text: helpText() }), true);

registerCommand('start', 'start "<worker name>" <worker email>', async (ctx, args, event) => {
  const email = args.at(-1);
  const name = args.slice(0, -1).join(' ').trim();
  if (!email || !name || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new UserError('Usage: start "<worker name>" <worker email>');
  const { case: c, created } = await startCase(ctx, { managerSlackId: event.userId, workerName: name, workerEmail: email });
  return created
    ? { text: `📨 Started ${c.id} for *${c.worker_name}*. Welcome email with CV + questionnaire request sent to ${c.worker_email}.`, buttons: [{ text: 'Status', command: `status ${c.id}` }] }
    : { text: `ℹ️ ${c.worker_email} already has an open case (${c.id}); no new email sent.`, buttons: [{ text: 'Status', command: `status ${c.id}` }] };
});

registerCommand('status', 'status [case id | worker email]', async (ctx, args) => {
  if (args.length === 0) {
    const cases = ctx.store.listCases();
    if (cases.length === 0) return { text: 'No onboarding cases yet.' };
    return { text: cases.map((c) => `• ${c.id} ${c.worker_name} — ${c.status}${c.needs_attention ? ' ⚠️' : ''}`).join('\n') };
  }
  return { text: statusText(ctx, findCase(ctx, args[0])) };
});

registerCommand('verify-send', 'verify-send <action key> sent|not-sent', async (ctx, args, event) => {
  const [key, verdict] = args;
  const row = key ? ctx.store.getOutbox(key) : undefined;
  if (!row || row.status !== 'uncertain') throw new UserError('Give the action key of a send marked uncertain.');
  if (verdict === 'sent') ctx.store.updateOutbox(key!, { status: 'sent', error: 'confirmed sent by manager' });
  else if (verdict === 'not-sent') ctx.store.updateOutbox(key!, { status: 'failed', error: 'confirmed not sent by manager; may be retried' });
  else throw new UserError('Verdict must be "sent" or "not-sent".');
  ctx.store.audit(row.case_id, event.userId, 'send_verified', { key, verdict });
  if (row.case_id) ctx.store.updateCase(row.case_id, { needs_attention: null });
  return { text: `Recorded: ${key} ${verdict}.` };
});

registerCommand('clear', 'clear <case> "what you checked"', async (ctx, args, event) => {
  const c = findCase(ctx, args[0]);
  const note = args.slice(1).join(' ').trim();
  if (!c.needs_attention) return { text: `${c.id} has no open issue.` };
  if (!note) throw new UserError('Add a note saying what you checked.');
  ctx.store.audit(c.id, event.userId, 'attention_cleared', { issue: c.needs_attention, note });
  ctx.store.updateCase(c.id, { needs_attention: null });
  return { text: `Cleared the open issue on ${c.id}: "${note}".` };
});
