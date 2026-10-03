// Deterministic plan builder. The model only supplies validated facts; the track,
// modules and numeric targets all come from the written policy.
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import type { Fact } from './extract.ts';

export type TrackId = 'experienced' | 'foundations';

export interface Policy {
  policyId: string;
  company: string;
  disclaimer: string;
  standardRoute: { stopsPerDay: number };
  review: { experienceToleranceYears: number; rule: string };
  tracks: { id: TrackId; label: string; rule: string; minParcelYears: number; requiresLicense: boolean; rampPctByDay: number[] }[];
  modules: {
    id: string;
    title: string;
    hours: number;
    shortHours?: number;
    shortenedByEquipment?: string;
    appliesTo: 'all' | 'licensed' | TrackId;
    day: Partial<Record<TrackId, number>>;
    daysByTrack?: Partial<Record<TrackId, number>>;
    evidence: string;
    rule: string;
  }[];
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
}

export interface PlanInputs {
  facts: Fact[];
  extractionErrors: string[];
  extractionFailed: boolean;
  licenseAnswer: string | null; // from the questionnaire checklist
  licenseExcerpt: string | null;
  injectionExcerpt: string | null;
  overrides: { track?: TrackId; add: string[]; remove: string[]; resolved: Record<string, string> };
}

const sum = (xs: number[]) => Math.round(xs.reduce((a, b) => a + b, 0) * 10) / 10;

export function buildPlan(policy: Policy, input: PlanInputs): PlanContent {
  const f = (name: Fact['name'], source?: Fact['source']) => input.facts.filter((x) => x.name === name && (!source || x.source === source));
  const ev = (facts: Fact[]): Evidence[] => facts.map((x) => ({ source: x.source, excerpt: x.excerpt }));

  const parcelCv = f('parcel_delivery_years', 'cv');
  const parcelCvYears = sum(parcelCv.map((x) => Number(x.value)));
  const claimed = [...f('parcel_delivery_years', 'questionnaire'), ...f('other_delivery_years', 'questionnaire')];
  const claimedYears = claimed.length ? Math.max(...claimed.map((x) => Number(x.value))) : 0;
  const cvDeliveryYears = sum([...parcelCv, ...f('other_delivery_years', 'cv')].map((x) => Number(x.value)));
  const licenseFacts = f('license_class');
  const hasLicense = (input.licenseAnswer !== null && input.licenseAnswer !== 'none') || licenseFacts.some((x) => String(x.value).toLowerCase() !== 'none');
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
  for (const item of reviewItems) {
    const resolution = input.overrides.resolved[item.id] ?? input.overrides.resolved.all;
    if (resolution) item.resolution = resolution;
  }

  const missingInfo: string[] = [];
  if (!hasLicense) missingInfo.push("No driver's license on file: vehicle modules are excluded until one is provided.");
  if (licenseFacts.length === 0 && hasLicense) missingInfo.push('License class was not found in the CV; using the questionnaire answer.');
  if (parcelCv.length === 0) missingInfo.push('No parcel or route delivery roles found in the CV.');

  const experiencedTrack = policy.tracks.find((t) => t.id === 'experienced')!;
  const qualifies = parcelCvYears >= experiencedTrack.minParcelYears && (!experiencedTrack.requiresLicense || hasLicense);
  let trackId: TrackId = qualifies ? 'experienced' : 'foundations';
  const overrides: string[] = [];
  if (input.overrides.track && input.overrides.track !== trackId) {
    overrides.push(`Manager set track to ${input.overrides.track} (policy suggested ${trackId}).`);
    trackId = input.overrides.track;
  }
  const track = policy.tracks.find((t) => t.id === trackId)!;
  const trackEvidence: Evidence[] = [...ev(parcelCv), ...ev(licenseFacts)];
  if (input.licenseExcerpt) trackEvidence.push({ source: 'questionnaire', excerpt: input.licenseExcerpt });
  const trackReason = `${track.rule} CV parcel/route experience: ${parcelCvYears} year(s); license: ${hasLicense ? 'yes' : 'no'}.`;

  const modules: PlanModule[] = [];
  for (const m of policy.modules) {
    const applies =
      m.appliesTo === 'all' || m.appliesTo === trackId || (m.appliesTo === 'licensed' && hasLicense);
    const forcedIn = input.overrides.add.includes(m.id);
    if ((!applies && !forcedIn) || input.overrides.remove.includes(m.id)) continue;
    const start = m.day[trackId] ?? 1;
    const count = m.daysByTrack?.[trackId] ?? 1;
    const days = Array.from({ length: count }, (_, i) => start + i);
    const shortened = m.shortenedByEquipment !== undefined && equipment.has(m.shortenedByEquipment);
    const evidence: Evidence[] = [];
    if (shortened) evidence.push(...ev(f('equipment').filter((x) => x.value === m.shortenedByEquipment)));
    if (m.appliesTo === 'licensed') evidence.push(...ev(licenseFacts));
    modules.push({
      id: m.id,
      title: m.title,
      hours: shortened && m.shortHours !== undefined ? m.shortHours : m.hours,
      days,
      evidenceRequired: m.evidence,
      reason: forcedIn && !applies ? 'Added by manager.' : `${m.rule}${shortened ? ' Shortened: prior scanner use found.' : ''}`,
      evidence,
    });
  }
  for (const id of input.overrides.add) if (!policy.modules.some((m) => m.id === id)) overrides.push(`Ignored unknown module ${id}.`);
  for (const id of input.overrides.add) if (policy.modules.some((m) => m.id === id)) overrides.push(`Manager added ${id}.`);
  for (const id of input.overrides.remove) overrides.push(`Manager removed ${id}.`);

  const schedule = track.rampPctByDay.map((pct, i) => ({
    day: i + 1,
    modules: modules.filter((m) => m.days.includes(i + 1)).map((m) => m.id),
    targetPct: pct,
    targetStops: Math.round((pct / 100) * policy.standardRoute.stopsPerDay),
  }));

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
  };
}

export function hashPlan(content: PlanContent): string {
  return createHash('sha256').update(JSON.stringify(content)).digest('hex').slice(0, 16);
}

export function unresolvedBlocking(content: PlanContent): ReviewItem[] {
  return content.reviewItems.filter((r) => r.blocking && !r.resolution);
}
