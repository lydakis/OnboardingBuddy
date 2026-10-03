// Tailored questionnaire in Slack (specs/slack-questionnaire-build.md).
// Items are chosen deterministically from the CV facts when intake completes, asked one at
// a time in the worker's DM after they join, and recorded with the worker's own words as
// the excerpt. Only the linked worker can answer; the model never picks fields or options.
import type { EngineContext } from './context.ts';
import { postSlack } from './context.ts';
import { UserError, findCase, registerCommand } from './commands.ts';
import { EQUIPMENT, detectInstructionText } from './extract.ts';
import type { Fact } from './extract.ts';
import { now } from '../db/store.ts';
import type { CaseRow, SlackButton, SlackButtonRow } from '../types.ts';

export type ItemKind = 'confirm' | 'number_text' | 'enum' | 'ratings' | 'text';
export interface Option { value: string; label: string }
export interface QItem {
  case_id: string;
  seq: number;
  field: string;
  kind: ItemKind;
  prompt: string;
  options_json: string | null;
  status: 'pending' | 'asked' | 'answered';
  answer_raw: string | null;
  answer_value_json: string | null;
  excerpt: string | null;
  nudges: number;
}

const MAX_NUDGES = 3;
const RATINGS: Option[] = [
  { value: 'navigation', label: 'Navigation' },
  { value: 'scanning', label: 'Scanning & proof of delivery' },
  { value: 'handoff', label: 'Customer handoff' },
];
const SHIFTS: Option[] = [
  { value: 'early', label: 'Early · 6:00' },
  { value: 'day', label: 'Day · 9:00' },
  { value: 'late', label: 'Late · 13:00' },
];
const EQUIPMENT_SYNONYMS: [RegExp, string][] = [
  [/hand ?held|scanner/, 'handheld scanner'],
  [/pallet (jack|truck)/, 'pallet jack'],
  [/hand ?truck|dolly/, 'hand truck'],
  [/fork ?lift|lift truck/, 'forklift'],
  [/box (truck|van)|straight truck/, 'box truck'],
];

export function items(ctx: EngineContext, caseId: string): QItem[] {
  return ctx.store.db.prepare('SELECT * FROM questionnaire_items WHERE case_id = ? ORDER BY seq').all(caseId) as unknown as QItem[];
}

const opts = (item: QItem): Option[] => (item.options_json ? (JSON.parse(item.options_json) as Option[]) : []);

/** Picks the questions for this worker from their CV facts (template wording; P0). */
export function planQuestions(facts: Fact[], cvText: string, depotZone: string): Omit<QItem, 'case_id' | 'status' | 'answer_raw' | 'answer_value_json' | 'excerpt' | 'nudges'>[] {
  const cv = facts.filter((f) => f.source === 'cv');
  const parcel = cv.filter((f) => f.name === 'parcel_delivery_years');
  const years = Math.round(parcel.reduce((a, f) => a + Number(f.value), 0));
  const employer = parcel[0]?.excerpt.split(/\s[—–-]\s/)[0]?.split(',').slice(1).join(',').trim();
  const out: ReturnType<typeof planQuestions> = [];
  const add = (field: string, kind: ItemKind, prompt: string, options: Option[] = []) =>
    out.push({ seq: out.length + 1, field, kind, prompt, options_json: options.length ? JSON.stringify(options) : null });

  if (years > 0) {
    add('delivery', 'confirm', `Your CV shows about ${years} year${years === 1 ? '' : 's'} on parcel routes${employer ? ` (${employer})` : ''}. Is that right?`, [
      { value: 'yes', label: "Yes, that's right" },
      { value: 'different', label: "It's different" },
    ]);
    add('route_type', 'enum', 'What kind of route did you mostly run?', ['Residential', 'Business', 'Mixed', 'Rural'].map((l) => ({ value: l.toLowerCase(), label: l })));
  } else {
    add('delivery', 'number_text', "Your CV doesn't list delivery work. Have you done any, like parcel, food, grocery or app-based delivery? What kind and roughly how many years? Reply \"none\" if not.");
  }
  if (!cv.some((f) => f.name === 'license_class')) {
    add('license_class', 'enum', "Which driver's license do you hold?", [
      { value: 'none', label: 'None' },
      { value: 'standard', label: 'Standard (Class C/D)' },
      { value: 'cdl', label: 'CDL' },
    ]);
  }
  if (!/box truck|\bvan\b/i.test(cvText) && !cv.some((f) => f.name === 'equipment' && f.value === 'box truck')) {
    add('largest_vehicle', 'enum', "What's the largest vehicle you've driven for work?", [
      { value: 'none', label: 'None' },
      { value: 'car', label: 'Car' },
      { value: 'cargo_van', label: 'Cargo van' },
      { value: 'box_truck', label: 'Box truck' },
    ]);
  }
  if (!cv.some((f) => f.name === 'equipment')) {
    add('equipment', 'text', 'Which of these have you used: handheld scanner, pallet jack, hand truck, forklift, box truck? Reply with any that apply, or "none".');
  }
  add('delivery_app', 'enum', 'Have you used a delivery or route app on a handheld or phone before?', [
    { value: 'yes', label: 'Yes' },
    { value: 'no', label: 'No' },
  ]);
  add('area_familiarity', 'enum', `How well do you know the ${depotZone} area?`, [
    { value: 'not_yet', label: 'Not yet' },
    { value: 'somewhat', label: 'Somewhat' },
    { value: 'very_well', label: 'Very well' },
  ]);
  add('preferred_shift', 'enum', 'Which shift would you prefer?', SHIFTS);
  add('confidence', 'ratings', 'How confident are you with each of these? 1 = new to it, 5 = very confident.', RATINGS);
  return out;
}

