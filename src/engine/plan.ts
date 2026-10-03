import type { EngineContext } from './context.ts';
import { isManager, postSlack, sendEmail } from './context.ts';
import { UserError, findCase, registerCommand } from './commands.ts';
import { EXTRACTION_SCHEMA, buildExtractionMessages, detectInstructionText, validateExtraction } from './extract.ts';
import type { Fact } from './extract.ts';
import { buildPlan, hashPlan, loadPolicy, unresolvedBlocking } from './policy.ts';
import type { PlanContent, PlanInputs, TrackId } from './policy.ts';
import { newId, now } from '../db/store.ts';
import { answeredValue, questionnaireFacts } from './features.ts';
import { items } from './slack-questionnaire.ts';
import type { CaseRow, SlackButton } from '../types.ts';

type Overrides = PlanInputs['overrides'];
export interface PlanRow {
  id: string;
  case_id: string;
  version: number;
  status: 'proposed' | 'needs_review' | 'approved' | 'superseded' | 'sent';
  content_json: string;
  content_hash: string;
  created_by: string;
  created_at: string;
}
interface StoredPlan extends PlanContent {
  overrideInput: Overrides;
}

export class PlanNotApprovedError extends Error {}

export function latestPlan(ctx: EngineContext, caseId: string): PlanRow | undefined {
  return ctx.store.db.prepare('SELECT * FROM plans WHERE case_id = ? ORDER BY version DESC LIMIT 1').get(caseId) as PlanRow | undefined;
}

export function getPlan(ctx: EngineContext, caseId: string, version: number): PlanRow | undefined {
  return ctx.store.db.prepare('SELECT * FROM plans WHERE case_id = ? AND version = ?').get(caseId, version) as PlanRow | undefined;
}

export function planContent(row: PlanRow): StoredPlan {
  return JSON.parse(row.content_json) as StoredPlan;
}

function sourcesFor(ctx: EngineContext, c: CaseRow): { cv: string; questionnaire: string } {
  // The model reads the CV only; questionnaire answers become facts deterministically (features.ts).
  const cvDoc = ctx.store.documents(c.id, 'cv').at(-1);
  return { cv: (cvDoc?.content_text as string | null) ?? '', questionnaire: '' };
}

