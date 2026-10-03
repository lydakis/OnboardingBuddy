import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeApp, command } from './helpers.ts';
import { runPhase1, runPhase2 } from '../src/demo/scenario.ts';
import { proposePlan, planContent, planSummary, latestPlan, approvePlan, sendApprovedPlan } from '../src/engine/plan.ts';
import { buildPlan, hashPlan, loadPolicy } from '../src/engine/policy.ts';
import { loadConfig } from '../src/config.ts';
import type { ReadinessAssessment, ClassifierAdapter } from '../src/engine/readiness.ts';
import { createServer } from 'node:http';
import { LocalClassifier } from '../src/adapters/classifier.ts';

const version = 'a'.repeat(64);
function classifier(label: 'beginner' | 'okay' | 'expert'): ClassifierAdapter {
  return {
    identity: async () => ({ model_version: version, schema_version: 'readiness-p0-v1', synthetic_only: true }),
    predict: async () => ({ model_version: version, schema_version: 'readiness-p0-v1', synthetic_only: true,
      label, probabilities: { beginner: label === 'beginner' ? 0.8 : 0.1, okay: label === 'okay' ? 0.8 : 0.1, expert: label === 'expert' ? 0.8 : 0.1 }, missing_fields: [] }),
  };
}
async function completed() {
  const app = await makeApp();
  await runPhase1(app, () => {});
  await runPhase2(app, () => {});
  app.config.classifier.mode = 'demo';
  return app;
}

test('a plan cannot bypass confirmation even if intake is complete or all questions are answered', async () => {
  const app = await makeApp();
  await runPhase1(app, () => {});
  await assert.rejects(proposePlan(app, app.store.getCase('FW-001')!, 'U_MGR_DANA'), /confirmed questionnaire/);
  await runPhase2(app, () => {});
  app.store.db.prepare("DELETE FROM feature_snapshots WHERE case_id = 'FW-001'").run();
  assert.equal((app.store.db.prepare("SELECT COUNT(*) AS n FROM questionnaire_items WHERE case_id = 'FW-001' AND status != 'answered'").get() as { n: number }).n, 0);
  await assert.rejects(proposePlan(app, app.store.getCase('FW-001')!, 'U_MGR_DANA'), /confirmed questionnaire/);
  app.close();
});

test('the three labels select distinct policy tracks while mandatory modules survive overrides', async () => {
  for (const [label, track] of [['beginner', 'foundations'], ['okay', 'intermediate'], ['expert', 'experienced']] as const) {
    const app = await completed();
    app.adapters.classifier = classifier(label);
    const row = await proposePlan(app, app.store.getCase('FW-001')!, 'U_MGR_DANA', { add: [], remove: ['SAFE-101'], resolved: {} });
    const plan = planContent(row);
    assert.equal(plan.track.id, track);
    assert.ok(plan.modules.some((m) => m.id === 'SAFE-101'));
    assert.ok(plan.modules.some((m) => m.id === 'DOT-110'));
    assert.equal(plan.readiness?.label, label);
    const expected = loadPolicy().tracks.find((t) => t.id === track)!;
    assert.deepEqual(plan.schedule.map((s) => s.targetPct), expected.rampPctByDay);
    app.close();
  }
});

