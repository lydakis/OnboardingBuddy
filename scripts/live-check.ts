// Read-only readiness check for live integrations. Sends nothing, invites nobody.
//   set -a && . ~/.config/onboarding-buddy/env && npm run live:check
import { loadConfig, describeModes } from '../src/config.ts';

type Status = 'ready' | 'mocked' | 'blocked' | 'untested';
const rows: { component: string; status: Status; detail: string }[] = [];
const add = (component: string, status: Status, detail: string) => rows.push({ component, status, detail });


let config;
try {
  config = loadConfig();
} catch (err) {
  console.error(`config invalid: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}

async function slackCall(token: string, method: string, body?: Record<string, string>) {
  const res = await fetch(`https://slack.com/api/${method}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/x-www-form-urlencoded' },
    body: body ? new URLSearchParams(body) : undefined,
    signal: AbortSignal.timeout(10000),
  });
  return { json: (await res.json()) as Record<string, any>, scopes: res.headers.get('x-oauth-scopes') ?? '' };
}

// Slack bot token
if (config.slack.mode === 'mock') add('Slack (bot)', 'mocked', 'OB_SLACK_MODE=mock');
else {
  const { json, scopes } = await slackCall(config.slack.botToken!, 'auth.test');
  if (!json.ok) add('Slack (bot)', 'blocked', `auth.test: ${json.error}`);
  else {
    const need = ['commands', 'chat:write', 'im:write', 'users:read', 'users:read.email', 'channels:manage', 'im:history'];
    const missing = need.filter((s) => !scopes.split(',').includes(s));
    add('Slack (bot)', missing.length ? 'blocked' : 'ready', `team ${json.team} (${json.team_id}), bot ${json.user_id}${missing.length ? `; missing scopes: ${missing.join(', ')}` : ''}`);
    const ch = await slackCall(config.slack.botToken!, 'conversations.info', { channel: config.newHireChannel });
    add('Slack new-hire channel', ch.json.ok ? 'ready' : 'blocked', ch.json.ok ? `#${ch.json.channel.name} (${config.newHireChannel})` : `conversations.info: ${ch.json.error} (OB_NEW_HIRE_CHANNEL must be a channel ID)`);
    for (const id of config.managerSlackIds) {
      const u = await slackCall(config.slack.botToken!, 'users.info', { user: id });
      add(`Manager ${id}`, u.json.ok ? 'ready' : 'blocked', u.json.ok ? u.json.user.real_name : u.json.error);
    }
  }
  const open = await fetch('https://slack.com/api/apps.connections.open', { method: 'POST', headers: { authorization: `Bearer ${config.slack.appToken}` } }).then((r) => r.json() as Promise<Record<string, any>>);
  add('Slack Socket Mode', open.ok ? 'ready' : 'blocked', open.ok ? 'apps.connections.open ok (socket not kept open)' : `apps.connections.open: ${open.error}`);
}

// Workspace invites
if (config.invite.mode === 'mock') add('Workspace invite', 'mocked', 'OB_INVITE_MODE=mock');
else if (config.invite.mode === 'manual') add('Workspace invite', 'ready', 'manual admin fallback (/onboard invite-sent)');
else {
  const { json, scopes } = await slackCall(config.invite.adminUserToken!, 'auth.test');
  const hasScope = scopes.split(',').includes('admin.users:write');
  add('Workspace invite (admin.users.invite)', json.ok && hasScope ? 'untested' : 'blocked',
    json.ok ? `user token for ${json.user}${json.enterprise_id ? `, enterprise ${json.enterprise_id}` : ', NOT an Enterprise org token'}; admin.users:write ${hasScope ? 'present' : 'MISSING'}; no invite sent by this check` : `auth.test: ${json.error}`);
}

// Email
if (config.email.mode === 'mock') add('Email', 'mocked', 'OB_EMAIL_MODE=mock');
else {
  const res = await fetch(`${config.email.agentmailBaseUrl}/inboxes/${encodeURIComponent(config.email.agentmailInboxId!)}/messages?limit=1`, {
    headers: { authorization: `Bearer ${config.email.agentmailApiKey}` }, signal: AbortSignal.timeout(10000),
  });
  add('Email (AgentMail)', res.ok ? 'untested' : 'blocked', res.ok ? `inbox ${config.email.agentmailInboxId} readable; sending not exercised by this check` : `HTTP ${res.status}`);
}
add('Live recipient allowlist', config.liveRecipientAllowlist.length ? 'ready' : config.email.mode === 'mock' ? 'mocked' : 'blocked', config.liveRecipientAllowlist.length ? `${config.liveRecipientAllowlist.length} address(es)` : 'OB_LIVE_RECIPIENT_ALLOWLIST empty');

// Model
if (config.llm.mode === 'mock') add('Model', 'mocked', 'OB_LLM_MODE=mock');
else {
  const { createApp } = await import('../src/app.ts');
  const app = await createApp({ ...config, dbPath: ':memory:' });
  const started = Date.now();
  try {
    const out = await app.adapters.llm.complete([{ role: 'user', content: 'Reply with the single word READY.' }], { sessionKey: 'onboarding-live-check' });
    add('Model', /READY/i.test(out) ? 'ready' : 'untested', `${describeModes(config).llm}; ${Date.now() - started} ms; replied "${out.slice(0, 40)}"`);
  } catch (err) {
    add('Model', 'blocked', err instanceof Error ? err.message : String(err));
  }
}

const icon: Record<Status, string> = { ready: '✅', mocked: '🧪', blocked: '⛔', untested: '🟡' };
for (const r of rows) console.log(`${icon[r.status]} ${r.status.padEnd(8)} ${r.component.padEnd(38)} ${r.detail}`);

process.exit(rows.some((r) => r.status === 'blocked') ? 1 : 0);