/** Runs the local model once per case (re-run with force). Output is validated before it is stored. */
export async function extractExperience(ctx: EngineContext, c: CaseRow, force = false): Promise<{ facts: Fact[]; errors: string[]; failed: boolean }> {
  const existing = ctx.store.db
    .prepare('SELECT * FROM extractions WHERE case_id = ? ORDER BY created_at DESC LIMIT 1')
    .get(c.id) as { status: string; output_json: string | null; errors: string | null } | undefined;
  if (existing && !force) {
    return { facts: existing.output_json ? (JSON.parse(existing.output_json) as Fact[]) : [], errors: existing.errors ? (JSON.parse(existing.errors) as string[]) : [], failed: existing.status === 'rejected' };
  }
  const sources = sourcesFor(ctx, c);
  let raw = '';
  let errors: string[] = [];
  let facts: Fact[] = [];
  try {
    raw = await ctx.adapters.llm.complete(buildExtractionMessages(sources.cv, sources.questionnaire), { jsonSchema: EXTRACTION_SCHEMA, sessionKey: `onboarding-${c.id}-extract` });
    ({ facts, errors } = validateExtraction(raw, sources));
    facts = facts.filter((f) => f.source === 'cv');
  } catch (err) {
    errors = [`local model call failed: ${err instanceof Error ? err.message : String(err)}`];
  }
  const failed = facts.length === 0 && errors.length > 0;
  ctx.store.db
    .prepare('INSERT INTO extractions (id, case_id, kind, model, status, output_json, errors, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(newId('ext'), c.id, 'experience', `${ctx.adapters.llm.mode}:${ctx.adapters.llm.model}`, failed ? 'rejected' : 'accepted', JSON.stringify(facts), JSON.stringify(errors), now());
  ctx.store.audit(c.id, 'agent', 'experience_extracted', { model: ctx.adapters.llm.model, facts: facts.length, dropped: errors.length });
  return { facts, errors, failed };
}

export async function proposePlan(ctx: EngineContext, c: CaseRow, actor: string, overrides?: Overrides): Promise<PlanRow> {
  if (['intake', 'questionnaire', 'plan_approved', 'plan_sent', 'training', 'training_complete'].includes(c.status)) {
    throw new UserError(c.status === 'questionnaire' ? `${c.worker_name} is still answering the Slack questions.` : `${c.id} is in "${c.status}"; a plan can be proposed after intake and before approval.`);
  }
  const extraction = await extractExperience(ctx, c);
  const sources = sourcesFor(ctx, c);
  const cvFacts = extraction.facts.filter((f) => f.source === 'cv');
  const answered = questionnaireFacts(ctx, c.id, cvFacts);
  const licenseItem = items(ctx, c.id).find((i) => i.field === 'license_class' && i.status === 'answered');
  const licenseFromAnswer = answered.find((f) => f.name === 'license_class');
  const previous = latestPlan(ctx, c.id);
  const ov: Overrides = overrides ?? (previous ? planContent(previous).overrideInput : { add: [], remove: [], resolved: {} });
  const content = buildPlan(loadPolicy(), {
    facts: [...cvFacts, ...answered],
    extractionErrors: extraction.errors,
    extractionFailed: extraction.failed,
    licenseAnswer: licenseFromAnswer ? String(licenseFromAnswer.value) : null,
    licenseExcerpt: licenseItem?.answer_raw ?? null,
    injectionExcerpt: detectInstructionText(sources.cv),
    preferredShift: (answeredValue(ctx, c.id, 'preferred_shift') as string | undefined) ?? null,
    overrides: ov,
  });
  const stored: StoredPlan = { ...content, overrideInput: ov };
  const version = (previous?.version ?? 0) + 1;
  const status = unresolvedBlocking(content).length > 0 ? 'needs_review' : 'proposed';
  const id = newId('plan');
  ctx.store.transaction(() => {
    ctx.store.db.prepare(`UPDATE plans SET status = 'superseded' WHERE case_id = ? AND status IN ('proposed','needs_review')`).run(c.id);
    ctx.store.db
      .prepare('INSERT INTO plans (id, case_id, version, status, content_json, content_hash, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, c.id, version, status, JSON.stringify(stored), hashPlan(stored), actor, now());
    ctx.store.setStatus(c.id, 'plan_proposed');
    ctx.store.audit(c.id, actor, 'plan_proposed', { version, status, track: content.track.id });
  });
  const row = getPlan(ctx, c.id, version)!;
  await postSlack(ctx, { actionKey: `slack:plan-proposed:${c.id}:v${version}`, caseId: c.id, kind: 'plan_proposed', channel: c.manager_slack_id, ...planSummary(c, row) });
  return row;
}

export function planSummary(c: CaseRow, row: PlanRow): { text: string; buttons: SlackButton[] } {
  const p = planContent(row);
  const blocking = unresolvedBlocking(p);
  const lines = [
    `📋 *Training plan v${row.version}* for *${c.worker_name}* (${c.id}) — ${row.status === 'needs_review' ? '⚠️ needs review' : row.status}`,
    `*Track:* ${p.track.label}. ${p.track.reason}`,
    ...p.track.evidence.slice(0, 3).map((e) => `   ↳ ${e.source}: "${e.excerpt}"`),
    `*Modules:* ${p.modules.map((m) => `${m.id} (${m.hours}h, day ${m.days.join('-')})`).join(', ')}`,
    `*Ramp (policy ${p.policyId}):* ${p.schedule.map((s) => `D${s.day} ${s.targetStops}`).join(' · ')} stops/day`,
    ...(p.rideAlongStart ? [`*Ride-along starts* ${p.rideAlongStart.time} (${p.rideAlongStart.shift} shift) · ${p.rideAlongStart.rule.split(':')[0]}`] : []),
  ];
  if (p.reviewItems.length) lines.push('*Review:*', ...p.reviewItems.map((r) => `   ${r.resolution ? '✅' : r.blocking ? '⛔' : 'ℹ️'} ${r.text}${r.resolution ? ` — resolved: ${r.resolution}` : ''}`));
  if (p.missingInfo.length) lines.push('*Missing info:*', ...p.missingInfo.map((m) => `   • ${m}`));
  if (p.overrides.length) lines.push('*Manager changes:*', ...p.overrides.map((m) => `   • ${m}`));
  const buttons: SlackButton[] = [{ text: 'Evidence', command: `evidence ${c.id}` }];
  if (blocking.length === 0 && (row.status === 'proposed')) buttons.unshift({ text: `Approve v${row.version}`, command: `approve ${c.id} v${row.version}`, style: 'primary' });
  else if (blocking.length > 0) lines.push(`To continue: \`/onboard revise ${c.id} resolve=${blocking[0]!.id} "what you checked"\``);
  buttons.push({ text: 'Request revision', command: `revise ${c.id}` });
  return { text: lines.join('\n'), buttons };
}

export async function approvePlan(ctx: EngineContext, c: CaseRow, version: number, managerId: string): Promise<PlanRow> {
  if (!isManager(ctx, managerId)) throw new UserError('Only an authorized manager can approve plans.');
  const row = getPlan(ctx, c.id, version);
  if (!row) throw new UserError(`${c.id} has no plan v${version}.`);
  const latest = latestPlan(ctx, c.id)!;
  if (latest.version !== version) throw new UserError(`v${version} is not the latest plan (v${latest.version}).`);
  if (row.status === 'approved' || row.status === 'sent') return row;
  if (row.status !== 'proposed') {
    const blocking = unresolvedBlocking(planContent(row));
    throw new UserError(`v${version} cannot be approved: ${blocking.map((b) => b.id).join(', ') || row.status}. Resolve with /onboard revise.`);
  }
  ctx.store.transaction(() => {
    ctx.store.db
      .prepare('INSERT INTO approvals (id, case_id, subject_type, subject_id, subject_hash, decision, manager_slack_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(newId('appr'), c.id, 'plan', row.id, row.content_hash, 'approved', managerId, now());
    ctx.store.db.prepare(`UPDATE plans SET status = 'approved' WHERE id = ?`).run(row.id);
    ctx.store.setStatus(c.id, 'plan_approved');
    ctx.store.audit(c.id, managerId, 'plan_approved', { version, hash: row.content_hash });
  });
  return getPlan(ctx, c.id, version)!;
}

/** The only way a plan reaches the worker. Refuses anything without a matching manager approval. */
export async function sendApprovedPlan(ctx: EngineContext, c: CaseRow, version: number): Promise<void> {
  const row = getPlan(ctx, c.id, version);
  if (!row) throw new PlanNotApprovedError(`no plan v${version}`);
  const approval = ctx.store.db
    .prepare(`SELECT * FROM approvals WHERE subject_type = 'plan' AND subject_id = ? AND decision = 'approved' ORDER BY created_at DESC LIMIT 1`)
    .get(row.id) as { subject_hash: string; manager_slack_id: string } | undefined;
  if (!approval || !['approved', 'sent'].includes(row.status)) throw new PlanNotApprovedError(`plan v${version} for ${c.id} is not approved`);
  if (!isManager(ctx, approval.manager_slack_id)) throw new PlanNotApprovedError('approval was not made by an authorized manager');
  if (approval.subject_hash !== row.content_hash || hashPlan(planContent(row)) !== row.content_hash) throw new PlanNotApprovedError('plan changed after approval');

  const p = planContent(row);
  const name = ctx.store.checklist(c.id).find((i) => i.key === 'preferred_name')?.value ?? c.worker_name;
  const text = [
    `Hi ${name},`,
    '',
    `Your manager approved your two-week onboarding plan (${p.track.label}).`,
    '',
    ...p.schedule.map((s) => {
      const mods = s.modules.map((id) => p.modules.find((m) => m.id === id)!.title).join('; ');
      return `Day ${s.day}: ${mods || 'On route'}${s.targetStops ? ` · up to ${s.targetStops} stops (policy ramp ${s.targetPct}%)` : ''}`;
    }),
    '',
    'Daily stop numbers are the policy ramp limits for new couriers, not expectations based on your CV.',
    'Next, we will invite you to our team Slack, where your training tasks will be posted.',
    '',
    '— Onboarding assistant',
  ].join('\n');
  const r = await sendEmail(ctx, { actionKey: `email:plan:${c.id}:v${version}`, caseId: c.id, kind: 'plan', to: c.worker_email, subject: 'Your approved two-week onboarding plan', text });
  if (c.slack_user_id) {
    const days = p.schedule
      .filter((s) => s.modules.length || s.targetStops)
      .map((s) => `• Day ${s.day}: ${s.modules.map((id) => p.modules.find((m) => m.id === id)!.title).join('; ') || 'On route'}${s.targetStops ? ` (up to ${s.targetStops} stops)` : ''}`);
    await postSlack(ctx, {
      actionKey: `slack:plan-dm:${c.id}:v${version}`, caseId: c.id, kind: 'plan', channel: c.slack_user_id,
      text: [`🎉 Your manager approved your two-week plan: *${p.track.label}*.`, p.rideAlongStart ? `Ride-along and route days start at *${p.rideAlongStart.time}* (${p.rideAlongStart.shift} shift).` : '', ...days, 'Stop numbers are the standard ramp for new couriers, not a judgement on you. Ask me here anytime.'].filter(Boolean).join('\n'),
    });
  }
  if (r.state === 'sent') {
    ctx.store.db.prepare(`UPDATE plans SET status = 'sent' WHERE id = ?`).run(row.id);
    ctx.store.setStatus(c.id, 'plan_sent');
  }
}

function parseOverrides(args: string[], base: Overrides): { overrides: Overrides; note: string } {
  const ov: Overrides = { track: base.track, add: [...base.add], remove: [...base.remove], resolved: { ...base.resolved } };
  const noteParts: string[] = [];
  const resolveIds: string[] = [];
  for (const a of args) {
    const m = a.match(/^(track|add|remove|resolve)=(.+)$/i);
    if (!m) { noteParts.push(a); continue; }
    const [, k, v] = m;
    if (k === 'track') {
      if (v !== 'experienced' && v !== 'foundations') throw new UserError('track must be experienced or foundations');
      ov.track = v as TrackId;
    } else if (k === 'add') { ov.add.push(v!.toUpperCase()); ov.remove = ov.remove.filter((x) => x !== v!.toUpperCase()); }
    else if (k === 'remove') { ov.remove.push(v!.toUpperCase()); ov.add = ov.add.filter((x) => x !== v!.toUpperCase()); }
    else resolveIds.push(v!);
  }
  const note = noteParts.join(' ').trim();
  if (resolveIds.length && !note) throw new UserError('Resolving a review item needs a note saying what you checked.');
  for (const id of resolveIds) ov.resolved[id] = note;
  return { overrides: ov, note };
}

registerCommand('plan', 'plan <case>', async (ctx, args, event) => {
  const c = findCase(ctx, args[0]);
  const existing = latestPlan(ctx, c.id);
  const row = existing && existing.status !== 'superseded' ? existing : await proposePlan(ctx, c, event.userId);
  return planSummary(ctx.store.getCase(c.id)!, row);
});

registerCommand('evidence', 'evidence <case> [version]', async (ctx, args) => {
  const c = findCase(ctx, args[0]);
  const row = args[1] ? getPlan(ctx, c.id, Number(args[1].replace(/^v/, ''))) : latestPlan(ctx, c.id);
  if (!row) throw new UserError(`${c.id} has no plan yet.`);
  const p = planContent(row);
  const lines = [`🔎 *Evidence for ${c.id} plan v${row.version}* (model: ${ctx.adapters.llm.model})`, `*Track:* ${p.track.reason}`, ...p.track.evidence.map((e) => `   ↳ ${e.source}: "${e.excerpt}"`)];
  for (const m of p.modules) lines.push(`• *${m.id}* ${m.title}: ${m.reason}`, ...m.evidence.map((e) => `   ↳ ${e.source}: "${e.excerpt}"`));
  lines.push('*Extracted facts:*', ...p.facts.map((f) => `   ${f.name}=${String(f.value)} (${f.source}, ${f.confidence}): "${f.excerpt}"`));
  return { text: lines.join('\n') };
});

registerCommand('approve', 'approve <case> v<version>', async (ctx, args, event) => {
  const c = findCase(ctx, args[0]);
  const version = Number((args[1] ?? '').replace(/^v/i, ''));
  if (!Number.isInteger(version) || version < 1) throw new UserError('Usage: approve <case> v<version>');
  await approvePlan(ctx, c, version, event.userId);
  await sendApprovedPlan(ctx, ctx.store.getCase(c.id)!, version);
  return { text: `✅ Approved plan v${version} for ${c.worker_name}; emailed it to ${c.worker_email}.`, buttons: [{ text: 'Request Slack invite', command: `invite ${c.id}`, style: 'primary' }] };
});

registerCommand('revise', 'revise <case> [track=..] [add=MOD] [remove=MOD] [resolve=<review id>] "note"', async (ctx, args, event) => {
  const c = findCase(ctx, args[0]);
  const latest = latestPlan(ctx, c.id);
  if (!latest) throw new UserError(`${c.id} has no plan to revise. Run /onboard plan ${c.id}.`);
  if (args.length === 1) return { text: `Reply with e.g. \`/onboard revise ${c.id} add=DRV-220 "needs defensive driving"\`. Options: track=experienced|foundations, add=/remove=<module>, resolve=<review id> "what you checked".` };
  if (latest.status === 'approved' || latest.status === 'sent') throw new UserError(`v${latest.version} is already ${latest.status}.`);
  const { overrides, note } = parseOverrides(args.slice(1), planContent(latest).overrideInput);
  ctx.store.db
    .prepare('INSERT INTO approvals (id, case_id, subject_type, subject_id, subject_hash, decision, manager_slack_id, note, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(newId('appr'), c.id, 'plan', latest.id, latest.content_hash, 'revision_requested', event.userId, note || null, now());
  const row = await proposePlan(ctx, c, event.userId, overrides);
  return planSummary(ctx.store.getCase(c.id)!, row);
});