test('revisions reuse a prediction and frozen facts; changed prediction invalidates approval', async () => {
  const app = await completed();
  let calls = 0;
  const adapter = classifier('okay');
  const predict = adapter.predict;
  adapter.predict = async (...args) => { calls++; return predict(...args); };
  app.adapters.classifier = adapter;
  const first = planContent(await proposePlan(app, app.store.getCase('FW-001')!, 'U_MGR_DANA'));
  const changed = app.store.db.prepare("UPDATE questionnaire_items SET answer_value_json = ? WHERE case_id = 'FW-001' AND field = 'delivery'").run(JSON.stringify({ kind: 'parcel', years: 99 }));
  assert.equal(changed.changes, 1);
  await command(app, 'U_MGR_DANA', 'revise FW-001 track=foundations "more practice"');
  const second = planContent(await proposePlan(app, app.store.getCase('FW-001')!, 'U_MGR_DANA'));
  assert.equal(calls, 1);
  assert.equal(first.readiness?.id, second.readiness?.id);
  assert.deepEqual(first.facts, second.facts);
  assert.equal(second.track.id, 'foundations');
  const approved = latestPlan(app, 'FW-001')!;
  await approvePlan(app, app.store.getCase('FW-001')!, approved.version, 'U_MGR_DANA');
  app.store.db.prepare("UPDATE plans SET content_json = replace(content_json, 'okay', 'expert') WHERE case_id = 'FW-001' AND version = ?").run(approved.version);
  await assert.rejects(sendApprovedPlan(app, app.store.getCase('FW-001')!, approved.version), /changed after approval/);
  app.close();
});

test('unavailable or malformed inference falls back visibly; advisory mode does not change the policy track', async () => {
  for (const malformed of [false, true]) {
    const app = await completed();
    const adapter = classifier('okay');
    adapter.predict = async () => { if (!malformed) throw new Error('classifier unavailable'); return { ...await classifier('okay').predict({ asked: [], cv: [] }), probabilities: { beginner: 0, okay: 2, expert: 0 } }; };
    app.adapters.classifier = adapter;
    const plan = planContent(await proposePlan(app, app.store.getCase('FW-001')!, 'U_MGR_DANA'));
    assert.equal(plan.track.id, 'experienced');
    assert.equal(plan.readiness?.status, 'unavailable');
    assert.ok(plan.reviewItems.some((r) => r.id === 'classifier-unavailable'));
    app.close();
  }
  const app = await completed();
  app.config.classifier.mode = 'advisory';
  app.adapters.classifier = classifier('beginner');
  const advisory = await proposePlan(app, app.store.getCase('FW-001')!, 'U_MGR_DANA');
  assert.equal(planContent(advisory).track.id, 'experienced');
  assert.ok(planContent(advisory).reviewItems.some((r) => r.id === 'readiness-mismatch' && !r.blocking));
  await approvePlan(app, app.store.getCase('FW-001')!, advisory.version, 'U_MGR_DANA');
  await sendApprovedPlan(app, app.store.getCase('FW-001')!, advisory.version);
  assert.doesNotMatch(app.mocks.slack!.posts('U_ROSA').at(-1)!.text, /Readiness|beginner/);
  app.close();
});

test('low certainty and missing inputs require review; license absence cannot be overridden', () => {
  const readiness: ReadinessAssessment = { id: 'prediction', mode: 'demo', status: 'ok', snapshotVersion: 1, snapshotHash: version,
    model_version: version, schema_version: 'readiness-p0-v1', synthetic_only: true, label: 'expert',
    probabilities: { beginner: 0.30, okay: 0.31, expert: 0.39 }, missing_fields: ['conf_navigation'] };
  const plan = buildPlan(loadPolicy(), { facts: [{ name: 'license_class', value: 'CDL', source: 'cv', excerpt: 'CDL holder', confidence: 'high' }], extractionErrors: [], extractionFailed: false, licenseAnswer: 'none', licenseExcerpt: 'none', injectionExcerpt: null,
    readiness, overrides: { track: 'experienced', add: ['VEH-210'], remove: ['DOT-110'], resolved: {} } });
  assert.equal(plan.track.id, 'foundations');
  assert.ok(plan.modules.some((m) => m.id === 'DOT-110'));
  assert.ok(!plan.modules.some((m) => m.id === 'VEH-210'));
  assert.ok(plan.schedule.every((s) => s.targetStops === 0));
  assert.ok(plan.reviewItems.some((r) => r.id === 'classifier-uncertain' && r.blocking));
  assert.ok(plan.reviewItems.some((r) => r.id === 'classifier-missing-inputs' && r.blocking));
});

