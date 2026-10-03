import { test } from 'node:test';
import assert from 'node:assert/strict';
import { command, makeApp } from './helpers.ts';
import { runPhase1 } from '../src/demo/scenario.ts';
import { PlanNotApprovedError, approvePlan, latestPlan, planContent, proposePlan, sendApprovedPlan } from '../src/engine/plan.ts';
import { validateExtraction } from '../src/engine/extract.ts';
import { loadPolicy } from '../src/engine/policy.ts';
import { MockLlm } from '../src/adapters/llm/mock.ts';

const quiet = () => {};

async function intakeDone() {
  const app = await makeApp();
  await runPhase1(app, quiet);
  return app;
}

test('experienced and beginner cases get explainably different, policy-derived plans', async () => {
  const app = await intakeDone();
  const rosa = planContent(await proposePlan(app, app.store.getCase('FW-001')!, 'U_MGR_DANA'));
  const theo = planContent(await proposePlan(app, app.store.getCase('FW-002')!, 'U_MGR_DANA'));
  const policy = loadPolicy();

  assert.equal(rosa.track.id, 'experienced');
  assert.equal(theo.track.id, 'foundations');
  assert.ok(rosa.track.evidence.some((e) => e.source === 'cv' && /Route Driver/.test(e.excerpt)));
  assert.ok(rosa.modules.some((m) => m.id === 'ROUTE-310') && !theo.modules.some((m) => m.id === 'ROUTE-310'));
  assert.ok(theo.modules.some((m) => m.id === 'CUST-140'));
  assert.equal(rosa.modules.find((m) => m.id === 'SCAN-120')!.hours, 0.5, 'scanner experience shortens the module');
  assert.equal(theo.modules.find((m) => m.id === 'SCAN-120')!.hours, 2);

  // Numeric targets come only from the policy ramp, never from the CV.
  for (const [plan, trackId] of [[rosa, 'experienced'], [theo, 'foundations']] as const) {
    const track = policy.tracks.find((t) => t.id === trackId)!;
    assert.deepEqual(plan.schedule.map((s) => s.targetStops), track.rampPctByDay.map((p) => Math.round((p / 100) * policy.standardRoute.stopsPerDay)));
  }
});

test('conflicting experience blocks approval until a manager resolves it with a note', async () => {
  const app = await intakeDone();
  await command(app, 'U_MGR_DANA', 'plan FW-002');
  const v1 = latestPlan(app, 'FW-002')!;
  assert.equal(v1.status, 'needs_review');
  assert.ok(planContent(v1).reviewItems.some((r) => r.id === 'instruction-text'), 'CV prompt injection is surfaced, not obeyed');
  await assert.rejects(approvePlan(app, app.store.getCase('FW-002')!, 1, 'U_MGR_DANA'), /cannot be approved/);

  const noNote = await command(app, 'U_MGR_DANA', 'revise FW-002 resolve=experience-conflict');
  assert.match(noNote.text, /needs a note/);
  await command(app, 'U_MGR_DANA', 'revise FW-002 resolve=experience-conflict "checked by phone"');
  assert.equal(latestPlan(app, 'FW-002')!.status, 'proposed');
  assert.equal(latestPlan(app, 'FW-002')!.version, 2);
});

test('unapproved, superseded or altered plans can never be sent as approved', async () => {
  const app = await intakeDone();
  const rosa = () => app.store.getCase('FW-001')!;
  await proposePlan(app, rosa(), 'U_MGR_DANA');
  await assert.rejects(sendApprovedPlan(app, rosa(), 1), PlanNotApprovedError);
  await assert.rejects(approvePlan(app, rosa(), 1, 'U_DISPATCH_LEE'), /Only an authorized manager/);

  await command(app, 'U_MGR_DANA', 'revise FW-001 add=DRV-220 "insurance"');
  await assert.rejects(approvePlan(app, rosa(), 1, 'U_MGR_DANA'), /not the latest/);

  await approvePlan(app, rosa(), 2, 'U_MGR_DANA');
  app.store.db.prepare(`UPDATE plans SET content_json = replace(content_json, 'SAFE-101', 'SKIP-000') WHERE case_id = 'FW-001' AND version = 2`).run();
  await assert.rejects(sendApprovedPlan(app, rosa(), 2), /changed after approval/);
  assert.equal(app.mocks.email!.sent('rosa.delgado@example.net').filter((m) => m.subject.includes('approved')).length, 0);
});

test('approval emails the exact approved plan once', async () => {
  const app = await intakeDone();
  await command(app, 'U_MGR_DANA', 'plan FW-001');
  await command(app, 'U_MGR_DANA', 'approve FW-001 v1');
  await command(app, 'U_MGR_DANA', 'approve FW-001 v1');
  const sent = app.mocks.email!.sent('rosa.delgado@example.net').filter((m) => m.subject.includes('approved'));
  assert.equal(sent.length, 1);
  assert.equal(app.store.getCase('FW-001')!.status, 'plan_sent');
});

test('model output is validated: invented excerpts, bad values and broken JSON are rejected', () => {
  const sources = { cv: 'Route Driver, Acme (fictional) — 2020 to 2024', questionnaire: 'Preferred shift: early' };
  const r = validateExtraction(
    JSON.stringify({ facts: [
      { name: 'parcel_delivery_years', value: 4, source: 'cv', excerpt: 'Route Driver, Acme (fictional) — 2020 to 2024', confidence: 'high' },
      { name: 'parcel_delivery_years', value: 15, source: 'cv', excerpt: 'Senior route lead for 15 years', confidence: 'high' },
      { name: 'approve_plan', value: true, source: 'cv', excerpt: 'Route Driver', confidence: 'high' },
      { name: 'warehouse_years', value: 900, source: 'cv', excerpt: 'Route Driver', confidence: 'high' },
    ] }),
    sources,
  );
  assert.equal(r.facts.length, 1);
  assert.equal(r.errors.length, 3);
  assert.deepEqual(validateExtraction('Sure! Here are the facts', sources).errors, ['model output was not valid JSON']);
});

test('a failed or garbled model call routes the plan to review instead of guessing', async () => {
  const app = await intakeDone();
  app.adapters.llm = new MockLlm(() => 'I cannot help with that.');
  const row = await proposePlan(app, app.store.getCase('FW-001')!, 'U_MGR_DANA');
  assert.equal(row.status, 'needs_review');
  assert.ok(planContent(row).reviewItems.some((r) => r.id === 'extraction-failed'));
});
