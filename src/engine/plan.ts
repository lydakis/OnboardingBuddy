import type { EngineContext } from './context.ts';
import { isManager, postSlack, sendEmail } from './context.ts';
import { UserError, findCase, registerCommand } from './commands.ts';
import { EXTRACTION_SCHEMA, buildExtractionMessages, detectInstructionText, validateExtraction } from './extract.ts';
import type { Fact } from './extract.ts';
import { buildPlan, hashPlan, loadPolicy, unresolvedBlocking } from './policy.ts';
import type { PlanContent, PlanInputs, TrackId } from './policy.ts';
import { newId, now } from '../db/store.ts';
import { latestFeatureSnapshot, questionnaireFacts } from './features.ts';
import { assessReadiness, readinessSummary } from './readiness.ts';
import { TRAINING_BASE_URL, fitTrainingUrl, trainingPayload } from './training-link.ts';
import { generateLessons } from './lessons.ts';
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
  const snapshot = latestFeatureSnapshot(ctx, c.id);
  if (!snapshot) throw new UserError(`${c.id} needs a confirmed questionnaire before a training plan can be proposed.`);
  const extraction = await extractExperience(ctx, c);
  const sources = sourcesFor(ctx, c);
  const cvFacts: Fact[] = snapshot.data.cv.map((f) => ({ name: f.field, value: f.value, excerpt: f.excerpt, source: 'cv', confidence: f.confidence ?? 'high' }));
  const answered = questionnaireFacts(ctx, c.id, cvFacts, snapshot.data);
  const licenseItem = snapshot.data.asked.find((i) => i.field === 'license_class' && i.value !== null);
  const licenseFromAnswer = answered.find((f) => f.name === 'license_class');
  const readiness = await assessReadiness(ctx, snapshot);
  const ensureCurrent = () => {
    const current = ctx.store.getCase(c.id)!;
    if (['plan_approved', 'plan_sent', 'training', 'training_complete'].includes(current.status)) throw new UserError(`${c.id} is already ${current.status}.`);
    const currentSnapshot = latestFeatureSnapshot(ctx, c.id);
    if (currentSnapshot?.version !== snapshot.version || currentSnapshot.json !== snapshot.json) throw new UserError('The confirmed questionnaire changed during drafting; propose the plan again.');
  };
  ensureCurrent();
  const previous = latestPlan(ctx, c.id);
  const ov: Overrides = overrides ?? (previous ? planContent(previous).overrideInput : { add: [], remove: [], resolved: {} });
  const answers = snapshot.data.asked.filter((i) => i.value !== null)
    .map((i) => ({ field: i.field, value: i.value as unknown, excerpt: i.raw ?? i.excerpt ?? '' }));
  const content = buildPlan(loadPolicy(), {
    facts: [...cvFacts, ...answered],
    extractionErrors: extraction.errors,
    extractionFailed: extraction.failed,
    licenseAnswer: licenseFromAnswer ? String(licenseFromAnswer.value) : null,
    licenseExcerpt: licenseItem?.raw ?? null,
    injectionExcerpt: detectInstructionText(sources.cv),
    preferredShift: snapshot.data.asked.find((i) => i.field === 'preferred_shift')?.value ?? null,
    answers,
    readiness,
    overrides: ov,
  });
  const previousLessons = previous ? planContent(previous).lessons : undefined;
  const lessons = await generateLessons(ctx, c, content, previousLessons ?? {}, answers);
  if (Object.keys(lessons).length) content.lessons = lessons;
  const stored: StoredPlan = { ...content, overrideInput: ov };
  ensureCurrent();
  const version = (latestPlan(ctx, c.id)?.version ?? 0) + 1;
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

const hrs = (h: number) => (h < 1 ? `${h * 60} min` : `${h}h`);

