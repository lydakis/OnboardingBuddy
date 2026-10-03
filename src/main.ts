// Long-running service: email polling + Slack Socket Mode + read-only status page.
// Same code runs fully mocked (default) or against live connectors (see docs/LIVE-SETUP.md).
import { loadConfig, describeModes } from './config.ts';
import { createApp } from './app.ts';
import { startStatusServer } from './server/status.ts';
import { pollEmail } from './engine/intake.ts';
import { handleSlackCommand } from './engine/commands.ts';
import { handleTeamJoin } from './engine/join.ts';

const log = (msg: string) => console.log(`${new Date().toISOString()} ${msg}`);
const config = loadConfig();
const app = await createApp(config);

log(`Onboarding Buddy — ${config.companyName}`);
for (const [k, v] of Object.entries(describeModes(config))) log(`  ${k.padEnd(7)} ${v}`);
if (config.email.mode !== 'mock' && config.liveRecipientAllowlist.length === 0) {
  log('  WARNING: OB_LIVE_RECIPIENT_ALLOWLIST is empty, so no live email or invite will be sent.');
}

const server = await startStatusServer(app);
log(`status page on http://${config.statusHost}:${config.statusPort}`);

let polling = false;
const pollTimer = setInterval(async () => {
  if (polling) return;
  polling = true;
  try {
    for (const r of await pollEmail(app)) log(`email: ${r.outcome}${'caseId' in r ? ` ${r.caseId}` : ''}`);
  } catch (err) {
    log(`email poll failed: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    polling = false;
  }
}, config.email.pollIntervalMs);

let socket: { stop(): void } | undefined;
if (config.slack.mode === 'socket') {
  const { SocketModeClient } = await import('./adapters/slack/socket.ts');
  const client = new SocketModeClient(
    config.slack.appToken!,
    {
      onCommand: async (e) => {
        const r = await handleSlackCommand(app, e);
        log(`slack command from ${e.userId}: ${e.text.split(' ')[0]} → ${r.text.split('\n')[0]!.slice(0, 80)}`);
      },
      onTeamJoin: async (e) => log(`team_join ${e.user.id}: ${await handleTeamJoin(app, e)}`),
      onMessage: async (e) => {
        const { handleAgentMessage } = await import('./engine/agent.ts');
        await handleAgentMessage(app, e);
      },
    },
    log,
  );
  await client.start();
  socket = client;
} else {
  log('slack: mock mode; drive commands with `npm run cli -- slack <user> "<command>"` against the same database');
}

function shutdown(): void {
  log('shutting down');
  clearInterval(pollTimer);
  socket?.stop();
  server.close();
  app.close();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