export function generateItems(ctx: EngineContext, c: CaseRow, facts: Fact[], cvText: string): QItem[] {
  if (items(ctx, c.id).length) return items(ctx, c.id);
  const zone = process.env.OB_DEPOT_ZONE ?? 'Columbus East';
  ctx.store.transaction(() => {
    for (const q of planQuestions(facts, cvText, zone)) {
      ctx.store.db
        .prepare(`INSERT INTO questionnaire_items (case_id, seq, field, kind, prompt, options_json, status) VALUES (?, ?, ?, ?, ?, ?, 'pending')`)
        .run(c.id, q.seq, q.field, q.kind, q.prompt, q.options_json);
    }
    ctx.store.audit(c.id, 'agent', 'questionnaire_planned', { fields: planQuestions(facts, cvText, zone).map((q) => q.field) });
  });
  return items(ctx, c.id);
}

function buttonsFor(c: CaseRow, item: QItem): { buttons?: SlackButton[]; rows?: SlackButtonRow[] } {
  if (item.kind === 'ratings') {
    return { rows: opts(item).map((o) => ({ label: o.label, buttons: [1, 2, 3, 4, 5].map((n) => ({ text: String(n), command: `answer ${c.id} confidence ${o.value}=${n}` })) })) };
  }
  if (item.kind === 'confirm' || item.kind === 'enum') {
    return { buttons: opts(item).map((o) => ({ text: o.label, command: `answer ${c.id} ${item.field} ${o.value}` })) };
  }
  return {};
}

async function ask(ctx: EngineContext, c: CaseRow, item: QItem, keySuffix = ''): Promise<void> {
  const all = items(ctx, c.id);
  ctx.store.db.prepare(`UPDATE questionnaire_items SET status = 'asked' WHERE case_id = ? AND seq = ? AND status = 'pending'`).run(c.id, item.seq);
  await postSlack(ctx, {
    actionKey: `slack:q:${c.id}:${item.seq}${keySuffix}`, caseId: c.id, kind: 'question', channel: c.slack_user_id!,
    text: `*Question ${item.seq} of ${all.length}*\n${item.prompt}`,
    ...buttonsFor(c, item),
  });
}

export function currentItem(ctx: EngineContext, caseId: string): QItem | undefined {
  const list = items(ctx, caseId);
  return list.find((i) => i.status === 'asked') ?? list.find((i) => i.status === 'pending');
}

export async function reask(ctx: EngineContext, c: CaseRow, eventId: string): Promise<void> {
  const item = currentItem(ctx, c.id);
  if (!item) return;
  await postSlack(ctx, { actionKey: `slack:q-back:${c.id}:${eventId}`, caseId: c.id, kind: 'question', channel: c.slack_user_id!, text: 'Back to your questions:' });
  await ask(ctx, c, item, `:re:${eventId}`);
}

