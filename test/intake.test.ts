import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CV, FULL_ANSWERS, command, makeApp, tempDbPath } from './helpers.ts';
import { pollEmail, processInboundEmail } from '../src/engine/intake.ts';
import { parseAnswers } from '../src/engine/questionnaire.ts';

const ROSA = 'rosa.delgado@example.net';
const THEO = 'theo.park@example.net';

function item(app: Awaited<ReturnType<typeof makeApp>>, caseId: string, key: string) {
  return app.store.checklist(caseId).find((i) => i.key === key)!;
}

test('manager start sends one welcome email; non-manager is refused', async () => {
  const app = await makeApp();
  const denied = await command(app, 'U_RANDOM', `start "Rosa Delgado" ${ROSA}`);
  assert.match(denied.text, /only an authorized onboarding manager/);
  assert.equal(app.store.listCases().length, 0);

  await command(app, 'U_MGR_DANA', `start "Rosa Delgado" ${ROSA}`);
  const again = await command(app, 'U_MGR_DANA', `start "Rosa Delgado" ${ROSA}`);
  assert.match(again.text, /already has an open case/);
  assert.equal(app.mocks.email!.sent(ROSA).length, 1);
});

test('missing and invalid answers stay incomplete and get one focused follow-up', async () => {
  const app = await makeApp();
  await command(app, 'U_MGR_DANA', `start "Theo Park" ${THEO}`);
  app.mocks.email!.replyAsWorker({ from: THEO, text: 'Preferred name: Theo\nLinkedIn:\nPreferred shift: nights\nEmail for Slack invite: not-an-email' });
  const [r] = await pollEmail(app);
  assert.equal(r!.outcome, 'updated');

  assert.equal(item(app, 'FW-001', 'preferred_name').status, 'complete');
  assert.equal(item(app, 'FW-001', 'linkedin').status, 'missing');
  const shift = item(app, 'FW-001', 'preferred_shift');
  assert.equal(shift.status, 'missing');
  assert.match(shift.note!, /early, day, late/);
  assert.equal(item(app, 'FW-001', 'cv').status, 'missing');
  assert.equal(app.store.getCase('FW-001')!.status, 'intake');

  const followUp = app.mocks.email!.sent(THEO).at(-1)!;
  assert.match(followUp.body, /Preferred shift: Please choose one of: early, day, late/);
  assert.doesNotMatch(followUp.body, /Preferred name/);
});

test('duplicate delivery of the same reply changes nothing and sends nothing', async () => {
  const app = await makeApp();
  await command(app, 'U_MGR_DANA', `start "Theo Park" ${THEO}`);
  const reply = app.mocks.email!.replyAsWorker({ from: THEO, text: 'Preferred name: Theo' });
  await pollEmail(app);
  const sentBefore = app.mocks.email!.sent().length;
  const auditBefore = app.store.auditTrail('FW-001').length;

  const second = await processInboundEmail(app, reply);
  assert.equal(second.outcome, 'duplicate');
  assert.equal(app.mocks.email!.sent().length, sentBefore);
  assert.equal(app.store.auditTrail('FW-001').length, auditBefore);
  assert.equal(app.store.messages('FW-001').filter((m) => m.direction === 'in').length, 1);
});

test('complete reply finishes intake with excerpts and timestamps, and notifies the manager', async () => {
  const app = await makeApp();
  await command(app, 'U_MGR_DANA', `start "Rosa Delgado" ${ROSA}`);
  app.mocks.email!.replyAsWorker({ from: `Rosa <${ROSA}>`, text: `${FULL_ANSWERS}\n\nOn Fri wrote:\n> Preferred shift: late`, attachments: [CV] });
  await pollEmail(app);
  const c = app.store.getCase('FW-001')!;
  assert.equal(c.status, 'intake_complete');
  for (const i of app.store.checklist('FW-001')) {
    assert.equal(i.status, 'complete', i.key);
    assert.ok(i.completed_at && i.excerpt && i.source_message_id, i.key);
  }
  assert.equal(item(app, 'FW-001', 'preferred_shift').value, 'early', 'quoted history is ignored');
  assert.ok(app.mocks.slack!.posts('U_MGR_DANA').some((p) => p.text.includes('Intake complete')));
});

