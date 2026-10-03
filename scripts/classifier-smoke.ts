// Real CatBoost over GB10 loopback, isolated in-memory app and mock communications.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { createApp } from '../src/app.ts';
import { loadConfig } from '../src/config.ts';
import { loadPolicy, unresolvedBlocking } from '../src/engine/policy.ts';
import { proposePlan, planContent, latestPlan, approvePlan, sendApprovedPlan } from '../src/engine/plan.ts';
import { now } from '../src/db/store.ts';
import { handleSlackCommand } from '../src/engine/commands.ts';
import { startStatusServer } from '../src/server/status.ts';
import { decodeTrainingUrl } from '../src/engine/training-link.ts';

const app = await createApp(loadConfig({ OB_DB_PATH: ':memory:', OB_MANAGER_SLACK_IDS: 'U_SMOKE',
  OB_CLASSIFIER_MODE: 'demo', OB_CLASSIFIER_URL: process.env.OB_CLASSIFIER_URL ?? 'http://127.0.0.1:4610', OB_STATUS_PORT: '0' }));
const path = process.argv[2];
if (!path) throw new Error('Usage: classifier-smoke.ts <GB10-generated snapshots.jsonl>');
const records = readFileSync(path, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
const tracks = { beginner: 'foundations', okay: 'intermediate', expert: 'experienced' } as const;
const seen = new Set<string>();
const results: unknown[] = [];
const trainingPage = readFileSync(new URL('../site/training/index.html', import.meta.url), 'utf8');
const browserDecoder = trainingPage.slice(trainingPage.indexOf('function cleanLessons('), trainingPage.indexOf('\nvar P,SAMPLE'));
let seq = 0;
const server = await startStatusServer(app);
try {
  for (const record of records) {
    const prediction = await app.adapters.classifier!.predict(record.json);
    if (seen.has(prediction.label) || prediction.missing_fields.length || prediction.probabilities[prediction.label] < 0.65) continue;
    const license = record.json.asked.find((i: { field: string }) => i.field === 'license_class')?.value ?? record.json.cv.find((i: { field: string }) => i.field === 'license_class')?.value;
    if (!license || license === 'none') continue;
    const id = `SMOKE-${prediction.label.toUpperCase()}`;
    app.store.insertCase({ id, worker_name: `Synthetic ${prediction.label}`, worker_email: `${prediction.label}@example.net`, manager_slack_id: 'U_SMOKE', status: 'questionnaire_complete' });
    const workerSlackId = `U_SMOKE_${prediction.label}`;
    app.store.db.prepare('UPDATE cases SET slack_user_id = ? WHERE id = ?').run(workerSlackId, id);
    app.store.db.prepare('INSERT INTO feature_snapshots (case_id, version, policy_id, reason, json, created_at) VALUES (?, 1, ?, ?, ?, ?)').run(id, loadPolicy().policyId, 'questionnaire_complete', JSON.stringify(record.json), now());
    app.store.db.prepare("INSERT INTO extractions (id, case_id, kind, model, status, output_json, created_at) VALUES (?, ?, 'experience', 'fixture', 'accepted', '[]', ?)").run(`ext-${id}`, id, now());
    const first = await proposePlan(app, app.store.getCase(id)!, 'U_SMOKE');
    const plan = planContent(first);
    assert.equal(plan.readiness?.status, 'ok');
    assert.equal(plan.readiness?.label, prediction.label);
    assert.equal(plan.track.id, tracks[prediction.label]);
    assert.ok(plan.modules.some((m) => m.id === 'SAFE-101'));
    if (first.status === 'needs_review') await handleSlackCommand(app, { eventId: `smoke-${seq++}`, userId: 'U_SMOKE', channel: 'U_SMOKE', text: `revise ${id} resolve=all "Reviewed synthetic smoke fixture"` });
    const latest = latestPlan(app, id)!;
    assert.deepEqual(unresolvedBlocking(planContent(latest)), []);
    await approvePlan(app, app.store.getCase(id)!, latest.version, 'U_SMOKE');
    await sendApprovedPlan(app, app.store.getCase(id)!, latest.version);
    assert.equal(app.mocks.email!.sent(`${prediction.label}@example.net`).length, 0);
    const posts = app.mocks.slack!.posts(workerSlackId);
    assert.equal(posts.filter(p => p.text.includes('approved your two-week training plan')).length, 1);
    const links = posts.filter(p => p.text.includes('Start your interactive training'));
    assert.equal(links.length, 1);
    const url = links[0]!.text.match(/<(https:[^|>]+)\|Start your interactive training>/)![1]!;
    const payload = decodeTrainingUrl(url);
    const browserPlan = runInNewContext(`${browserDecoder}\ndecode(input)`, { input: JSON.stringify(payload) });
    assert.equal(browserPlan.t, tracks[prediction.label]);
    assert.equal(browserPlan.tl, plan.track.label);
    assert.deepEqual(Array.from(browserPlan.d, (d: any) => d[2]), payload.d.map(d => d[2]));
    assert.equal((app.store.db.prepare('SELECT COUNT(*) AS n FROM readiness_predictions WHERE case_id = ?').get(id) as { n: number }).n, 1);
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const html = await (await fetch(`http://127.0.0.1:${address.port}/case/${id}`)).text();
    assert.match(html, /Readiness recommendation/);
    results.push({ label: prediction.label, track: plan.track.id, planStatus: app.store.getCase(id)!.status, modelVersion: plan.readiness?.model_version, snapshotVersion: plan.readiness?.snapshotVersion });
    seen.add(prediction.label);
    if (seen.size === 3) break;
  }
  assert.equal(seen.size, 3, 'Every tier must complete the real classifier → plan → approval flow');
  console.log(JSON.stringify({ communications: 'mock only', inference: 'GB10 loopback', results }, null, 2));
} finally {
  server.close();
  app.close();
}
