// Questionnaire answers → plan facts, and the per-case feature snapshot.
import type { EngineContext } from './context.ts';
import type { Fact } from './extract.ts';
import { items } from './slack-questionnaire.ts';
import { loadPolicy } from './policy.ts';
import { now } from '../db/store.ts';

/** Deterministic facts from answered Slack questions; the worker's reply is the excerpt. */
export function questionnaireFacts(ctx: EngineContext, caseId: string, cvFacts: Fact[]): Fact[] {
  const out: Fact[] = [];
  const fact = (name: Fact['name'], value: Fact['value'], excerpt: string) => out.push({ name, value, source: 'questionnaire', excerpt, confidence: 'high' });
  for (const i of items(ctx, caseId).filter((x) => x.status === 'answered' && x.answer_value_json)) {
    const v = JSON.parse(i.answer_value_json!);
    const excerpt = i.answer_raw ?? i.excerpt ?? '';
    if (i.field === 'delivery') {
      if (v.confirmed) {
        const cvYears = cvFacts.filter((f) => f.source === 'cv' && f.name === 'parcel_delivery_years').reduce((a, f) => a + Number(f.value), 0);
        fact('parcel_delivery_years', cvYears, excerpt);
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

export function writeFeatureSnapshot(ctx: EngineContext, caseId: string, reason: string): void {
  const prev = ctx.store.db.prepare('SELECT MAX(version) AS v FROM feature_snapshots WHERE case_id = ?').get(caseId) as { v: number | null };
  const ext = ctx.store.db.prepare(`SELECT output_json FROM extractions WHERE case_id = ? AND status = 'accepted' ORDER BY created_at DESC LIMIT 1`).get(caseId) as { output_json: string } | undefined;
  const cvFacts = ext ? (JSON.parse(ext.output_json) as Fact[]).filter((f) => f.source === 'cv') : [];
  const json = {
    asked: items(ctx, caseId).map((i) => ({ field: i.field, raw: i.answer_raw, value: i.answer_value_json ? JSON.parse(i.answer_value_json) : null, excerpt: i.excerpt, asked: true })),
    cv: cvFacts.map((f) => ({ field: f.name, value: f.value, excerpt: f.excerpt, asked: false })),
  };
  ctx.store.db
    .prepare('INSERT INTO feature_snapshots (case_id, version, policy_id, reason, json, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(caseId, (prev.v ?? 0) + 1, loadPolicy().policyId, reason, JSON.stringify(json), now());
}