export function planSummary(c: CaseRow, row: PlanRow): { text: string; buttons: SlackButton[] } {
  const p = planContent(row);
  const blocking = unresolvedBlocking(p);
  const tailoring = p.tailoring ?? [];
  const lines = [
    `📋 *Training plan v${row.version}* for *${c.worker_name}* (${c.id}) — ${row.status === 'needs_review' ? '⚠️ needs review' : row.status === 'proposed' ? 'ready for your approval' : row.status}`,
    `*Track:* ${p.track.label}. ${p.track.reason}`,
    ...(readinessSummary(p.readiness) ? [readinessSummary(p.readiness)] : []),
    ...p.track.evidence.slice(0, 3).map((e) => `   ↳ ${e.source}: "${e.excerpt}"`),
  ];
  const tailoredLessons = Object.keys(p.lessons ?? {}).length;
  if (tailoredLessons) lines.push(`*Lessons:* ${tailoredLessons} of ${p.modules.length} written for ${c.worker_name.split(' ')[0]}'s background. Open the preview to read them.`);
  if (tailoring.length) lines.push('*Tailored for them:*', ...tailoring.map((t) => `   • ${t.module ? `${t.module}: ` : ''}${t.reason}${t.evidence[0] && !/^\w+: \d\/5$/.test(t.evidence[0].excerpt) ? ` ↳ "${t.evidence[0].excerpt}"` : ''}`));
  lines.push('*Day by day:*');
  for (const d of p.schedule) {
    const mods = d.modules.map((id) => p.modules.find((m) => m.id === id)!).map((m) => `${m.title} (${m.id}, ${hrs(m.hours)})`);
    if (!mods.length && !d.targetStops) continue;
    lines.push(`   D${d.day}: ${mods.join('; ') || 'On route'}${d.targetStops ? ` · up to ${d.targetStops} stops` : ''}`);
  }
  lines.push(`   _Stop limits follow the ${p.policyId} ramp._`);
  if (p.rideAlongStart) lines.push(`*Ride-along starts* ${p.rideAlongStart.time} (${p.rideAlongStart.shift} shift) · ${p.rideAlongStart.rule.split(':')[0]}`);
  if (p.reviewItems.length) lines.push('*Review:*', ...p.reviewItems.map((r) => `   ${r.resolution ? '✅' : r.blocking ? '⛔' : 'ℹ️'} ${r.text}${r.resolution ? ` — resolved: ${r.resolution}` : ''}`));
  if (p.missingInfo.length) lines.push('*Missing info:*', ...p.missingInfo.map((m) => `   • ${m}`));
  if (p.overrides.length) lines.push('*Manager changes:*', ...p.overrides.map((m) => `   • ${m}`));
  const buttons: SlackButton[] = [{ text: `Preview what ${c.worker_name.split(' ')[0]} gets`, command: `plan-preview ${c.id} v${row.version}` }, { text: 'Evidence', command: `evidence ${c.id}` }];
  if (blocking.length === 0 && (row.status === 'proposed')) buttons.unshift({ text: `Approve and send v${row.version}`, command: `approve ${c.id} v${row.version}`, style: 'primary' });
  else if (blocking.length > 0) lines.push(`To continue: \`/onboard revise ${c.id} resolve=${blocking[0]!.id} "what you checked"\``);
  buttons.push({ text: 'Request revision', command: `revise ${c.id}` });
  return { text: lines.join('\n'), buttons };
}

/** The exact Slack message the worker receives once this version is approved. */
export function workerPlanMessage(ctx: EngineContext, c: CaseRow, row: PlanRow): string {
  const p = planContent(row);
  const name = ctx.store.checklist(c.id).find((i) => i.key === 'preferred_name')?.value ?? c.worker_name.split(' ')[0];
  const why: string[] = [];
  if (p.track.id === 'experienced') why.push('Your parcel route experience puts you on the Experienced Courier track: one ride-along day, then a faster ramp.');
  else if (p.track.id === 'intermediate') why.push('You are starting on the Intermediate Courier track: targeted refreshers and two mentor days before a moderate ramp.');
  else why.push("You're starting on Courier Foundations: three ride-along days with a mentor before your first stops of your own.");
  const scan = p.modules.find((m) => m.id === 'SCAN-120');
  if (scan && scan.hours < 1) why.push("Scanner training is a 30-minute refresher, since you've used a handheld scanner before.");
  for (const t of p.tailoring ?? []) if (!why.includes(t.workerNote)) why.push(t.workerNote);
  const days = p.schedule
    .filter((s) => s.modules.length || s.targetStops)
    .map((s) => `• *Day ${s.day}:* ${s.modules.map((id) => p.modules.find((m) => m.id === id)!.title).join('; ') || 'On route'}${s.targetStops ? ` (up to ${s.targetStops} stops)` : ''}`);
  return [
    `🎉 Hi ${name}, your manager approved your two-week training plan: *${p.track.label}*.`,
    '',
    '*Tailored for you*',
    ...why.map((w) => `• ${w}`),
    '',
    p.rideAlongStart ? `*Your days start at ${p.rideAlongStart.time}* (${p.rideAlongStart.shift} shift).` : '',
    ...days,
    '',
    'Stop numbers are the standard ramp for every new courier, not a judgement on you. Ask me here anytime.',
  ].filter((l, i, a) => l !== '' || (a[i - 1] !== '' && i > 0)).join('\n').replace(/\n\n+/g, '\n\n');
}

