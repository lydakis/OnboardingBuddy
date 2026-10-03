// Deterministic plan builder. The model only supplies validated facts; the track,
// modules and numeric targets all come from the written policy.
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import type { Fact } from './extract.ts';
import type { ReadinessAssessment } from './readiness.ts';

export type TrackId = 'experienced' | 'intermediate' | 'foundations';

export interface Policy {
  policyId: string;
  company: string;
  disclaimer: string;
  standardRoute: { stopsPerDay: number };
  review: { experienceToleranceYears: number; rule: string };
  shifts?: Record<string, string>;
  scheduleRule?: string;
  tailoring?: TailoringRule[];
  tailoringRule?: string;
  classifierReview?: { minProbability: number; minMargin: number };
  tracks: { id: TrackId; label: string; rule: string; minParcelYears: number; requiresLicense: boolean; rampPctByDay: number[] }[];
  modules: {
    id: string;
    title: string;
    hours: number;
    shortHours?: number;
    shortenedByEquipment?: string;
    appliesTo: 'all' | 'licensed' | 'tailored' | TrackId | TrackId[];
    hoursByTrack?: Partial<Record<TrackId, number>>;
    day: Partial<Record<TrackId, number>>;
    daysByTrack?: Partial<Record<TrackId, number>>;
    evidence: string;
    rule: string;
  }[];
}

/** Adds training from the worker's own answers. Rules only add or lengthen; they never remove. */
export interface TailoringRule {
  id: string;
  when: { field: string; in: string[] } | { rating: string; atMost: number };
  add?: string;
  fullLength?: string;
  reason: string;
  workerNote: string;
}

export interface Answer {
  field: string;
  value: unknown;
  excerpt: string;
}

/** A lesson the local model tailored to one worker: intro, situation, and [text, best 0/1, feedback] choices. */
export interface Lesson {
  i: string;
  s: string;
  c: [string, 0 | 1, string][];
}

export interface Tailoring {
  ruleId: string;
  module: string | null;
  reason: string;
  workerNote: string;
  evidence: Evidence[];
}

export function loadPolicy(path = process.env.OB_POLICY_PATH ?? new URL('../../fixtures/policy/training-policy.json', import.meta.url).pathname): Policy {
  return JSON.parse(readFileSync(path, 'utf8')) as Policy;
}

export interface Evidence {
  source: 'cv' | 'questionnaire' | 'checklist' | 'manager';
  excerpt: string;
}

export interface ReviewItem {
  id: string;
  blocking: boolean;
  text: string;
  resolution?: string;
}

export interface PlanModule {
  id: string;
  title: string;
  hours: number;
  days: number[];
  evidenceRequired: string;
  reason: string;
  evidence: Evidence[];
}

export interface PlanContent {
  policyId: string;
  track: { id: TrackId; label: string; reason: string; evidence: Evidence[] };
  modules: PlanModule[];
  schedule: { day: number; modules: string[]; targetPct: number; targetStops: number }[];
  facts: Fact[];
  reviewItems: ReviewItem[];
  missingInfo: string[];
  overrides: string[];
  disclaimer: string;
  /** Why this plan differs from the standard track, in manager and worker wording. */
  tailoring?: Tailoring[];
  /** Per-module lessons tailored to this worker (validated model output; approved with the plan). */
  lessons?: Record<string, Lesson>;
  rideAlongStart?: { shift: string; time: string; rule: string };
  readiness?: ReadinessAssessment;
}

export interface PlanInputs {
  facts: Fact[];
  extractionErrors: string[];
  extractionFailed: boolean;
  licenseAnswer: string | null; // from the questionnaire checklist
  licenseExcerpt: string | null;
  injectionExcerpt: string | null;
  preferredShift?: string | null;
  answers?: Answer[]; // confirmed questionnaire snapshot, worker's words as excerpt
  readiness?: ReadinessAssessment;
  overrides: { track?: TrackId; add: string[]; remove: string[]; resolved: Record<string, string> };
}

const sum = (xs: number[]) => Math.round(xs.reduce((a, b) => a + b, 0) * 10) / 10;

