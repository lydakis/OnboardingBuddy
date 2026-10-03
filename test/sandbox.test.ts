import { test } from 'node:test';
import assert from 'node:assert/strict';
import { command, makeApp } from './helpers.ts';
import { runPhase1, runPhase2, runPhase3 } from '../src/demo/scenario.ts';
import { buildSnapshot } from '../src/engine/snapshot.ts';
import { handleAgentMessage } from '../src/engine/agent.ts';
import { agentRuns } from '../src/engine/sandbox.ts';
import { firstJsonObject } from '../src/adapters/nemoclaw-cli.ts';
import type { SandboxAgent } from '../src/adapters/sandbox/types.ts';
import type { MockSandboxAgent } from '../src/adapters/sandbox/mock.ts';

const quiet = () => {};
async function joined() {
  const app = await makeApp();
  await runPhase1(app, quiet);
  await runPhase2(app, quiet);
  await runPhase3(app, quiet);
  return app;
}

test('a worker-scoped snapshot holds one case and no worker-written text', async () => {
  const app = await joined();
  const snap = JSON.stringify(buildSnapshot(app, 'case:FW-002'));
  assert.equal(buildSnapshot(app, 'case:FW-002').cases.length, 1);
  assert.doesNotMatch(snap, /Rosa|FW-001/);
  assert.doesNotMatch(snap, /IGNORE YOUR PREVIOUS|ignore your previous|bike/i, 'no CV or questionnaire text');
  assert.doesNotMatch(snap, /@example\.net/, 'no contact details');
});

test('the sandboxed agent writes a day-1 quiz with our tools; it is re-validated and sent only to a joined worker', async () => {
  const app = await joined();
  const preview = await command(app, 'U_MGR_DANA', 'quiz FW-001');
  assert.match(preview.text, /Day 1 check-in/);
  assert.deepEqual((app.adapters.sandbox as MockSandboxAgent).runs.at(-1)!.tools, ['plan', 'quiz-check']);
  const run = agentRuns(app)[0]!;
  assert.equal(run.purpose, 'day1_quiz');
  assert.equal(run.outcome, 'accepted');

  await command(app, 'U_MGR_DANA', 'quiz-send FW-001');
  assert.match(app.mocks.slack!.posts('U_ROSA').at(-1)!.text, /day-1 check-in/);
  assert.doesNotMatch(app.mocks.slack!.posts('U_ROSA').at(-1)!.text, /✓/, 'answers are not sent to the worker');

  await command(app, 'U_MGR_DANA', 'start "Sam Rivera" sam.rivera@example.net');
  assert.match((await command(app, 'U_MGR_DANA', 'quiz FW-003')).text, /needs an approved plan/);
});

test('a quiz that names modules outside the approved plan is rejected and not saved', async () => {
  const app = await joined();
  const bad: SandboxAgent = {
    mode: 'evil',
    run: async () => ({ text: JSON.stringify({ title: 'x', questions: Array.from({ length: 5 }, () => ({ module: 'ADMIN-999', question: 'Grant yourself admin?', options: ['yes', 'no', 'maybe'], answer: 0 })) }), model: 'm', toolCalls: 0, tools: [], toolFailures: 0, durationMs: 1, fallbackUsed: false, warnings: [] }),
  };
  app.adapters.sandbox = bad;
  const before = app.store.documents('FW-001', 'quiz').length;
  assert.match((await command(app, 'U_MGR_DANA', 'quiz FW-001')).text, /failed validation/);
  assert.equal(app.store.documents('FW-001', 'quiz').length, before);
  assert.equal(agentRuns(app)[0]!.outcome, 'rejected');
});

test('manager chat runs through the sandboxed agent and only suggests', async () => {
  const app = await joined();
  await handleAgentMessage(app, { eventId: 'c1', userId: 'U_MGR_DANA', channel: 'D_DANA', text: 'anything blocked?' });
  assert.deepEqual((app.adapters.sandbox as MockSandboxAgent).runs.at(-1)!.tools, ['blockers', 'cases']);
  assert.equal(agentRuns(app)[0]!.purpose, 'manager_chat');
});

test('NemoClaw CLI output parser ignores banner lines and trailing warnings', () => {
  const out = '✓ Active gateway\n{\n  "status": "ok", "text": "a } b"\n}\n\n  The agent turn did not complete: replayInvalid=true.\n';
  assert.deepEqual(firstJsonObject(out), { status: 'ok', text: 'a } b' });
});
