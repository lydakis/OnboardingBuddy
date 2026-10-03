import { test } from 'node:test';
import assert from 'node:assert/strict';
import { command, makeApp } from './helpers.ts';
import { runPhase1, runPhase2 } from '../src/demo/scenario.ts';
import { handleTeamJoin } from '../src/engine/join.ts';
import { handleAgentMessage } from '../src/engine/agent.ts';
import { items, parseDelivery, parseEquipment } from '../src/engine/slack-questionnaire.ts';
import { latestPlan, planContent, proposePlan } from '../src/engine/plan.ts';

const quiet = () => {};

async function rosaJoined() {
  const app = await makeApp();
  await runPhase1(app, quiet);
  await command(app, 'U_MGR_DANA', 'invite FW-001');
  app.mocks.slack!.addUser({ id: 'U_ROSA', email: 'rosa.delgado@example.net' });
  await handleTeamJoin(app, { eventId: 'J1', user: { id: 'U_ROSA', email: 'rosa.delgado@example.net' } });
  return app;
}

test('questions are tailored from the CV: Rosa gets 6, Theo gets 7', async () => {
  const app = await makeApp();
  await runPhase1(app, quiet);
  assert.deepEqual(items(app, 'FW-001').map((i) => i.field), ['delivery', 'route_type', 'delivery_app', 'area_familiarity', 'preferred_shift', 'confidence']);
  assert.equal(items(app, 'FW-001')[0]!.kind, 'confirm');
  assert.match(items(app, 'FW-001')[0]!.prompt, /about 5 years on parcel routes \(Coastline Parcel Co\. \(fictional\)\)/);
  assert.deepEqual(items(app, 'FW-002').map((i) => i.field), ['delivery', 'largest_vehicle', 'equipment', 'delivery_app', 'area_familiarity', 'preferred_shift', 'confidence']);
  assert.equal(items(app, 'FW-002')[0]!.kind, 'number_text');
});

test('joining starts the questions; only the worker can answer and a repeated tap is a no-op', async () => {
  const app = await rosaJoined();
  assert.equal(app.store.getCase('FW-001')!.status, 'questionnaire');
  assert.match(app.mocks.slack!.posts('U_ROSA').at(-1)!.text, /Question 1 of 6/);

  assert.match((await command(app, 'U_MGR_DANA', 'answer FW-001 delivery yes')).text, /Only Rosa Delgado can answer/);
  await command(app, 'U_ROSA', 'answer FW-001 delivery yes');
  const posts = app.mocks.slack!.posts('U_ROSA').length;
  assert.match((await command(app, 'U_ROSA', 'answer FW-001 delivery yes')).text, /Already recorded/);
  assert.equal(app.mocks.slack!.posts('U_ROSA').length, posts + 1, 'only the "Already recorded" notice');
  assert.match(app.mocks.slack!.posts('U_ROSA').at(-2)!.text, /Question 2 of 6/);
});

test('typed answers: delivery parsing, equipment synonyms, the "nights" nudge, and side questions', async () => {
  assert.deepEqual(parseDelivery('about 2 years delivering food by bike'), { years: 2, kind: 'other' });
  assert.deepEqual(parseDelivery('6 months of parcel routes'), { years: 0.5, kind: 'parcel' });
  assert.equal(parseDelivery('none'), 'none');
  assert.equal(parseDelivery('some food delivery'), null);
  assert.deepEqual(parseEquipment('none really, just a dolly and a scanner'), ['handheld scanner', 'hand truck']);

  const app = await rosaJoined();
  for (const [f, v] of [['delivery', 'yes'], ['route_type', 'mixed'], ['delivery_app', 'yes'], ['area_familiarity', 'somewhat']]) await command(app, 'U_ROSA', `answer FW-001 ${f} ${v}`);
  await handleAgentMessage(app, { eventId: 'n1', userId: 'U_ROSA', channel: 'D_ROSA', text: 'nights if possible' });
  const nudge = app.mocks.slack!.posts('U_ROSA').at(-1)!;
  assert.match(nudge.text, /don't run overnight/);
  assert.match(nudge.buttons!, /^\[\{"text":"Late · 13:00"/);

  await handleAgentMessage(app, { eventId: 's1', userId: 'U_ROSA', channel: 'D_ROSA', text: 'when is payday?' });
  assert.match(app.mocks.slack!.posts('U_ROSA').at(-1)!.text, /Question 5 of 6/, 'side question answered, then the current question again');
  await handleAgentMessage(app, { eventId: 's2', userId: 'U_ROSA', channel: 'D_ROSA', text: 'early please' });
  assert.equal(items(app, 'FW-001').find((i) => i.field === 'preferred_shift')!.answer_value_json, '"early"');
});

test('answers feed the plan: Theo is blocked on conflicting experience, Rosa is Experienced with a shorter scanner module', async () => {
  const app = await makeApp();
  await runPhase1(app, quiet);
  await runPhase2(app, quiet);
  assert.equal(app.store.getCase('FW-001')!.status, 'questionnaire_complete');
  assert.ok(app.store.db.prepare(`SELECT 1 FROM feature_snapshots WHERE case_id = 'FW-002'`).get());

  const theo = planContent(await proposePlan(app, app.store.getCase('FW-002')!, 'U_MGR_DANA'));
  assert.ok(theo.reviewItems.some((r) => r.id === 'experience-conflict' && r.blocking));
  assert.equal(theo.rideAlongStart?.time, '13:00');
  assert.equal(latestPlan(app, 'FW-002')!.status, 'needs_review');

  const rosa = planContent(await proposePlan(app, app.store.getCase('FW-001')!, 'U_MGR_DANA'));
  assert.equal(rosa.track.id, 'experienced');
  assert.equal(rosa.modules.find((m) => m.id === 'SCAN-120')!.hours, 0.5);
  await command(app, 'U_MGR_DANA', 'approve FW-001 v1');
  assert.match(app.mocks.slack!.posts('U_ROSA').at(-1)!.text, /approved your two-week plan[\s\S]*06:00/);
});