export function buildPlan(policy: Policy, input: PlanInputs): PlanContent {
  const f = (name: Fact['name'], source?: Fact['source']) => input.facts.filter((x) => x.name === name && (!source || x.source === source));
  const ev = (facts: Fact[]): Evidence[] => facts.map((x) => ({ source: x.source, excerpt: x.excerpt }));

  const parcelCv = f('parcel_delivery_years', 'cv');
  const parcelCvYears = sum(parcelCv.map((x) => Number(x.value)));
  const claimed = [...f('parcel_delivery_years', 'questionnaire'), ...f('other_delivery_years', 'questionnaire')];
  // Total claimed delivery work (parcel + other), compared with the CV's total below.
  const claimedYears = Math.round(claimed.reduce((a, x) => a + Number(x.value), 0) * 10) / 10;
  const cvDeliveryYears = sum([...parcelCv, ...f('other_delivery_years', 'cv')].map((x) => Number(x.value)));
  const licenseFacts = f('license_class');
  const hasLicense = input.licenseAnswer !== null ? input.licenseAnswer !== 'none' : licenseFacts.some((x) => String(x.value).toLowerCase() !== 'none');
  const equipment = new Set(f('equipment').map((x) => String(x.value)));

  const reviewItems: ReviewItem[] = [];
  if (input.extractionFailed) {
    reviewItems.push({ id: 'extraction-failed', blocking: true, text: `Experience extraction failed (${input.extractionErrors.slice(0, 2).join('; ')}). Review the CV manually.` });
  } else if (input.extractionErrors.length > 0) {
    reviewItems.push({ id: 'extraction-dropped', blocking: false, text: `${input.extractionErrors.length} extracted fact(s) were dropped because they failed validation.` });
  }
  // Only an explicit questionnaire claim can conflict; a claim the extractor did not find is not evidence.
  if (claimed.length > 0 && Math.abs(claimedYears - cvDeliveryYears) > policy.review.experienceToleranceYears) {
    reviewItems.push({
      id: 'experience-conflict',
      blocking: true,
      text: `Questionnaire claims ~${claimedYears} year(s) of delivery work but the CV shows ${cvDeliveryYears}. ${policy.review.rule}`,
    });
  }
  const lowConfidence = input.facts.filter((x) => x.confidence === 'low' && x.name.endsWith('_years'));
  if (lowConfidence.length > 0) {
    reviewItems.push({ id: 'uncertain-duration', blocking: false, text: `Uncertain duration: "${lowConfidence[0]!.excerpt}".` });
  }
  if (input.injectionExcerpt) {
    reviewItems.push({ id: 'instruction-text', blocking: false, text: `The CV contains instruction-like text, which was ignored: "${input.injectionExcerpt}"` });
  }
  const missingInfo: string[] = [];
  if (!hasLicense) missingInfo.push("No driver's license on file: vehicle modules are excluded until one is provided.");
  if (licenseFacts.length === 0 && hasLicense) missingInfo.push('License class was not found in the CV; using the questionnaire answer.');
  if (parcelCv.length === 0) missingInfo.push('No parcel or route delivery roles found in the CV.');

  const experiencedTrack = policy.tracks.find((t) => t.id === 'experienced')!;
  const qualifies = parcelCvYears >= experiencedTrack.minParcelYears && (!experiencedTrack.requiresLicense || hasLicense);
  let trackId: TrackId = qualifies ? 'experienced' : 'foundations';
  const readiness = input.readiness;
  if (readiness?.status === 'unavailable') {
    reviewItems.push({ id: 'classifier-unavailable', blocking: false, text: readiness.error ?? 'Readiness prediction unavailable; using the written policy.' });
  } else if (readiness?.status === 'ok') {
    if (readiness.mode === 'demo') trackId = readiness.label === 'expert' ? 'experienced' : readiness.label === 'okay' ? 'intermediate' : 'foundations';
    const probabilities = Object.values(readiness.probabilities!).sort((a, b) => b - a);
    const thresholds = policy.classifierReview ?? { minProbability: 0.6, minMargin: 0.15 };
    if (probabilities[0]! < thresholds.minProbability || probabilities[0]! - probabilities[1]! < thresholds.minMargin) {
      reviewItems.push({ id: 'classifier-uncertain', blocking: readiness.mode === 'demo', text: 'Readiness recommendation is ambiguous. Review the answers and confirm or revise the training tier. Probabilities are uncalibrated.' });
    }
    if (readiness.missing_fields?.length) reviewItems.push({ id: 'classifier-missing-inputs', blocking: readiness.mode === 'demo', text: `Readiness inputs are missing: ${readiness.missing_fields.join(', ')}. Confirm the appropriate tier with a note.` });
  }
  const overrides: string[] = [];
  if (input.overrides.track && input.overrides.track !== trackId) {
    overrides.push(`Manager set track to ${input.overrides.track} (policy suggested ${trackId}).`);
    trackId = input.overrides.track;
  }
  if (policy.tracks.find((t) => t.id === trackId)?.requiresLicense && !hasLicense) {
    overrides.push(`The ${trackId} tier requires a driver's license; using Foundations until one is recorded.`);
    trackId = 'foundations';
  }
  const track = policy.tracks.find((t) => t.id === trackId)!;
  const trackEvidence: Evidence[] = [...ev(parcelCv), ...ev(licenseFacts)];
  if (input.licenseExcerpt) trackEvidence.push({ source: 'questionnaire', excerpt: input.licenseExcerpt });
  const trackReason = `${track.rule} ${readiness?.status === 'ok' && readiness.mode === 'demo' ? `Classifier recommended ${readiness.label}; ` : ''}CV parcel/route experience: ${parcelCvYears} year(s); license: ${hasLicense ? 'yes' : 'no'}.`;

  const tailoring = matchTailoring(policy, input.answers ?? []);
  const tailoredIn = new Map<string, Tailoring[]>();
  for (const t of tailoring) if (t.module) tailoredIn.set(t.module, [...(tailoredIn.get(t.module) ?? []), t]);
  const fullLength = new Set((policy.tailoring ?? []).filter((r) => r.fullLength && tailoring.some((t) => t.ruleId === r.id)).map((r) => r.fullLength!));
  const appliesToTrack = (m: Policy['modules'][number]) =>
    m.appliesTo === 'all' || m.appliesTo === trackId || (Array.isArray(m.appliesTo) && m.appliesTo.includes(trackId)) || (m.appliesTo === 'licensed' && hasLicense);

  const modules: PlanModule[] = [];
  for (const m of policy.modules) {
    const baseApplies = appliesToTrack(m);
    const tailoredBy = baseApplies ? [] : (tailoredIn.get(m.id) ?? []);
    const applies = baseApplies || tailoredBy.length > 0;
    const forcedIn = input.overrides.add.includes(m.id);
    if (m.appliesTo === 'licensed' && !hasLicense) continue;
    const mandatory = m.appliesTo === 'all' || (m.appliesTo === 'licensed' && hasLicense);
    if ((!applies && !forcedIn) || (input.overrides.remove.includes(m.id) && !mandatory)) continue;
    if (input.overrides.remove.includes(m.id) && mandatory) overrides.push(`Ignored removal of mandatory module ${m.id}.`);
    const start = m.day[trackId] ?? 1;
    const count = m.daysByTrack?.[trackId] ?? 1;
    const days = Array.from({ length: count }, (_, i) => start + i);
    const shortened = m.shortenedByEquipment !== undefined && equipment.has(m.shortenedByEquipment) && !fullLength.has(m.id);
    const evidence: Evidence[] = tailoredBy.flatMap((t) => t.evidence);
    if (shortened) evidence.push(...ev(f('equipment').filter((x) => x.value === m.shortenedByEquipment)));
    if (m.appliesTo === 'licensed') evidence.push(...ev(licenseFacts));
    modules.push({
      id: m.id,
      title: m.title,
      hours: shortened && m.shortHours !== undefined ? m.shortHours : (m.hoursByTrack?.[trackId] ?? m.hours),
      days,
      evidenceRequired: m.evidence,
      reason: forcedIn && !applies ? 'Added by manager.' : `${m.rule}${shortened ? ' Shortened: prior scanner use found.' : ''}${tailoredBy.length ? ` Tailored: ${tailoredBy.map((t) => t.reason).join(' ')}` : ''}`,
      evidence,
    });
  }
  for (const id of input.overrides.add) if (!policy.modules.some((m) => m.id === id)) overrides.push(`Ignored unknown module ${id}.`);
  for (const id of input.overrides.add) if (policy.modules.some((m) => m.id === id)) overrides.push(`Manager added ${id}.`);
  for (const id of input.overrides.remove) if (!modules.some((m) => m.id === id)) overrides.push(`Manager removed ${id}.`);

  // Only keep tailoring that actually changed this plan (a module already required isn't tailoring).
  const kept = tailoring.filter((t) => (t.module ? modules.some((m) => m.id === t.module) && !policy.modules.some((m) => m.id === t.module && appliesToTrack(m)) : modules.length > 0));
  const seen = new Set<string>();
  const tailoringOut = kept.filter((t) => { const k = t.module ?? t.ruleId; if (seen.has(k)) return false; seen.add(k); return true; });
  for (const id of fullLength) {
    const t = tailoring.find((x) => (policy.tailoring ?? []).find((r) => r.id === x.ruleId)?.fullLength === id);
    if (t && equipment.has(policy.modules.find((m) => m.id === id)?.shortenedByEquipment ?? '')) {
      reviewItemsInfo(reviewItems, `tailor-${id}`, `${id} kept at full length: ${t.reason}`);
    }
  }
  if (readiness?.status === 'ok' && readiness.mode === 'advisory') {
    const r = readiness;
    const pct = Math.round(r.probabilities![r.label!] * 100);
    if (r.label === 'beginner' && trackId === 'experienced') {
      reviewItemsInfo(reviewItems, 'readiness-mismatch', `Readiness estimate is Beginner (${pct}%) but policy puts them on the Experienced track. Consider track=foundations or extra modules.`);
    } else if (r.label === 'expert' && trackId === 'foundations') {
      reviewItemsInfo(reviewItems, 'readiness-mismatch', `Readiness estimate is Expert (${pct}%). Policy still requires Foundations here (${track.rule.split(':')[0]}); required training is never reduced.`);
    }
  }

  const schedule = track.rampPctByDay.map((pct, i) => ({
    day: i + 1,
    modules: modules.filter((m) => m.days.includes(i + 1)).map((m) => m.id),
    targetPct: hasLicense ? pct : 0,
    targetStops: hasLicense ? Math.round((pct / 100) * policy.standardRoute.stopsPerDay) : 0,
  }));

  for (const item of reviewItems) {
    const resolution = input.overrides.resolved[item.id] ?? input.overrides.resolved.all;
    if (resolution) item.resolution = resolution;
  }
  return {
    policyId: policy.policyId,
    track: { id: trackId, label: track.label, reason: trackReason, evidence: trackEvidence },
    modules,
    schedule,
    facts: input.facts,
    reviewItems,
    missingInfo,
    overrides,
    disclaimer: policy.disclaimer,
    tailoring: tailoringOut,
    ...(readiness ? { readiness } : {}),
    ...(input.preferredShift && policy.shifts?.[input.preferredShift]
      ? { rideAlongStart: { shift: input.preferredShift, time: policy.shifts[input.preferredShift]!, rule: policy.scheduleRule ?? '' } }
      : {}),
  };
}

