import { test } from 'node:test';
import assert from 'node:assert/strict';
import { command, makeApp } from './helpers.ts';
import { runPhase1 } from '../src/demo/scenario.ts';
import { getInvitation, handleTeamJoin } from '../src/engine/join.ts';
import { ManualInviteAdapter } from '../src/adapters/invite/manual.ts';
import type { InviteAdapter } from '../src/types.ts';

const quiet = () => {};
/** Intake done for Rosa (FW-001) and Theo (FW-002); nobody invited yet. */
async function plansSent() {
  const app = await makeApp();
  await runPhase1(app, quiet);
  return app;
}
const ROSA = 'rosa.delgado@example.net';

test('an invitation is never membership: joined only after team_join with the invited email', async () => {
  const app = await plansSent();
  await command(app, 'U_MGR_DANA', 'invite FW-001');
  assert.equal(getInvitation(app, 'FW-001')!.state, 'sent');
  assert.equal(app.store.getCase('FW-001')!.status, 'slack_invited');
  assert.equal(app.store.getCase('FW-001')!.slack_user_id, null);
  assert.equal(app.mocks.slack!.posts(app.config.newHireChannel).length, 0, 'no welcome before membership');

  app.mocks.slack!.addUser({ id: 'U_ROSA', email: ROSA });
  await handleTeamJoin(app, { eventId: 'E1', user: { id: 'U_ROSA', email: 'Rosa.Delgado@example.net' } });
  assert.equal(getInvitation(app, 'FW-001')!.state, 'membership_confirmed');
  assert.equal(app.store.getCase('FW-001')!.slack_user_id, 'U_ROSA');
  assert.deepEqual(app.mocks.slack!.channelMembers(app.config.newHireChannel), ['U_ROSA']);

  const before = app.mocks.slack!.posts().length;
  assert.equal(await handleTeamJoin(app, { eventId: 'E1', user: { id: 'U_ROSA', email: ROSA } }), 'duplicate');
  assert.equal(app.mocks.slack!.posts().length, before);
});

test('ambiguous identity goes to manager review and links nobody until confirmed', async () => {
  const app = await plansSent();
  await command(app, 'U_MGR_DANA', 'clear FW-002 "checked"');
  await command(app, 'U_MGR_DANA', 'invite FW-002');
  app.mocks.slack!.addUser({ id: 'U_T', email: 'other@example.org', realName: 'Theo' });
  assert.equal(await handleTeamJoin(app, { eventId: 'E2', user: { id: 'U_T', email: 'other@example.org', realName: 'Theo' } }), 'needs_review');
  assert.equal(getInvitation(app, 'FW-002')!.state, 'needs_review');
  assert.equal(app.store.getCase('FW-002')!.slack_user_id, null);

  assert.match((await command(app, 'U_DISPATCH_LEE', 'link FW-002 U_T')).text, /only an authorized/);
  await command(app, 'U_MGR_DANA', 'link FW-002 U_T');
  assert.equal(app.store.getCase('FW-002')!.slack_user_id, 'U_T');
});

test('readiness checks and manager approval gate the invite', async () => {
  const app = await makeApp();
  await runPhase1(app, quiet);
  await command(app, 'U_MGR_DANA', 'start "Sam Rivera" sam.rivera@example.net');
  assert.match((await command(app, 'U_MGR_DANA', 'invite FW-003')).text, /intake checklist is not complete/);
  assert.match((await command(app, 'U_DISPATCH_LEE', 'invite FW-001')).text, /only an authorized/);
  assert.equal(getInvitation(app, 'FW-001'), undefined);
  assert.equal(getInvitation(app, 'FW-003'), undefined);
});

test('unsupported or failing invite capability falls back to manual without breaking earlier phases', async () => {
  for (const adapter of [new ManualInviteAdapter(), { mode: 'broken', capability: () => ({ automated: true, method: 'slack-admin-api', explanation: '' }), inviteToWorkspace: async () => { throw new Error('not_allowed_token_type'); } } as InviteAdapter]) {
    const app = await plansSent();
    app.adapters.invite = adapter;
    const reply = await command(app, 'U_MGR_DANA', 'invite FW-001');
    assert.match(reply.text, /invite-sent FW-001/);
    assert.equal(app.store.getCase('FW-001')!.status, 'intake_complete', 'earlier state untouched');
    assert.match((await command(app, 'U_MGR_DANA', 'status FW-001')).text, /intake_complete/);

    await command(app, 'U_MGR_DANA', 'invite-sent FW-001');
    assert.equal(getInvitation(app, 'FW-001')!.state, 'sent');
    assert.equal(app.store.getCase('FW-001')!.slack_user_id, null);
    app.mocks.slack!.addUser({ id: 'U_ROSA', email: ROSA });
    assert.match((await command(app, 'U_MGR_DANA', 'verify-join FW-001')).text, /Confirmed/);
    assert.equal(app.store.getCase('FW-001')!.status, 'questionnaire', 'joining starts the Slack questions');
  }
});

test('live connectors refuse recipients that are not on the allowlist', async () => {
  const app = await makeApp();
  const sent: string[] = [];
  app.adapters.email = { mode: 'agentmail', send: async (m) => { sent.push(m.to); return { providerMessageId: '<p1>', threadId: 't1' }; }, poll: async () => [], acknowledge: async () => {}, requeue: async () => {} };
  app.config.liveRecipientAllowlist = ['rosa+demo@example.net'];
  await command(app, 'U_MGR_DANA', 'start "Real Person" someone.real@example.com');
  await command(app, 'U_MGR_DANA', 'start "Rosa" rosa+demo@example.net');
  assert.deepEqual(sent, ['rosa+demo@example.net']);
  assert.equal(app.store.getOutbox('email:welcome:FW-001')!.status, 'failed');
});

test('an Enterprise-invited account that has not joined yet is never treated as a member', async () => {
  const app = await makeApp();
  await runPhase1(app, quiet);
  await command(app, 'U_MGR_DANA', 'invite FW-001');
  // Slack pre-creates the invited user; lookupByEmail finds it before they join.
  app.adapters.slack.lookupUserByEmail = async () => ({ id: 'U_PENDING', email: ROSA, invited: true });
  assert.match((await command(app, 'U_MGR_DANA', 'verify-join FW-001')).text, /hasn't finished joining/);
  assert.equal(await handleTeamJoin(app, { eventId: 'E9', user: { id: 'U_PENDING', email: ROSA, invited: true } }), 'still only invited');
  assert.equal(app.store.getCase('FW-001')!.slack_user_id, null);
  assert.equal(getInvitation(app, 'FW-001')!.state, 'sent');

  const { checkPendingJoins } = await import('../src/engine/join.ts');
  assert.deepEqual(await checkPendingJoins(app), [], 'still invited: nothing confirmed');
  app.adapters.slack.lookupUserByEmail = async () => ({ id: 'U_PENDING', email: ROSA, invited: false });
  assert.deepEqual(await checkPendingJoins(app), ['FW-001']);
  assert.equal(app.store.getCase('FW-001')!.status, 'questionnaire');
});