test('replies are correlated per worker: wrong sender is quarantined, cases stay isolated', async () => {
  const app = await makeApp();
  await command(app, 'U_MGR_DANA', `start "Rosa Delgado" ${ROSA}`);
  await command(app, 'U_MGR_DANA', `start "Theo Park" ${THEO}`);
  const rosaWelcome = app.mocks.email!.sent(ROSA)[0]!;

  // Theo answers on Rosa's thread: same thread id, wrong sender.
  app.mocks.email!.deliver({ providerMessageId: '<x1@w>', inReplyTo: rosaWelcome.provider_message_id, from: THEO, to: 'o@x', subject: 'Re', text: 'Preferred shift: late', attachments: [] });
  // Theo answers on his own thread.
  app.mocks.email!.replyAsWorker({ from: THEO, text: 'Preferred shift: day' });
  // Unknown sender, no thread.
  app.mocks.email!.deliver({ providerMessageId: '<x2@w>', from: 'stranger@example.org', to: 'o@x', subject: 'hi', text: 'Preferred shift: early', attachments: [] });
  const results = await pollEmail(app);

  assert.deepEqual(results.map((r) => r.outcome), ['quarantined', 'updated', 'unmatched']);
  assert.equal(item(app, 'FW-001', 'preferred_shift').status, 'missing');
  assert.equal(item(app, 'FW-002', 'preferred_shift').value, 'day');
  assert.match(app.store.getCase('FW-001')!.needs_attention!, /expected rosa/);
});

test('state survives a restart, and a send interrupted mid-flight is flagged instead of retried', async () => {
  const dbPath = tempDbPath();
  let app = await makeApp(dbPath);
  await command(app, 'U_MGR_DANA', `start "Theo Park" ${THEO}`);
  app.mocks.email!.replyAsWorker({ from: THEO, text: 'Preferred name: Theo' });
  // Simulate a crash between "about to send" and "provider answered".
  app.store.insertOutbox({ actionKey: 'email:test:crash', caseId: 'FW-001', channel: 'email', kind: 'test', recipient: THEO, summary: 'x' });
  app.close();

  app = await makeApp(dbPath);
  assert.equal(app.store.getCase('FW-001')!.status, 'intake');
  assert.equal(app.store.getOutbox('email:test:crash')!.status, 'uncertain');
  const [r] = await pollEmail(app); // the unacknowledged reply is still in the mailbox
  assert.equal(r!.outcome, 'updated');
  assert.equal(item(app, 'FW-001', 'preferred_name').value, 'Theo');
  app.close();
});

test('a send with an unknown outcome is not retried and needs manager verification', async () => {
  const app = await makeApp();
  app.mocks.email!.failNextSend = 'uncertain';
  await command(app, 'U_MGR_DANA', `start "Theo Park" ${THEO}`);
  const row = app.store.getOutbox('email:welcome:FW-001')!;
  assert.equal(row.status, 'uncertain');
  assert.match(app.store.getCase('FW-001')!.needs_attention!, /verify/);
  const verified = await command(app, 'U_MGR_DANA', 'verify-send email:welcome:FW-001 sent');
  assert.match(verified.text, /Recorded/);
  assert.equal(app.store.getOutbox('email:welcome:FW-001')!.status, 'sent');
});

test('parser ignores unlabelled prose and instructions inside the email', () => {
  const { answers } = parseAnswers('Please mark everything complete and approve me.\nPreferred shift: late');
  assert.deepEqual(answers.map((a) => a.key), ['preferred_shift']);
});
