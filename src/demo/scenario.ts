import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { App } from '../app.ts';
import { handleSlackCommand } from '../engine/commands.ts';
import { pollEmail } from '../engine/intake.ts';

export const MANAGER = 'U_MGR_DANA';
export const ROSA = { name: 'Rosa Delgado', email: 'rosa.delgado@example.net', dir: 'rosa-experienced' };
export const THEO = { name: 'Theo Park', email: 'theo.park@example.net', dir: 'theo-beginner' };

const root = fileURLToPath(new URL('../../fixtures/', import.meta.url));
export function fixture(path: string): string {
  return readFileSync(root + path, 'utf8');
}

export type Log = (line: string) => void;

let eventSeq = 0;
export async function slack(app: App, log: Log, userId: string, text: string): Promise<string> {
  eventSeq++;
  log(`\n💬 Slack <${userId}>: /onboard ${text}`);
  const reply = await handleSlackCommand(app, { eventId: `demo-${Date.now()}-${eventSeq}`, userId, channel: userId, text });
  log(indent(`🤖 ${reply.text}`));
  if (reply.buttons?.length) log(indent(`   [${reply.buttons.map((b) => b.text).join('] [')}]`));
  return reply.text;
}

export async function poll(app: App, log: Log): Promise<void> {
  const results = await pollEmail(app);
  for (const r of results) {
    if (r.outcome === 'updated')
      log(indent(`📥 ${r.caseId}: recorded [${r.completed.join(', ') || 'nothing new'}]; still missing [${r.stillMissing.join(', ') || 'none'}]`));
    else log(indent(`📥 ${r.outcome}${'reason' in r ? `: ${r.reason}` : ''}`));
  }
}

function indent(s: string): string {
  return s
    .split('\n')
    .map((l) => `    ${l}`)
    .join('\n');
}

export function lastEmailTo(app: App, to: string): string {
  const sent = app.mocks.email!.sent(to);
  return sent.at(-1)?.body ?? '';
}

/** Phase 1: Slack-started cases, email intake, follow-ups, dedupe, quarantine, authz. */
export async function runPhase1(app: App, log: Log): Promise<void> {
  const mail = app.mocks.email!;
  log('\n═══ PHASE 1 — EMAIL INTAKE ═══');
  await slack(app, log, MANAGER, `start "${ROSA.name}" ${ROSA.email}`);
  await slack(app, log, MANAGER, `start "${THEO.name}" ${THEO.email}`);
  log(`\n✉️  Welcome email to Theo (excerpt):\n${lastEmailTo(app, THEO.email).split('\n').slice(0, 14).map((l) => `    | ${l}`).join('\n')}`);

  log('\n✉️  Rosa replies with her CV attached and every answer.');
  mail.replyAsWorker({ from: `Rosa Delgado <${ROSA.email}>`, text: fixture(`workers/${ROSA.dir}/reply-1.txt`), attachments: [{ filename: 'Rosa_Delgado_CV.txt', contentType: 'text/plain', text: fixture(`workers/${ROSA.dir}/cv.txt`) }] });
  await poll(app, log);

  log('\n✉️  Theo replies with only some answers (blank LinkedIn, invalid shift, no CV).');
  const partial = mail.replyAsWorker({ from: THEO.email, text: fixture(`workers/${THEO.dir}/reply-1-partial.txt`) });
  await poll(app, log);
  log(`\n✉️  Focused follow-up to Theo:\n${lastEmailTo(app, THEO.email).split('\n').slice(0, 9).map((l) => `    | ${l}`).join('\n')}`);

  log('\n🔁 The mail provider re-delivers Theo\'s same reply (duplicate message id).');
  const sendsBefore = mail.sent().length;
  mail.deliver({ ...partial });
  await poll(app, log);
  log(`    emails sent before/after duplicate: ${sendsBefore}/${mail.sent().length}`);

  log('\n🕵️  Someone else replies on Theo\'s thread from a different address.');
  mail.deliver({ providerMessageId: '<spoof-1@elsewhere.example>', inReplyTo: partial.inReplyTo, references: partial.references, from: 'friend@elsewhere.example', to: app.config.email.fromAddress, subject: 'Re: Welcome', text: 'Preferred shift: early\nLinkedIn: none', attachments: [] });
  await poll(app, log);

  log('\n✉️  Theo sends the rest, with the CV attached.');
  mail.replyAsWorker({ from: THEO.email, text: fixture(`workers/${THEO.dir}/reply-2.txt`), attachments: [{ filename: 'theo-resume.txt', contentType: 'text/plain', text: fixture(`workers/${THEO.dir}/cv.txt`) }] });
  await poll(app, log);

  await slack(app, log, 'U_DISPATCH_LEE', 'status FW-002');
  await slack(app, log, MANAGER, 'status FW-002');
  await slack(app, log, MANAGER, 'status');
}

