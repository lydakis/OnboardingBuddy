// One-command mock demo:  npm run demo -- --phase 2 [--no-serve] [--db path] [--keep]
// Mock adapters by default. With OB_LLM_MODE=openai-compatible the model calls go to the GB10.
import { rmSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { loadConfig, describeModes } from '../config.ts';
import { createApp } from '../app.ts';
import { startStatusServer } from '../server/status.ts';
import { PHASES } from './phases.ts';

const { values } = parseArgs({
  options: {
    phase: { type: 'string', default: '1' },
    'no-serve': { type: 'boolean', default: false },
    db: { type: 'string', default: 'data/demo.db' },
    keep: { type: 'boolean', default: false },
  },
});

const phase = Number(values.phase);
if (!Number.isInteger(phase) || phase < 1 || phase > PHASES.length) {
  console.error(`--phase must be 1..${PHASES.length}`);
  process.exit(2);
}

if (!values.keep) for (const suffix of ['', '-wal', '-shm']) rmSync(`${values.db}${suffix}`, { force: true });
const config = loadConfig({ ...process.env, OB_DB_PATH: values.db });
const app = await createApp(config);
if (!app.mocks.email || !app.mocks.slack) {
  console.error('The scripted demo drives the mock email and Slack adapters. Unset OB_EMAIL_MODE / OB_SLACK_MODE.');
  process.exit(2);
}

console.log(`Onboarding Buddy demo — ${config.companyName}`);
for (const [k, v] of Object.entries(describeModes(config))) console.log(`  ${k.padEnd(7)} ${v}`);

for (let p = 1; p <= phase; p++) await PHASES[p - 1]!(app, (line) => console.log(line));

if (values['no-serve']) {
  app.close();
} else {
  await startStatusServer(app);
  console.log(`\nStatus page: http://${config.statusHost}:${config.statusPort}  (Ctrl-C to stop)`);
}
