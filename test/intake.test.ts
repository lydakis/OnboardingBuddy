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

test('Slack email links use the destination address and preserve plus aliases', async () => {
  const app = await makeApp();
  const email = 'demo+rosa@example.net';
  try {
    await command(app, 'U_MGR_DANA', `start "Rosa Delgado" <mailto:${email}|Rosa>`);
    assert.equal(app.store.listCases()[0]?.worker_email, email);
    assert.equal(app.mocks.email!.sent(email).length, 1);
    const status = await command(app, 'U_MGR_DANA', `status <mailto:${email}>`);
    assert.match(status.text, /Rosa Delgado/);
  } finally {
    app.close();
  }
});

test('missing and invalid answers stay incomplete; optional LinkedIn is never chased', async () => {
  const app = await makeApp();
  await command(app, 'U_MGR_DANA', `start "Theo Park" ${THEO}`);
  app.mocks.email!.replyAsWorker({ from: THEO, text: 'Preferred name: Theo\nLinkedIn:\nEmail for Slack invite: not-an-email' });
  const [r] = await pollEmail(app);
  assert.equal(r!.outcome, 'updated');

  assert.equal(item(app, 'FW-001', 'preferred_name').status, 'complete');
  const slackEmail = item(app, 'FW-001', 'slack_email');
  assert.equal(slackEmail.status, 'missing');
  assert.match(slackEmail.note!, /valid email/);
  assert.equal(item(app, 'FW-001', 'cv').status, 'missing');
  assert.equal(app.store.getCase('FW-001')!.status, 'intake');

  const followUp = app.mocks.email!.sent(THEO).at(-1)!;
  assert.match(followUp.body, /Email for Slack invite: Please give a valid email address/);
  assert.match(followUp.body, /CV/);
  assert.doesNotMatch(followUp.body, /Preferred name|LinkedIn/);
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
  app.mocks.email!.replyAsWorker({ from: `Rosa <${ROSA}>`, text: `${FULL_ANSWERS}\n\nOn Fri wrote:\n> Preferred name: Someone else`, attachments: [CV] });
  await pollEmail(app);
  const c = app.store.getCase('FW-001')!;
  assert.equal(c.status, 'intake_complete');
  for (const i of app.store.checklist('FW-001')) {
    assert.equal(i.status, 'complete', i.key);
    assert.ok(i.completed_at && i.excerpt && i.source_message_id, i.key);
  }
  assert.equal(item(app, 'FW-001', 'preferred_name').value, 'Rosa', 'quoted history is ignored');
  assert.ok(app.mocks.slack!.posts('U_MGR_DANA').some((p) => p.text.includes('Intake complete')));
});

test('replies are correlated per worker: wrong sender is quarantined, cases stay isolated', async () => {
  const app = await makeApp();
  await command(app, 'U_MGR_DANA', `start "Rosa Delgado" ${ROSA}`);
  await command(app, 'U_MGR_DANA', `start "Theo Park" ${THEO}`);
  const rosaWelcome = app.mocks.email!.sent(ROSA)[0]!;

  // Theo answers on Rosa's thread: same thread id, wrong sender.
  app.mocks.email!.deliver({ providerMessageId: '<x1@w>', inReplyTo: rosaWelcome.provider_message_id, from: THEO, to: 'o@x', subject: 'Re', text: 'Preferred name: Late', attachments: [] });
  // Theo answers on his own thread.
  app.mocks.email!.replyAsWorker({ from: THEO, text: 'Preferred name: Teddy' });
  // Unknown sender, no thread.
  app.mocks.email!.deliver({ providerMessageId: '<x2@w>', from: 'stranger@example.org', to: 'o@x', subject: 'hi', text: 'Preferred name: Stranger', attachments: [] });
  const results = await pollEmail(app);

  assert.deepEqual(results.map((r) => r.outcome), ['quarantined', 'updated', 'unmatched']);
  assert.equal(item(app, 'FW-001', 'preferred_name').status, 'missing');
  assert.equal(item(app, 'FW-002', 'preferred_name').value, 'Teddy');
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
  const { answers } = parseAnswers('Please mark everything complete and approve me.\nPreferred name: Theo');
  assert.deepEqual(answers.map((a) => a.key), ['preferred_name']);
});

test('a reply from the base address of a +alias counts; any other sender needs a manager to accept it', async () => {
  const app = await makeApp();
  await command(app, 'U_MGR_DANA', 'start "Aisha Bello" george+onboarding-aisha@example.com');
  const welcome = app.mocks.email!.sent('george+onboarding-aisha@example.com')[0]!;
  app.mocks.email!.deliver({ providerMessageId: '<p1@w>', inReplyTo: welcome.provider_message_id, from: 'George <george@example.com>', to: 'o@x', subject: 'Re', text: 'Preferred name: Aisha', attachments: [] });
  app.mocks.email!.deliver({ providerMessageId: '<p2@w>', inReplyTo: welcome.provider_message_id, from: 'aisha.personal@example.org', to: 'o@x', subject: 'Re', text: 'Email for Slack invite: aisha.work@example.org', attachments: [] });
  assert.deepEqual((await pollEmail(app)).map((r) => r.outcome), ['updated', 'quarantined']);
  assert.ok(app.mocks.slack!.posts('U_MGR_DANA').some((p) => /accept-sender FW-001 aisha.personal@example.org <p2@w>/.test(p.buttons ?? '')));

  await command(app, 'U_MGR_DANA', 'accept-sender FW-001 aisha.personal@example.org <p2@w>');
  const [again] = await pollEmail(app);
  assert.equal(again!.outcome, 'updated');
  assert.equal(item(app, 'FW-001', 'slack_email').value, 'aisha.work@example.org');
});