test('legacy readiness estimates remain readable without changing approved plan content', async () => {
  const app = await completed();
  const row = latestPlan(app, 'FW-001')!;
  const json = JSON.stringify({ ...planContent(row), readiness: { label: 'expert', confidence: 0.8 } });
  app.store.db.prepare('UPDATE plans SET content_json = ?, content_hash = ? WHERE id = ?').run(json, hashPlan(JSON.parse(json)), row.id);
  await approvePlan(app, app.store.getCase('FW-001')!, row.version, 'U_MGR_DANA');
  assert.match(planSummary(app.store.getCase('FW-001')!, latestPlan(app, 'FW-001')!).text, /legacy advisory estimate/);
  await sendApprovedPlan(app, app.store.getCase('FW-001')!, row.version);
  assert.equal(latestPlan(app, 'FW-001')!.content_json, json);
  assert.equal(app.store.getCase('FW-001')!.status, 'plan_sent');
  app.close();
});

test('classifier configuration rejects non-loopback destinations', () => {
  for (const endpoint of ['https://example.com', 'http://10.0.0.1:4610', 'http://localhost:4610', 'http://127.0.0.1:4610@evil.example']) {
    assert.throws(() => loadConfig({ OB_CLASSIFIER_MODE: 'demo', OB_CLASSIFIER_URL: endpoint }), /loopback/);
  }
});

test('the local HTTP adapter rejects redirects and bounds unresponsive inference', async () => {
  const server = createServer((req, res) => {
    if (req.url === '/health') res.end(JSON.stringify({ model_version: version, schema_version: 'readiness-p0-v1', synthetic_only: true }));
    else if (req.headers['content-type'] === 'application/json') { res.writeHead(302, { Location: 'https://example.com/predict' }); res.end(); }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const adapter = new LocalClassifier(`http://127.0.0.1:${address.port}`, 500);
  try { await assert.rejects(adapter.predict({ asked: [], cv: [] })); }
  finally { server.close(); server.closeAllConnections(); }

  const stalled = createServer(() => {});
  await new Promise<void>((resolve) => stalled.listen(0, '127.0.0.1', resolve));
  const slow = stalled.address();
  assert.ok(slow && typeof slow !== 'string');
  try { await assert.rejects(new LocalClassifier(`http://127.0.0.1:${slow.port}`, 30).identity(), /timeout/i); }
  finally { stalled.close(); stalled.closeAllConnections(); }
});

test('concurrent proposals keep unique versions and cannot overwrite an intervening approval', async () => {
  for (const boundary of ['classification', 'lessons']) {
    const app = await completed();
    app.adapters.classifier = classifier('okay');
    const before = latestPlan(app, 'FW-001')!.version;
    const rows = await Promise.all([proposePlan(app, app.store.getCase('FW-001')!, 'U_MGR_DANA'), proposePlan(app, app.store.getCase('FW-001')!, 'U_MGR_DANA')]);
    assert.deepEqual(rows.map((r) => r.version).sort(), [before + 1, before + 2]);
    const gated = classifier('expert');
    let release!: () => void;
    let entered!: () => void;
    const waiting = new Promise<void>((resolve) => entered = resolve);
    if (boundary === 'classification') {
      gated.identity = async () => { entered(); await new Promise<void>((resolve) => release = resolve); return { model_version: 'b'.repeat(64), schema_version: 'readiness-p0-v1', synthetic_only: true }; };
      app.adapters.classifier = gated;
    } else {
      const complete = app.adapters.llm.complete.bind(app.adapters.llm);
      app.adapters.llm.complete = async (...args) => { entered(); await new Promise<void>((resolve) => release = resolve); return complete(...args); };
    }
    const pending = proposePlan(app, app.store.getCase('FW-001')!, 'U_MGR_DANA', { add: ['APP-115'], remove: [], resolved: {} });
    await waiting;
    await approvePlan(app, app.store.getCase('FW-001')!, before + 2, 'U_MGR_DANA');
    release();
    await assert.rejects(pending, /already plan_approved/);
    assert.equal(app.store.getCase('FW-001')!.status, 'plan_approved');
    app.close();
  }
});
