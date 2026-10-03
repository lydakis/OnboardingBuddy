// Questionnaire answers → plan facts, and the per-case feature snapshot.
import type { EngineContext } from './context.ts';
import type { Fact } from './extract.ts';
import { items } from './slack-questionnaire.ts';
import { loadPolicy } from './policy.ts';
import { now } from '../db/store.ts';

/** Deterministic facts from answered Slack questions; the worker's reply is the excerpt. */
export function questionnaireFacts(ctx: EngineContext, caseId: string, cvFacts: Fact[], frozen?: FeatureSnapshot['data']): Fact[] {
  const out: Fact[] = [];
  const fact = (name: Fact['name'], value: Fact['value'], excerpt: string) => out.push({ name, value, source: 'questionnaire', excerpt, confidence: 'high' });
  const answers = frozen ? frozen.asked.filter((i) => i.value !== null).map((i) => ({ field: i.field, value: i.value, excerpt: i.raw ?? i.excerpt ?? '' })) :
    items(ctx, caseId).filter((i) => i.status === 'answered' && i.answer_value_json).map((i) => ({ field: i.field, value: JSON.parse(i.answer_value_json!), excerpt: i.answer_raw ?? i.excerpt ?? '' }));
  for (const i of answers) {
    const v = i.value;
    const excerpt = i.excerpt;
    if (i.field === 'delivery') {
      if (v.confirmed) {
        // "Yes, that's right" confirms all delivery work on the CV, parcel and other.
        const years = (name: Fact['name']) => cvFacts.filter((f) => f.source === 'cv' && f.name === name).reduce((a, f) => a + Number(f.value), 0);
        fact('parcel_delivery_years', years('parcel_delivery_years'), excerpt);
        const other = years('other_delivery_years');
        if (other > 0) fact('other_delivery_years', other, excerpt);
      } else if (typeof v.years === 'number') {
        fact(v.kind === 'parcel' ? 'parcel_delivery_years' : 'other_delivery_years', v.years, excerpt);
      }
    } else if (i.field === 'license_class') {
      fact('license_class', v === 'none' ? 'none' : v === 'cdl' ? 'CDL' : 'Class C/D', excerpt);
    } else if (i.field === 'equipment' && Array.isArray(v)) {
      for (const e of v) fact('equipment', e, excerpt);
    } else if (i.field === 'largest_vehicle' && v === 'box_truck') {
      fact('equipment', 'box truck', excerpt);
    }
  }
  return out;
}

export function answeredValue(ctx: EngineContext, caseId: string, field: string): unknown {
  const i = items(ctx, caseId).find((x) => x.field === field && x.status === 'answered');
  return i?.answer_value_json ? JSON.parse(i.answer_value_json) : undefined;
}

export interface FeatureSnapshot {
  case_id: string;
  version: number;
  json: string;
  data: {
    asked: { field: string; raw: string | null; value: any; excerpt: string | null; asked: boolean }[];
    cv: { field: Fact['name']; value: Fact['value']; excerpt: string; asked: boolean; confidence?: Fact['confidence'] }[];
  };
}

export function latestFeatureSnapshot(ctx: EngineContext, caseId: string): FeatureSnapshot | undefined {
  const row = ctx.store.db.prepare("SELECT case_id, version, json FROM feature_snapshots WHERE case_id = ? AND reason = 'questionnaire_complete' ORDER BY version DESC LIMIT 1").get(caseId) as Omit<FeatureSnapshot, 'data'> | undefined;
  return row ? { ...row, data: JSON.parse(row.json) } : undefined;
}

export function writeFeatureSnapshot(ctx: EngineContext, caseId: string, reason: string): void {
  const prev = ctx.store.db.prepare('SELECT MAX(version) AS v FROM feature_snapshots WHERE case_id = ?').get(caseId) as { v: number | null };
  const ext = ctx.store.db.prepare(`SELECT output_json FROM extractions WHERE case_id = ? AND status = 'accepted' ORDER BY created_at DESC LIMIT 1`).get(caseId) as { output_json: string } | undefined;
  const cvFacts = ext ? (JSON.parse(ext.output_json) as Fact[]).filter((f) => f.source === 'cv') : [];
  const json = {
    asked: items(ctx, caseId).map((i) => ({ field: i.field, raw: i.answer_raw, value: i.answer_value_json ? JSON.parse(i.answer_value_json) : null, excerpt: i.excerpt, asked: true })),
    cv: cvFacts.map((f) => ({ field: f.name, value: f.value, excerpt: f.excerpt, confidence: f.confidence, asked: false })),
  };
  ctx.store.db
    .prepare('INSERT INTO feature_snapshots (case_id, version, policy_id, reason, json, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(caseId, (prev.v ?? 0) + 1, loadPolicy().policyId, reason, JSON.stringify(json), now());
}
