// Link to the worker's interactive training page on the public site. The page is static;
// the approved plan travels in the URL fragment (#p=...), which browsers never send to the
// server, so no worker data is uploaded anywhere. Only the first name and the plan go in.
import { deflateRawSync, inflateRawSync } from 'node:zlib';
import type { Lesson, PlanContent } from './policy.ts';

export const TRAINING_BASE_URL = process.env.OB_TRAINING_URL ?? 'https://onboarding-buddy-chi.vercel.app/training/';

export interface TrainingPayload {
  v: 1;
  n: string;
  c: string;
  pv: number;
  t: PlanContent['track']['id'];
  tl: string;
  s: string | null;
  d: [number, string[], number][];
  h: Record<string, number>;
  w: string[];
  l?: Record<string, Lesson>;
}

export function trainingPayload(caseId: string, version: number, firstName: string, p: PlanContent, notes: string[]): TrainingPayload {
  return {
    v: 1,
    n: firstName,
    c: caseId,
    pv: version,
    t: p.track.id,
    tl: p.track.label,
    s: p.rideAlongStart?.time ?? null,
    d: p.schedule.filter((s) => s.modules.length || s.targetStops).map((s) => [s.day, s.modules, s.targetStops]),
    h: Object.fromEntries(p.modules.map((m) => [m.id, m.hours])),
    w: notes,
    ...(p.lessons && Object.keys(p.lessons).length ? { l: p.lessons } : {}),
  };
}

// Compressed (#z=, deflate-raw) so tailored lessons fit in one Slack message.
export function trainingUrl(payload: TrainingPayload, base = TRAINING_BASE_URL): string {
  return `${base}#z=${deflateRawSync(Buffer.from(JSON.stringify(payload))).toString('base64url')}`;
}

/** Drops tailored lessons from the end of the plan until the link fits Slack's message limit. */
export function fitTrainingUrl(payload: TrainingPayload, maxLength = 2600, base = TRAINING_BASE_URL): string {
  const p: TrainingPayload = { ...payload, l: payload.l ? { ...payload.l } : undefined };
  let url = trainingUrl(p, base);
  const order = p.d.flatMap(([, mods]) => mods).reverse();
  for (const id of order) {
    if (url.length <= maxLength || !p.l) break;
    delete p.l[id];
    url = trainingUrl(p, base);
  }
  return url;
}

export function decodeTrainingUrl(url: string): TrainingPayload {
  const z = url.split('#z=')[1];
  if (z) return JSON.parse(inflateRawSync(Buffer.from(z, 'base64url')).toString('utf8')) as TrainingPayload;
  return JSON.parse(Buffer.from(url.split('#p=')[1]!, 'base64url').toString('utf8')) as TrainingPayload;
}