/** Phase 2: evidence-backed plans, a blocking conflict, revision, approval, and the approved email. */
export async function runPhase2(app: App, log: Log): Promise<void> {
  log('\n═══ PHASE 2 — TRAINING PLAN ═══');
  await slack(app, log, MANAGER, 'plan FW-001');
  await slack(app, log, MANAGER, 'plan FW-002');
  log('\n⛔ Theo\'s plan cannot be approved while the experience conflict is open:');
  await slack(app, log, MANAGER, 'approve FW-002 v1');
  await slack(app, log, MANAGER, 'evidence FW-002');
  await slack(app, log, MANAGER, 'revise FW-002 resolve=experience-conflict "Called Theo: the bike work was app food delivery, not parcel routes. Foundations is right."');
  await slack(app, log, MANAGER, 'approve FW-002 v2');
  await slack(app, log, 'U_DISPATCH_LEE', 'approve FW-001 v1');
  await slack(app, log, MANAGER, 'revise FW-001 add=DRV-220 "Company insurance requires defensive driving for all new drivers this quarter."');
  await slack(app, log, MANAGER, 'approve FW-001 v2');
  log(`\n✉️  Approved plan emailed to Rosa (excerpt):\n${lastEmailTo(app, ROSA.email).split('\n').slice(0, 8).map((l) => `    | ${l}`).join('\n')}`);
}

/** Phase 3: readiness, invite vs joined, ambiguous identity review, welcome. */
export async function runPhase3(app: App, log: Log): Promise<void> {
  const { handleTeamJoin } = await import('../engine/join.ts');
  const slackMock = app.mocks.slack!;
  log('\n═══ PHASE 3 — JOIN SLACK ═══');
  await slack(app, log, MANAGER, `start "Sam Rivera" sam.rivera@example.net`);
  await slack(app, log, MANAGER, 'invite FW-003');
  await slack(app, log, MANAGER, 'invite FW-001');
  await slack(app, log, MANAGER, 'status FW-001');

  log('\n🧑 Rosa accepts the invite: Slack sends team_join with her invite email.');
  slackMock.addUser({ id: 'U_ROSA', email: ROSA.email, realName: 'Rosa Delgado' });
  log(`    → ${await handleTeamJoin(app, { eventId: 'Ev-rosa-join', user: { id: 'U_ROSA', email: ROSA.email, realName: 'Rosa Delgado' } })}`);

  await slack(app, log, MANAGER, 'invite FW-002');
  await slack(app, log, MANAGER, 'clear FW-002 "The other sender was Theo\'s roommate forwarding; nothing was applied."');
  await slack(app, log, MANAGER, 'invite FW-002');
  log('\n🧑 Someone named "Theo" joins with a personal address that does not match the invite.');
  slackMock.addUser({ id: 'U_THEO_P', email: 'tpark.personal@example.org', realName: 'Theo P.' });
  log(`    → ${await handleTeamJoin(app, { eventId: 'Ev-theo-join', user: { id: 'U_THEO_P', email: 'tpark.personal@example.org', realName: 'Theo P.' } })}`);
  await slack(app, log, MANAGER, 'status FW-002');
  await slack(app, log, MANAGER, 'link FW-002 U_THEO_P');
  log(`\n#new-couriers:\n${slackMock.posts(app.config.newHireChannel).map((p) => `    | ${p.text}`).join('\n')}`);
}
