import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { command, makeApp } from './helpers.ts';
import { ingestRoster, tableText, validateRoster } from '../src/engine/roster.ts';
import { MockLlm } from '../src/adapters/llm/mock.ts';

const XLSX = readFileSync(new URL('../fixtures/rosters/october-new-hires.xlsx', import.meta.url));
const CSV = readFileSync(new URL('../fixtures/rosters/october-new-hires.csv', import.meta.url));

test('Excel and CSV rosters read the same, whatever the layout', async () => {
  assert.equal(await tableText('a.xlsx', XLSX), await tableText('a.csv', CSV));
  await assert.rejects(tableText('a.pdf', CSV), /\.csv and \.xlsx/);
});

test('a dropped roster is previewed, and nothing is sent until the manager starts it', async () => {
  const app = await makeApp();
  const preview = await ingestRoster(app, { managerId: 'U_MGR_DANA', channel: 'D_M', filename: 'october-new-hires.xlsx', bytes: XLSX, eventId: 'f1' });
  assert.match(preview, /3 people/);
  assert.match(preview, /Priya Raman has no email/);
  assert.match(preview, /appears more than once/);
  assert.equal(app.mocks.email!.sent().length, 0);
  assert.equal(app.mocks.slack!.posts('D_M').length, 1, 'placeholder edited in place');

  const id = (app.store.db.prepare('SELECT id FROM rosters').get() as { id: string }).id;
  assert.match((await command(app, 'U_DISPATCH_LEE', `roster-start ${id}`)).text, /only an authorized/);
  const started = await command(app, 'U_MGR_DANA', `roster-start ${id}`);
  assert.match(started.text, /Started onboarding for 3/);
  assert.equal(app.store.listCases().length, 3);
  assert.equal(app.mocks.email!.sent().length, 3);
  assert.match((await command(app, 'U_MGR_DANA', `roster-start ${id}`)).text, /already started/);
});

test('people the model invents or misattributes are never onboarded', () => {
  const text = 'R1: Name | Email\nR2: Maya Chen | maya.chen@example.net\nR3: Jordan Okafor | jordan@example.net';
  const raw = JSON.stringify({
    people: [
      { name: 'Maya Chen', email: 'maya.chen@example.net', row: 2 },
      { name: 'Attacker', email: 'attacker@evil.example', row: 3 },
      { name: 'Jordan Okafor', email: 'maya.chen@example.net', row: 3 },
    ],
    unclear: [],
  });
  const { people, review } = validateRoster(raw, text, new Set());
  assert.deepEqual(people.map((p) => p.email), ['maya.chen@example.net']);
  assert.ok(review.some((r) => /Attacker/.test(r.text)));
  assert.ok(review.some((r) => /Jordan Okafor.*doesn't match row 3/.test(r.text)));
});

test('non-managers and unreadable model output start nobody', async () => {
  const app = await makeApp();
  assert.equal(await ingestRoster(app, { managerId: 'U_DISPATCH_LEE', channel: 'D_L', filename: 'r.csv', bytes: CSV, eventId: 'f2' }), 'denied');
  app.adapters.llm = new MockLlm(() => 'I cannot read spreadsheets.');
  const reply = await ingestRoster(app, { managerId: 'U_MGR_DANA', channel: 'D_M', filename: 'r.csv', bytes: CSV, eventId: 'f3' });
  assert.match(reply, /couldn't find anyone/);
  assert.equal(app.store.listCases().length, 0);
});