export function isSideQuestion(text: string): boolean {
  return /\?\s*$/.test(text) || /^(what|when|where|how|who|can|could|do|does|is|will)\b/i.test(text.trim());
}

/** Called once the worker is a confirmed member: welcome line + question 1. */
export async function startQuestionnaire(ctx: EngineContext, c: CaseRow, name: string): Promise<void> {
  const first = currentItem(ctx, c.id);
  if (!first) return;
  ctx.store.setStatus(c.id, 'questionnaire');
  await postSlack(ctx, {
    actionKey: `slack:q-intro:${c.id}`, caseId: c.id, kind: 'question', channel: c.slack_user_id!,
    text: `Hi ${name}, welcome to the team! I have ${items(ctx, c.id).length} quick questions so we can plan your first two weeks. Tap a button or just type your answer.`,
  });
  await ask(ctx, ctx.store.getCase(c.id)!, first);
}

// ---- answer parsing ------------------------------------------------------

export function parseDelivery(text: string): { years: number; kind: 'parcel' | 'other' } | 'none' | null {
  const t = text.toLowerCase();
  if (/^\s*(none|no|nope|never)\b/.test(t) && !/\d/.test(t)) return 'none';
  const months = t.match(/(\d+(?:\.\d+)?)\s*months?/);
  const num = t.match(/(\d+(?:\.\d+)?)/);
  if (!num) return null;
  const years = months ? Math.round((Number(months[1]) / 12) * 10) / 10 : Number(num[1]);
  const kind = /parcel|route|courier|package/.test(t) ? 'parcel' : 'other';
  return { years, kind };
}

export function parseEquipment(text: string): string[] {
  const t = text.toLowerCase();
  const found = new Set<string>();
  for (const e of EQUIPMENT) if (t.includes(e)) found.add(e);
  for (const [re, e] of EQUIPMENT_SYNONYMS) if (re.test(t)) found.add(e);
  return [...found]; // matched items win over "none"
}

function matchOption(item: QItem, text: string): Option | undefined {
  const t = text.toLowerCase().trim();
  return opts(item).find((o) => t === o.value || t === o.label.toLowerCase() || t.startsWith(o.label.toLowerCase().split(' ')[0]!.replace(/[,·]/g, '')) || new RegExp(`\\b${o.value.replace('_', '[ _]')}\\b`).test(t));
}

type Outcome = { recorded: string } | { nudge: string; buttons?: SlackButton[]; rows?: SlackButtonRow[] };