/** Second DM: the link to the worker's interactive training page (null when turned off). */
export function trainingLinkMessage(ctx: EngineContext, c: CaseRow, row: PlanRow): string | null {
  if (TRAINING_BASE_URL === 'off') return null;
  const p = planContent(row);
  const name = String(ctx.store.checklist(c.id).find((i) => i.key === 'preferred_name')?.value ?? c.worker_name).trim().split(/\s+/)[0]!;
  const notes = workerPlanMessage(ctx, c, row).split('\n').filter((l) => l.startsWith('• ') && !l.startsWith('• *Day')).map((l) => l.slice(2));
  const url = fitTrainingUrl(trainingPayload(c.id, row.version, name, p, notes));
  const tailored = Object.keys(p.lessons ?? {}).length > 0;
  return `👉 *<${url}|Start your interactive training>*\n${tailored ? 'Short lessons written around your experience, quick checks and your two-week route.' : 'Short lessons, quick checks and your two-week route.'} Go at your own pace; your progress saves on your phone.`;
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
export async function sendApprovedPlan(ctx: EngineContext, c: CaseRow, version: number, resendTo?: string): Promise<'slack' | 'email'> {
  const row = getPlan(ctx, c.id, version);
  if (!row) throw new PlanNotApprovedError(`no plan v${version}`);
  const approval = ctx.store.db
    .prepare(`SELECT * FROM approvals WHERE subject_type = 'plan' AND subject_id = ? AND decision = 'approved' ORDER BY created_at DESC LIMIT 1`)
    .get(row.id) as { subject_hash: string; manager_slack_id: string } | undefined;
  if (!approval || !['approved', 'sent'].includes(row.status)) throw new PlanNotApprovedError(`plan v${version} for ${c.id} is not approved`);
  if (!isManager(ctx, approval.manager_slack_id)) throw new PlanNotApprovedError('approval was not made by an authorized manager');
  if (approval.subject_hash !== row.content_hash || hashPlan(planContent(row)) !== row.content_hash) throw new PlanNotApprovedError('plan changed after approval');

  // Workers get the plan in their Slack DM once they've joined; email is the fallback before that.
  if (c.slack_user_id && !resendTo) {
    const r = await postSlack(ctx, { actionKey: `slack:plan-dm:${c.id}:v${version}`, caseId: c.id, kind: 'plan', channel: c.slack_user_id, text: workerPlanMessage(ctx, c, row) });
    const link = trainingLinkMessage(ctx, c, row);
    if (link) await postSlack(ctx, { actionKey: `slack:plan-link:${c.id}:v${version}`, caseId: c.id, kind: 'plan', channel: c.slack_user_id, text: link });
    if (r.state === 'sent') markSent(ctx, c, row);
    return 'slack';
  }
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
    c.slack_user_id ? 'Your training tasks will be posted in your Slack DMs.' : 'Next, we will invite you to our team Slack, where your training tasks will be posted.',
    '',
    '— Onboarding assistant',
  ].join('\n');
  const r = await sendEmail(ctx, { actionKey: `email:plan:${c.id}:v${version}${resendTo ? `:${resendTo}` : ''}`, caseId: c.id, kind: 'plan', to: resendTo ?? c.worker_email, subject: 'Your approved two-week onboarding plan', text });
  if (resendTo) return 'email';
  if (r.state === 'sent') markSent(ctx, c, row);
  return 'email';
}

function markSent(ctx: EngineContext, c: CaseRow, row: PlanRow): void {
  ctx.store.db.prepare(`UPDATE plans SET status = 'sent' WHERE id = ?`).run(row.id);
  ctx.store.setStatus(c.id, 'plan_sent');
  ctx.store.audit(c.id, 'agent', 'plan_sent', { version: row.version });
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
      if (v !== 'experienced' && v !== 'intermediate' && v !== 'foundations') throw new UserError('track must be experienced, intermediate or foundations');
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
  if (existing && existing.status !== 'superseded') return planSummary(ctx.store.getCase(c.id)!, existing);
  await proposePlan(ctx, c, event.userId);
  // proposePlan already posted the summary to the case's manager; don't post it twice there.
  return event.userId === c.manager_slack_id ? { text: '' } : planSummary(ctx.store.getCase(c.id)!, latestPlan(ctx, c.id)!);
});

