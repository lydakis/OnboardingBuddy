// Load personal credentials with Node --env-file, then forward through Errand.
// Runtime settings live on GB10; no credential values enter command arguments.
import { spawn } from 'node:child_process';

const action = process.argv[2] ?? 'check';
if (!['check', 'start'].includes(action)) throw new Error('Usage: scripts/gb10.ts check|start');
const names = ['AGENTMAIL_API_KEY', 'SLACK_BOT_TOKEN', 'SLACK_APP_TOKEN', 'SLACK_ADMIN_USER_TOKEN'];
for (const name of names.slice(0, 3)) {
  if (!process.env[name]) throw new Error(`Load the existing personal configuration containing ${name}`);
}
const args = ['--on', 'gb10', '--no-apply', ...(action === 'start' ? ['--detach'] : []),
  ...names.filter(k => process.env[k]).flatMap(k => ['--passenv', k]), '--', 'sh', '-c',
  action === 'start' ? 'npm ci --silent && exec sh scripts/start-gb10.sh'
    : 'npm ci --silent && exec node --disable-warning=ExperimentalWarning --env-file=slack/sandbox.env --env-file="$HOME/.config/onboarding-buddy/runtime.env" --env-file="$HOME/.config/onboarding-buddy/readiness.env" scripts/live-check.ts'];
const child = spawn('errand', args, { env: process.env, stdio: 'inherit' });
child.on('error', () => { console.error('Errand launch failed'); process.exitCode = 1; });
child.on('exit', code => { process.exitCode = code ?? 1; });