function interpret(c: CaseRow, item: QItem, raw: string, viaButton: boolean): { value: unknown; summary: string } | { nudge: string; reorder?: Option[] } {
  const text = raw.trim();
  switch (item.kind) {
    case 'confirm': {
      if (/^(yes|yep|yeah|correct|that'?s right|right)\b/i.test(text)) return { value: { confirmed: true }, summary: "CV experience confirmed" };
      if (text === 'different' || /^(no|it'?s different|not quite)\b/i.test(text)) return { nudge: 'Thanks! Roughly how many years, and what kind of delivery? For example "parcel routes, 3 years".' };
      const d = parseDelivery(text);
      if (d && d !== 'none') return { value: d, summary: `${d.kind === 'parcel' ? 'parcel delivery' : 'other delivery'} · ${d.years} yrs` };
      return { nudge: 'Please pick one of the options above.' };
    }
    case 'number_text': {
      const d = parseDelivery(text);
      if (d === 'none') return { value: { years: 0, kind: 'other' }, summary: 'no delivery experience' };
      if (!d) return { nudge: 'Roughly how many years? For example "food delivery by bike, 2 years", or "none".' };
      const what = /food|restaurant/.test(text.toLowerCase()) ? 'food delivery' : d.kind === 'parcel' ? 'parcel delivery' : 'delivery';
      return { value: d, summary: `${what} · ${d.years} yr${d.years === 1 ? '' : 's'}` };
    }
    case 'enum': {
      if (item.field === 'preferred_shift' && /night|overnight|graveyard/i.test(text)) {
        const all = opts(item);
        return { nudge: "Fleetwing routes don't run overnight. The latest start is 13:00. Want that one?", reorder: [all.find((o) => o.value === 'late')!, ...all.filter((o) => o.value !== 'late')] };
      }
      const o = matchOption(item, text);
      return o ? { value: o.value, summary: o.label } : { nudge: 'Please pick one of the options above.' };
    }
    case 'text': {
      const found = parseEquipment(text);
      if (found.length) return { value: found, summary: found.join(', ') };
      if (/^\s*(none|no|nothing)\b/i.test(text)) return { value: [], summary: 'none' };
      return { nudge: 'Which of these have you used: handheld scanner, pallet jack, hand truck, forklift, box truck? Or reply "none".' };
    }
    case 'ratings': {
      const prev = item.answer_value_json ? (JSON.parse(item.answer_value_json) as Record<string, number>) : {};
      const m = text.match(/^(navigation|scanning|handoff)=([1-5])$/);
      if (viaButton && m) prev[m[1]!] = Number(m[2]);
      else {
        const nums = text.match(/[1-5]/g);
        if (nums?.length === 3) RATINGS.forEach((r, i) => (prev[r.value] = Number(nums[i])));
        else return { nudge: 'Tap a number for each row, or type three numbers like "4 3 5".' };
      }
      return { value: prev, summary: RATINGS.filter((r) => prev[r.value]).map((r) => `${r.label} ${prev[r.value]}`).join(' · ') };
    }
  }
}

/** Records an answer for the current/specified item. Only the linked worker may call this. */
export async function recordAnswer(ctx: EngineContext, c: CaseRow, field: string | null, raw: string, viaButton: boolean, eventId: string): Promise<string> {
  const list = items(ctx, c.id);
  const item = field ? list.find((i) => i.field === field) : currentItem(ctx, c.id);
  if (!item) return 'There are no open questions right now.';
  if (item.status === 'answered' && !(item.kind === 'ratings' && !ratingsDone(item))) return 'Already recorded.';
  const injection = detectInstructionText(raw);
  if (injection) ctx.store.audit(c.id, 'system', 'instruction_text_in_answer', { field: item.field, excerpt: injection });

  const result = interpret(c, item, raw, viaButton);
  if ('nudge' in result) {
    const nudges = item.nudges + 1;
    ctx.store.db.prepare('UPDATE questionnaire_items SET nudges = ? WHERE case_id = ? AND seq = ?').run(nudges, c.id, item.seq);
    if (item.field === 'delivery' && raw.trim() === 'different') {
      ctx.store.db.prepare(`UPDATE questionnaire_items SET kind = 'number_text', nudges = 0 WHERE case_id = ? AND seq = ?`).run(c.id, item.seq);
    } else if (nudges > MAX_NUDGES) {
      const reason = `${c.worker_name} couldn't answer "${item.prompt}" after ${MAX_NUDGES} tries`;
      ctx.store.updateCase(c.id, { needs_attention: reason });
      await postSlack(ctx, { actionKey: `slack:q-escalate:${c.id}:${item.seq}`, caseId: c.id, kind: 'escalation', channel: c.manager_slack_id, text: `⚠️ ${reason}. Their last reply: "${raw.slice(0, 200)}"`, buttons: [{ text: 'Status', command: `status ${c.id}` }] });
    }
    const reordered = 'reorder' in result && result.reorder ? { ...item, options_json: JSON.stringify(result.reorder) } : item;
    await postSlack(ctx, { actionKey: `slack:q-nudge:${c.id}:${item.seq}:${eventId}`, caseId: c.id, kind: 'question', channel: c.slack_user_id!, text: result.nudge, ...buttonsFor(c, reordered) });
    return result.nudge;
  }

  const done = item.kind !== 'ratings' || ratingsDone({ ...item, answer_value_json: JSON.stringify(result.value) });
  ctx.store.db
    .prepare(`UPDATE questionnaire_items SET status = ?, answer_raw = ?, answer_value_json = ?, excerpt = ?, answered_at = ? WHERE case_id = ? AND seq = ?`)
    .run(done ? 'answered' : 'asked', viaButton ? opts(item).find((o) => o.value === raw)?.label ?? raw : raw, JSON.stringify(result.value), raw.slice(0, 300), now(), c.id, item.seq);
  ctx.store.audit(c.id, 'worker', 'question_answered', { field: item.field, via: viaButton ? 'button' : 'text' });
  if (!done) return `Got it: ${result.summary}`;
  await postSlack(ctx, { actionKey: `slack:q-echo:${c.id}:${item.seq}`, caseId: c.id, kind: 'question', channel: c.slack_user_id!, text: `Got it: ${result.summary}` });
  const next = currentItem(ctx, c.id);
  if (next) await ask(ctx, c, next);
  else await recap(ctx, c);
  return `Got it: ${result.summary}`;
}

function ratingsDone(item: QItem): boolean {
  const v = item.answer_value_json ? (JSON.parse(item.answer_value_json) as Record<string, number>) : {};
  return RATINGS.every((r) => v[r.value]);
}

async function recap(ctx: EngineContext, c: CaseRow): Promise<void> {
  const lines = items(ctx, c.id).map((i) => `• ${labelFor(i.field)}: ${summaryOf(i)}`);
  await postSlack(ctx, {
    actionKey: `slack:q-recap:${c.id}`, caseId: c.id, kind: 'question', channel: c.slack_user_id!,
    text: `Here's what I have:\n${lines.join('\n')}\nReply with a correction if anything's wrong.`,
    buttons: [{ text: 'Looks right', command: `answer ${c.id} confirm yes`, style: 'primary' }],
  });
}

const LABELS: Record<string, string> = {
  delivery: 'Delivery experience', route_type: 'Route type', license_class: "Driver's license", largest_vehicle: 'Largest vehicle',
  equipment: 'Equipment', delivery_app: 'Delivery app', area_familiarity: 'Area', preferred_shift: 'Preferred shift', confidence: 'Confidence',
};
export const labelFor = (f: string) => LABELS[f] ?? f;

export function summaryOf(i: QItem): string {
  const v = i.answer_value_json ? JSON.parse(i.answer_value_json) : null;
  if (v === null) return '—';
  if (i.field === 'delivery') return v.confirmed ? 'as on CV' : v.years === 0 ? 'none' : `${v.kind === 'parcel' ? 'parcel' : 'other'} delivery · ${v.years} yrs`;
  if (Array.isArray(v)) return v.length ? v.join(', ') : 'none';
  if (typeof v === 'object') return RATINGS.map((r) => `${r.label} ${v[r.value] ?? '—'}`).join(' · ');
  return opts(i).find((o) => o.value === v)?.label ?? String(v);
}

async function confirmQuestionnaire(ctx: EngineContext, c: CaseRow): Promise<string> {
  if (c.status === 'questionnaire_complete') return 'Already recorded.';
  if (items(ctx, c.id).some((i) => i.status !== 'answered')) return 'There are still open questions.';
  const { writeFeatureSnapshot } = await import('./features.ts');
  ctx.store.setStatus(c.id, 'questionnaire_complete');
  writeFeatureSnapshot(ctx, c.id, 'questionnaire_complete');
  ctx.store.audit(c.id, 'worker', 'questionnaire_confirmed');
  await postSlack(ctx, { actionKey: `slack:q-done:${c.id}`, caseId: c.id, kind: 'question', channel: c.slack_user_id!, text: "Thanks! I'll put your training plan together with your manager and send it here." });
  await postSlack(ctx, {
    actionKey: `slack:questionnaire-complete:${c.id}`, caseId: c.id, kind: 'questionnaire_complete', channel: c.manager_slack_id,
    text: `✅ Questionnaire complete for *${c.worker_name}* (${c.id}).\n${items(ctx, c.id).map((i) => `• ${labelFor(i.field)}: ${summaryOf(i)}`).join('\n')}`,
    buttons: [{ text: 'Propose training plan', command: `plan ${c.id}`, style: 'primary' }, { text: 'Status', command: `status ${c.id}` }],
  });
  return 'Thanks, all set!';
}

// Open command: workers press buttons. Only the case's own Slack user may answer.
registerCommand(
  'answer',
  'answer <case> <field> <value>',
  async (ctx, args, event) => {
    const c = findCase(ctx, args[0]);
    if (!c.slack_user_id || event.userId !== c.slack_user_id) throw new UserError(`Only ${c.worker_name} can answer these questions.`);
    const [, field, ...rest] = args;
    const value = rest.join(' ');
    const result = field === 'confirm' ? await confirmQuestionnaire(ctx, c) : await recordAnswer(ctx, c, field ?? null, value, true, event.eventId);
    // Echoes, nudges and the next question are already posted; only surface no-op notices.
    return { text: /^(Already recorded|There are)/.test(result) ? result : '' };
  },
  true,
);