registerCommand('evidence', 'evidence <case> [version]', async (ctx, args) => {
  const c = findCase(ctx, args[0]);
  const row = args[1] ? getPlan(ctx, c.id, Number(args[1].replace(/^v/, ''))) : latestPlan(ctx, c.id);
  if (!row) throw new UserError(`${c.id} has no plan yet.`);
  const p = planContent(row);
  const lines = [`🔎 *Evidence for ${c.id} plan v${row.version}* (model: ${ctx.adapters.llm.model})`, `*Track:* ${p.track.reason}`, ...p.track.evidence.map((e) => `   ↳ ${e.source}: "${e.excerpt}"`)];
  if (readinessSummary(p.readiness)) lines.push(readinessSummary(p.readiness));
  for (const m of p.modules) lines.push(`• *${m.id}* ${m.title}: ${m.reason}`, ...m.evidence.map((e) => `   ↳ ${e.source}: "${e.excerpt}"`));
  lines.push('*Extracted facts:*', ...p.facts.map((f) => `   ${f.name}=${String(f.value)} (${f.source}, ${f.confidence}): "${f.excerpt}"`));
  return { text: lines.join('\n') };
});

registerCommand('approve', 'approve <case> v<version>', async (ctx, args, event) => {
  const c = findCase(ctx, args[0]);
  const version = Number((args[1] ?? '').replace(/^v/i, ''));
  if (!Number.isInteger(version) || version < 1) throw new UserError('Usage: approve <case> v<version>');
  await approvePlan(ctx, c, version, event.userId);
  const via = await sendApprovedPlan(ctx, ctx.store.getCase(c.id)!, version);
  if (via === 'slack') {
    return { text: `✅ Approved plan v${version} for ${c.worker_name} and sent it to <@${c.slack_user_id}> in Slack.`, buttons: [{ text: 'Write day-1 quiz', command: `quiz ${c.id}`, style: 'primary' }, { text: 'Status', command: `status ${c.id}` }] };
  }
  return { text: `✅ Approved plan v${version} for ${c.worker_name}; emailed it to ${c.worker_email}.`, buttons: [{ text: 'Request Slack invite', command: `invite ${c.id}`, style: 'primary' }] };
});

registerCommand('plan-preview', 'plan-preview <case> [version]', async (ctx, args) => {
  const c = findCase(ctx, args[0]);
  const row = args[1] ? getPlan(ctx, c.id, Number(args[1].replace(/^v/i, ''))) : latestPlan(ctx, c.id);
  if (!row) throw new UserError(`${c.id} has no plan yet.`);
  const buttons: SlackButton[] = row.status === 'proposed' && row.version === latestPlan(ctx, c.id)!.version
    ? [{ text: `Approve and send v${row.version}`, command: `approve ${c.id} v${row.version}`, style: 'primary' }, { text: 'Request revision', command: `revise ${c.id}` }]
    : [];
  const link = trainingLinkMessage(ctx, c, row);
  return { text: `👀 Here's exactly what ${c.worker_name} will get in Slack when you approve v${row.version}:\n\n${workerPlanMessage(ctx, c, row)}${link ? `\n\n${link}` : ''}`, buttons };
});

registerCommand('revise', 'revise <case> [track=..] [add=MOD] [remove=MOD] [resolve=<review id>] "note"', async (ctx, args, event) => {
  const c = findCase(ctx, args[0]);
  const latest = latestPlan(ctx, c.id);
  if (!latest) throw new UserError(`${c.id} has no plan to revise. Run /onboard plan ${c.id}.`);
  if (args.length === 1) return { text: `Reply with e.g. \`/onboard revise ${c.id} add=DRV-220 "needs defensive driving"\`. Options: track=experienced|intermediate|foundations, add=/remove=<module>, resolve=<review id> "what you checked".` };
  if (latest.status === 'approved' || latest.status === 'sent') throw new UserError(`v${latest.version} is already ${latest.status}.`);
  const { overrides, note } = parseOverrides(args.slice(1), planContent(latest).overrideInput);
  ctx.store.db
    .prepare('INSERT INTO approvals (id, case_id, subject_type, subject_id, subject_hash, decision, manager_slack_id, note, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(newId('appr'), c.id, 'plan', latest.id, latest.content_hash, 'revision_requested', event.userId, note || null, now());
  const row = await proposePlan(ctx, c, event.userId, overrides);
  return planSummary(ctx.store.getCase(c.id)!, row);
});

registerCommand('resend-plan', 'resend-plan <case>', async (ctx, args) => {
  const c = findCase(ctx, args[0]);
  const row = ctx.store.db.prepare(`SELECT version FROM plans WHERE case_id = ? AND status IN ('approved','sent') ORDER BY version DESC LIMIT 1`).get(c.id) as { version: number } | undefined;
  if (!row) throw new UserError(`${c.id} has no approved plan to resend.`);
  await sendApprovedPlan(ctx, c, row.version, c.worker_email);
  return { text: `Emailed approved plan v${row.version} to ${c.worker_email}.` };
});
