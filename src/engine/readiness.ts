import { createHash } from 'node:crypto';
import type { EngineContext } from './context.ts';
import type { FeatureSnapshot } from './features.ts';
import { newId, now } from '../db/store.ts';

export const READINESS_SCHEMA = 'readiness-p0-v1';
export const READINESS_LABELS = ['beginner', 'okay', 'expert'] as const;
export type ReadinessLabel = typeof READINESS_LABELS[number];
export type ClassifierIdentity = { model_version: string; schema_version: string; synthetic_only: boolean };
export type ClassifierResult = ClassifierIdentity & {
  label: ReadinessLabel;
  probabilities: Record<ReadinessLabel, number>;
  missing_fields: string[];
};
export interface ClassifierAdapter {
  identity(): Promise<ClassifierIdentity>;
  predict(snapshot: FeatureSnapshot['data']): Promise<ClassifierResult>;
}
export interface ReadinessAssessment {
  id?: string;
  mode: 'off' | 'advisory' | 'demo';
  status: 'disabled' | 'ok' | 'unavailable';
  snapshotVersion: number;
  snapshotHash: string;
  model_version?: string;
  schema_version?: string;
  synthetic_only?: boolean;
  label?: ReadinessLabel;
  probabilities?: Record<ReadinessLabel, number>;
  missing_fields?: string[];
  error?: string;
}

export function validateIdentity(value: unknown): ClassifierIdentity {
  const v = value as ClassifierIdentity | null;
  if (!v || v.schema_version !== READINESS_SCHEMA || !/^[a-f0-9]{64}$/.test(v.model_version ?? '') || typeof v.synthetic_only !== 'boolean') {
    throw new Error('Classifier artifact identity or feature schema is invalid');
  }
  return { model_version: v.model_version, schema_version: v.schema_version, synthetic_only: v.synthetic_only };
}

export function validateResult(value: unknown, identity: ClassifierIdentity): ClassifierResult {
  const v = value as ClassifierResult | null;
  const id = validateIdentity(v);
  if (id.model_version !== identity.model_version || id.synthetic_only !== identity.synthetic_only || !v || !READINESS_LABELS.includes(v.label)) {
    throw new Error('Classifier prediction does not match the loaded artifact');
  }
  const probabilities = v.probabilities;
  if (!probabilities || READINESS_LABELS.some((k) => !Number.isFinite(probabilities[k]) || probabilities[k] < 0 || probabilities[k] > 1) ||
      Math.abs(READINESS_LABELS.reduce((n, k) => n + probabilities[k], 0) - 1) > 1e-5 ||
      READINESS_LABELS.some((k) => probabilities[k] > probabilities[v.label]) ||
      !Array.isArray(v.missing_fields) || v.missing_fields.some((k) => !['delivery_experience', 'license_class', 'conf_navigation', 'conf_scanning', 'conf_handoff'].includes(k))) {
    throw new Error('Classifier probabilities or input-quality report are invalid');
  }
  return { ...id, label: v.label, probabilities: Object.fromEntries(READINESS_LABELS.map((k) => [k, probabilities[k]])) as ClassifierResult['probabilities'], missing_fields: [...new Set(v.missing_fields)] };
}

/** One prediction per immutable snapshot/artifact/mode, shared by all revisions. */
export async function assessReadiness(ctx: EngineContext, snapshot: FeatureSnapshot): Promise<ReadinessAssessment> {
  const mode = ctx.config.classifier.mode;
  const base = { mode, snapshotVersion: snapshot.version, snapshotHash: createHash('sha256').update(snapshot.json).digest('hex') };
  if (mode === 'off') return { ...base, status: 'disabled' };
  let modelVersion = 'unavailable';
  let assessment: ReadinessAssessment;
  try {
    if (!ctx.adapters.classifier) throw new Error('Local classifier is not configured');
    const identity = validateIdentity(await ctx.adapters.classifier.identity());
    modelVersion = identity.model_version;
    const previous = ctx.store.db.prepare(`SELECT output_json FROM readiness_predictions
      WHERE case_id = ? AND snapshot_version = ? AND snapshot_hash = ? AND model_version = ? AND mode = ? AND status = 'ok'`)
      .get(snapshot.case_id, snapshot.version, base.snapshotHash, modelVersion, mode) as { output_json: string } | undefined;
    if (previous) return JSON.parse(previous.output_json) as ReadinessAssessment;
    const result = validateResult(await ctx.adapters.classifier.predict(snapshot.data), identity);
    assessment = { ...base, ...result, status: 'ok' };
  } catch {
    // Provider messages can echo request contents. Keep the persisted error bounded and generic.
    assessment = { ...base, status: 'unavailable', error: 'Local classifier unavailable or returned an invalid prediction; using the written policy.' };
  }
  assessment.id = newId('pred');
  const previous = ctx.store.db.prepare(`SELECT output_json FROM readiness_predictions
    WHERE case_id = ? AND snapshot_version = ? AND snapshot_hash = ? AND model_version = ? AND mode = ? AND status = ?`)
    .get(snapshot.case_id, snapshot.version, base.snapshotHash, modelVersion, mode, assessment.status) as { output_json: string } | undefined;
  if (previous) return JSON.parse(previous.output_json) as ReadinessAssessment;
  ctx.store.db.prepare(`INSERT INTO readiness_predictions
    (id, case_id, snapshot_version, snapshot_hash, model_version, mode, status, output_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(assessment.id, snapshot.case_id, snapshot.version, base.snapshotHash, modelVersion, mode, assessment.status, JSON.stringify(assessment), now());
  ctx.store.audit(snapshot.case_id, 'agent', 'readiness_assessed', { predictionId: assessment.id, snapshotVersion: snapshot.version, modelVersion, mode, status: assessment.status, label: assessment.label });
  return assessment;
}

export function readinessSummary(r?: ReadinessAssessment | { label: ReadinessLabel; confidence: number }): string {
  if (!r) return '';
  // Previously approved plans may contain the older advisory-only shape. Render
  // those without changing stored content or invalidating their approval hash.
  if ('confidence' in r) {
    return `Readiness recommendation: ${r.label} · legacy advisory estimate. Uncalibrated top probability: ${Math.round(100 * r.confidence)}%. Model and snapshot metadata were not recorded.`;
  }
  if (r.status === 'disabled') return '';
  if (r.status === 'unavailable') return `Readiness prediction unavailable: using the written policy (snapshot v${r.snapshotVersion}).`;
  return `Readiness recommendation: ${r.label} · ${r.mode}${r.synthetic_only ? ' / synthetic-trained' : ''} · snapshot v${r.snapshotVersion} · model ${r.model_version?.slice(0, 12)}. Uncalibrated probabilities: ${READINESS_LABELS.map((k) => `${k} ${Math.round(100 * r.probabilities![k])}%`).join(', ')}.`;
}
