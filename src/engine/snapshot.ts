// What the sandboxed agent is allowed to see. Built fresh for every agent task.
// Manager scope: every case (managers may see all of them).
// Case scope: one worker's approved plan and policy only, with no CV/email text.
import type { EngineContext } from './context.ts';
import { latestPlan, planContent } from './plan.ts';
import { loadPolicy } from './policy.ts';
import { getInvitation } from './join.ts';
import type { CaseRow } from '../types.ts';

export type SnapshotScope = 'manager' | `case:${string}`;

function caseView(ctx: EngineContext, c: CaseRow, withEvidence: boolean) {
  const items = ctx.store.checklist(c.id);
  const row = latestPlan(ctx, c.id);
  const plan = row ? (({ overrideInput: _o, facts, track, modules, ...rest }) => ({
    version: row.version,
    status: row.status,
    ...rest,
    track: withEvidence ? track : { id: track.id, label: track.label },
    modules: modules.map((m) => (withEvidence ? m : { id: m.id, title: m.title, hours: m.hours, days: m.days, evidenceRequired: m.evidenceRequired })),
    ...(withEvidence ? { facts } : {}),
  }))(planContent(row)) : null;
  const inv = getInvitation(ctx, c.id);
  return {
    id: c.id,
    worker: c.worker_name,
    status: c.status,
    needsAttention: c.needs_attention,
    intake: {
      complete: items.filter((i) => i.status === 'complete').length,
      total: items.length,
      missing: items.filter((i) => i.status !== 'complete').map((i) => i.label),
    },
    plan: plan && !withEvidence ? { ...plan, reviewItems: [] } : plan,
    invitation: inv ? { state: inv.state, reviewReason: inv.review_reason } : null,
  };
}

export function buildSnapshot(ctx: EngineContext, scope: SnapshotScope) {
  const policy = loadPolicy();
  const cases = scope === 'manager'
    ? ctx.store.listCases().map((c) => caseView(ctx, c, true))
    : [caseView(ctx, ctx.store.getCase(scope.slice(5))!, false)];
  return { scope, generatedAt: new Date().toISOString(), company: ctx.config.companyName, policy, cases };
}

export type Snapshot = ReturnType<typeof buildSnapshot>;

export function scopeDir(scope: SnapshotScope): string {
  return scope === 'manager' ? 'manager' : `case-${scope.slice(5)}`;
}
