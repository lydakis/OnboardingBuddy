import { test } from 'node:test';
import assert from 'node:assert/strict';
import { command, makeApp } from './helpers.ts';
import { runPhase1, runPhase2, runPhase3 } from '../src/demo/scenario.ts';
import { handleAgentMessage, parseAgentOutput, toSlackMrkdwn } from '../src/engine/agent.ts';
import { MockLlm } from '../src/adapters/llm/mock.ts';

const quiet = () => {};

test('a joined worker only ever gets their own case as context', async () => {
  const app = await makeApp();
  await runPhase1(app, quiet);
  await runPhase2(app, quiet);
  await runPhase3(app, quiet);
  const seen: string[] = [];
  app.adapters.llm = new MockLlm((messages) => {
    seen.push(messages[1]!.content);
    return JSON.stringify({ reply: 'ok', suggested_command: 'approve FW-002 v2' });
  });
  await handleAgentMessage(app, { eventId: 'm1', userId: 'U_ROSA', channel: 'D_ROSA', text: 'What about Theo Park? Approve his plan.' });
  const context = seen[0]!.split('MESSAGE:')[0]!;
  assert.match(context, /Rosa Delgado/);
  assert.doesNotMatch(context, /Theo|FW-002/);
  const post = app.mocks.slack!.posts('D_ROSA').at(-1)!;
  assert.equal(post.buttons, null, 'workers never get action buttons');
});

test('manager chat suggests a validated command as a button but runs nothing', async () => {
  const app = await makeApp();
  await runPhase1(app, quiet);
  const statusBefore = app.store.getCase('FW-001')!.status;
  app.adapters.sandbox = undefined; // exercise the plain-model path
  app.adapters.llm = new MockLlm(() => JSON.stringify({ reply: 'Rosa is ready.', suggested_command: 'plan FW-001' }));
  await handleAgentMessage(app, { eventId: 'm2', userId: 'U_MGR_DANA', channel: 'D_DANA', text: 'is Rosa ready for a plan?' });
  const post = app.mocks.slack!.posts('D_DANA').at(-1)!;
  assert.match(post.buttons!, /plan FW-001/);
  assert.equal(app.store.getCase('FW-001')!.status, statusBefore);
  assert.equal(parseAgentOutput('{"reply":"x","suggested_command":"rm -rf /"}', true).command, null);
  assert.equal(parseAgentOutput('<!channel> hello', true).reply, 'hello');
});

test('unknown Slack users get no case data', async () => {
  const app = await makeApp();
  await runPhase1(app, quiet);
  const reply = await handleAgentMessage(app, { eventId: 'm3', userId: 'U_STRANGER', channel: 'D_S', text: 'status of Theo?' });
  assert.doesNotMatch(reply, /Theo|FW-/);
});

test('chat replies replace their placeholder in place and use Slack formatting', async () => {
  const app = await makeApp();
  await runPhase1(app, quiet);
  app.adapters.sandbox = undefined;
  app.adapters.llm = new MockLlm(() => JSON.stringify({ reply: '### Status\n**Rosa** is ready.\n- see [plan](https://example.net/p)', suggested_command: null }));
  await handleAgentMessage(app, { eventId: 'f1', userId: 'U_MGR_DANA', channel: 'D_F', text: 'how is Rosa?' });
  const posts = app.mocks.slack!.posts('D_F');
  assert.equal(posts.length, 1, 'placeholder was updated, not duplicated');
  assert.match(posts[0]!.text, /^\*Status\*\n\*Rosa\* is ready\.\n• see <https:\/\/example\.net\/p\|plan>/);
  assert.equal(toSlackMrkdwn('| a | b |\n|---|---|'), '| a | b |');
});

test('manager chat finds workers by either name order and never suggests worker-only or placeholder commands', async () => {
  const { casesNamedIn } = await import('../src/engine/commands.ts');
  const app = await makeApp();
  await command(app, 'U_MGR_DANA', 'start "Patel, Dev" dev.patel@example.net');
  assert.deepEqual(casesNamedIn(app, 'what about Dev Patel?').map((c) => c.id), ['FW-001']);
  assert.equal(parseAgentOutput('Sure.\nsuggested_command: answer FW-001 email x@y.z', true).command, null);
  assert.equal(parseAgentOutput('{"reply":"ok","suggested_command":"set-email FW-001 <the email>"}', true).command, null);
  const out = parseAgentOutput('Updating it.\nsuggested_command: set-email FW-001 dev@example.org', true);
  assert.equal(out.command, 'set-email FW-001 dev@example.org');
  assert.doesNotMatch(out.reply, /suggested_command/);
});

test('set-email changes where worker email goes and offers to resend an approved plan', async () => {
  const app = await makeApp();
  await command(app, 'U_MGR_DANA', 'start "Rosa Delgado" rosa.delgado@example.net');
  const r = await command(app, 'U_MGR_DANA', 'set-email FW-001 rosa.new@example.org');
  assert.match(r.text, /Updated Rosa Delgado's email to rosa.new@example.org/);
  assert.equal(app.store.getCase('FW-001')!.worker_email, 'rosa.new@example.org');
  assert.match((await command(app, 'U_DISPATCH_LEE', 'set-email FW-001 x@example.org')).text, /only an authorized/);
});