function reviewItemsInfo(items: ReviewItem[], id: string, text: string): void {
  if (!items.some((r) => r.id === id)) items.push({ id, blocking: false, text });
}

function matchTailoring(policy: Policy, answers: Answer[]): Tailoring[] {
  const out: Tailoring[] = [];
  for (const rule of policy.tailoring ?? []) {
    let value: unknown;
    let excerpt = '';
    if ('field' in rule.when) {
      const a = answers.find((x) => x.field === (rule.when as { field: string }).field);
      if (!a || !rule.when.in.includes(String(a.value))) continue;
      value = a.value;
      excerpt = a.excerpt;
    } else {
      const a = answers.find((x) => x.field === 'confidence');
      const v = a && typeof a.value === 'object' && a.value !== null ? Number((a.value as Record<string, unknown>)[rule.when.rating]) : NaN;
      if (!Number.isFinite(v) || v > rule.when.atMost) continue;
      value = v;
      excerpt = `${rule.when.rating}: ${v}/5`;
    }
    out.push({
      ruleId: rule.id,
      module: rule.add ?? rule.fullLength ?? null,
      reason: rule.reason.replace('{value}', String(value)),
      workerNote: rule.workerNote,
      evidence: [{ source: 'questionnaire', excerpt }],
    });
  }
  return out;
}

export function hashPlan(content: PlanContent): string {
  return createHash('sha256').update(JSON.stringify(content)).digest('hex').slice(0, 16);
}

export function unresolvedBlocking(content: PlanContent): ReviewItem[] {
  return content.reviewItems.filter((r) => r.blocking && !r.resolution);
}
