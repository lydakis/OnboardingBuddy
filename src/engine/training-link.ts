// Link to the worker's interactive training page on the public site. The page is static;
// the approved plan travels in the URL fragment (#p=...), which browsers never send to the
// server, so no worker data is uploaded anywhere. Only the first name and the plan go in.
import type { PlanContent } from './policy.ts';

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
  };
}

export function trainingUrl(payload: TrainingPayload, base = TRAINING_BASE_URL): string {
  return `${base}#p=${Buffer.from(JSON.stringify(payload)).toString('base64url')}`;
}

export function decodeTrainingUrl(url: string): TrainingPayload {
  return JSON.parse(Buffer.from(url.split('#p=')[1]!, 'base64url').toString('utf8')) as TrainingPayload;
}
