// Phase 3: join Slack. Three distinct states are never collapsed:
//   requested (manager approved) → sent (invite left, or admin confirmed a manual invite)
//   → membership_confirmed (Slack told us this person is a member AND the identity matched).
// Only membership_confirmed links the Slack id, adds the worker to the channel and welcomes them.
import type { EngineContext } from './context.ts';
import { assertLiveRecipientAllowed, isManager, postSlack, sendEmail } from './context.ts';
import { UserError, findCase, registerCommand } from './commands.ts';
import { REQUIRED_KEYS } from './questionnaire.ts';
import { newId, now } from '../db/store.ts';
import type { CaseRow, SlackTeamJoinEvent, SlackUser } from '../types.ts';

export type InviteState = 'requested' | 'sent' | 'manual_pending' | 'failed' | 'needs_review' | 'membership_confirmed';

export interface InvitationRow {
  case_id: string;
  state: InviteState;
  method: string | null;
  email: string;
  requested_by: string | null;
  requested_at: string | null;
  sent_at: string | null;
  confirmed_at: string | null;
  welcomed_at: string | null;
  slack_user_id: string | null;
  review_reason: string | null;
  updated_at: string;
}

export function getInvitation(ctx: EngineContext, caseId: string): InvitationRow | undefined {
  return ctx.store.db.prepare('SELECT * FROM invitations WHERE case_id = ?').get(caseId) as InvitationRow | undefined;
}

function setInvitation(ctx: EngineContext, caseId: string, fields: Partial<InvitationRow>): void {
  const keys = Object.keys(fields) as (keyof InvitationRow)[];
  ctx.store.db
    .prepare(`UPDATE invitations SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = ? WHERE case_id = ?`)
    .run(...keys.map((k) => (fields[k] ?? null) as string | null), now(), caseId);
}

export function readinessProblems(ctx: EngineContext, c: CaseRow): string[] {
  const problems: string[] = [];
  const items = ctx.store.checklist(c.id);
  if (ctx.config.readiness.requireIntakeComplete && (c.status === 'intake' || items.some((i) => REQUIRED_KEYS.has(i.key) && i.status !== 'complete'))) problems.push('intake checklist is not complete');
  if (ctx.config.readiness.requirePlanSent && !['plan_sent', 'slack_invited', 'slack_joined'].includes(c.status)) problems.push('approved training plan has not been sent');
  if (!items.find((i) => i.key === 'slack_email' && i.status === 'complete')) problems.push('no confirmed email for the Slack invite');
  if (c.needs_attention) problems.push(`open issue: ${c.needs_attention}`);
  return problems;
}

/** Manager-approved invitation request. Never marks anyone as joined. */
export async function requestInvite(ctx: EngineContext, c: CaseRow, managerId: string): Promise<string> {
  if (!isManager(ctx, managerId)) throw new UserError('Only an authorized manager can approve a Slack invitation.');
  const problems = readinessProblems(ctx, c);
  if (problems.length) throw new UserError(`Not ready to invite ${c.worker_name}: ${problems.join('; ')}.`);
  const email = ctx.store.checklist(c.id).find((i) => i.key === 'slack_email')!.value!;
  const existing = getInvitation(ctx, c.id);
  if (existing && existing.state !== 'failed') return `Invitation for ${c.id} is already ${existing.state}.`;

  ctx.store.transaction(() => {
    ctx.store.db
      .prepare('INSERT INTO approvals (id, case_id, subject_type, subject_id, decision, manager_slack_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(newId('appr'), c.id, 'invite', email, 'approved', managerId, now());
    ctx.store.db
      .prepare(`INSERT INTO invitations (case_id, state, email, requested_by, requested_at, updated_at) VALUES (?, 'requested', ?, ?, ?, ?)
                ON CONFLICT(case_id) DO UPDATE SET state = 'requested', email = excluded.email, requested_by = excluded.requested_by, requested_at = excluded.requested_at, review_reason = NULL, updated_at = excluded.updated_at`)
      .run(c.id, email, managerId, now(), now());
    ctx.store.audit(c.id, managerId, 'invite_requested', { email });
  });

  // Already a member (e.g. re-hire or earlier manual invite): verify instead of inviting.
  const member = await ctx.adapters.slack.lookupUserByEmail(email).catch(() => null);
  if (member && !member.deleted) {
    await confirmMembership(ctx, c, member, 'existing member found by exact email');
    return `${email} is already in the workspace as <@${member.id}>; linked to ${c.id} and welcomed.`;
  }

  const capability = ctx.adapters.invite.capability();
  let outcome;
  try {
    assertLiveRecipientAllowed(ctx, email, ctx.adapters.invite.mode);
    outcome = await ctx.adapters.invite.inviteToWorkspace({ email, caseId: c.id, channelIds: [ctx.config.newHireChannel] });
  } catch (err) {
    outcome = { outcome: 'failed' as const, error: err instanceof Error ? err.message : String(err) };
  }
  if (outcome.outcome === 'sent') {
    setInvitation(ctx, c.id, { state: 'sent', method: capability.method, sent_at: now() });
    ctx.store.setStatus(c.id, 'slack_invited');
    ctx.store.audit(c.id, 'agent', 'invite_sent', { method: capability.method, reference: outcome.reference });
    await emailInviteNotice(ctx, c, email);
    return `📨 Slack invitation sent to ${email} (${capability.method}). I'll confirm when Slack reports they joined; until then they are *not* marked as joined.`;
  }
  if (outcome.outcome === 'manual_required') {
    setInvitation(ctx, c.id, { state: 'manual_pending', method: 'manual' });
    ctx.store.audit(c.id, 'agent', 'invite_manual_required', { reason: capability.explanation });
    return `🧑‍💼 Manual step needed: ${outcome.instructions}\n(${capability.explanation})`;
  }
  setInvitation(ctx, c.id, { state: 'failed', method: capability.method, review_reason: outcome.error });
  ctx.store.audit(c.id, 'agent', 'invite_failed', { error: outcome.error });
  return `⚠️ Automated invite failed (${outcome.error}). Fallback: a Slack admin invites ${email} manually, then run \`/onboard invite-sent ${c.id}\`. Earlier steps are unaffected.`;
}

async function emailInviteNotice(ctx: EngineContext, c: CaseRow, email: string): Promise<void> {
  await sendEmail(ctx, {
    actionKey: `email:slack-invite-notice:${c.id}`, caseId: c.id, kind: 'slack_invite_notice', to: c.worker_email,
    subject: 'Your invitation to our team Slack',
    text: `Hi ${c.worker_name.split(' ')[0]},\n\nSlack will email an invitation to ${email}. Please accept it and sign in; I'll say hello in ${ctx.config.newHireChannel} once you're in.\n\n— Onboarding assistant`,
  });
}

/** Called for every team_join event. Links a case only on an unambiguous identity match. */
export async function handleTeamJoin(ctx: EngineContext, event: SlackTeamJoinEvent): Promise<string> {
  if (!ctx.store.claimEvent(`slack:${event.eventId}`, null, 'processing')) return 'duplicate';
  const user = event.user;
  if (user.isBot) return 'ignored bot';
  const pending = ctx.store.db
    .prepare(`SELECT * FROM invitations WHERE state IN ('requested','sent','manual_pending','needs_review')`)
    .all() as unknown as InvitationRow[];
  const byEmail = user.email ? pending.filter((i) => i.email === user.email!.toLowerCase()) : [];
  if (byEmail.length === 1) {
    const c = ctx.store.getCase(byEmail[0]!.case_id)!;
    await confirmMembership(ctx, c, user, 'team_join with matching invite email');
    ctx.store.setEventOutcome(`slack:${event.eventId}`, c.id, 'confirmed');
    return `confirmed ${c.id}`;
  }
  // No usable email: a name match is a hint, never proof.
  const nameMatches = user.realName
    ? pending.filter((i) => {
        const c = ctx.store.getCase(i.case_id)!;
        return c.worker_name.toLowerCase().split(' ')[0] === user.realName!.toLowerCase().split(' ')[0];
      })
    : [];
  const candidates = byEmail.length > 1 ? byEmail : nameMatches;
  for (const inv of candidates) {
    const c = ctx.store.getCase(inv.case_id)!;
    const reason = byEmail.length > 1
      ? `Slack user ${user.id} matches ${byEmail.length} pending invites by email`
      : `Slack user ${user.id} ("${user.realName}") joined without a matching email; name looks like ${c.worker_name}`;
    setInvitation(ctx, c.id, { state: 'needs_review', review_reason: reason });
    ctx.store.audit(c.id, 'system', 'identity_review_required', { slackUserId: user.id, reason });
    await postSlack(ctx, {
      actionKey: `slack:identity-review:${c.id}:${user.id}`, caseId: c.id, kind: 'identity_review', channel: c.manager_slack_id,
      text: `🔍 Possible join for *${c.worker_name}* (${c.id}): ${reason}. I have not linked anyone. If <@${user.id}> is ${c.worker_name}, confirm below.`,
      buttons: [{ text: `Link <@${user.id}> to ${c.id}`, command: `link ${c.id} ${user.id}`, style: 'primary' }],
    });
  }
  ctx.store.setEventOutcome(`slack:${event.eventId}`, null, candidates.length ? 'needs_review' : 'unrelated');
  return candidates.length ? 'needs_review' : 'unrelated join';
}

/** The only place a case becomes slack_joined. */
async function confirmMembership(ctx: EngineContext, c: CaseRow, user: SlackUser, basis: string): Promise<void> {
  const claimed = ctx.store.db.prepare('SELECT id FROM cases WHERE slack_user_id = ? AND id <> ?').get(user.id, c.id) as { id: string } | undefined;
  if (claimed) throw new UserError(`<@${user.id}> is already linked to ${claimed.id}.`);
  ctx.store.transaction(() => {
    setInvitation(ctx, c.id, { state: 'membership_confirmed', confirmed_at: now(), slack_user_id: user.id, review_reason: null });
    ctx.store.updateCase(c.id, { slack_user_id: user.id, status: 'slack_joined' });
    ctx.store.audit(c.id, 'system', 'membership_confirmed', { slackUserId: user.id, basis });
  });
  await welcome(ctx, ctx.store.getCase(c.id)!, user.id);
}

async function welcome(ctx: EngineContext, c: CaseRow, userId: string): Promise<void> {
  const channel = ctx.config.newHireChannel;
  try {
    await ctx.adapters.slack.addToChannel(channel, userId);
  } catch (err) {
    ctx.store.audit(c.id, 'agent', 'channel_add_failed', { channel, error: err instanceof Error ? err.message : String(err) });
  }
  const name = ctx.store.checklist(c.id).find((i) => i.key === 'preferred_name')?.value ?? c.worker_name.split(' ')[0];
  const r = await postSlack(ctx, {
    actionKey: `slack:welcome-channel:${c.id}`, caseId: c.id, kind: 'welcome_channel', channel,
    text: `👋 Please welcome <@${userId}> (${name}) to the team! They start their onboarding plan this week.`,
  });
  // The DM welcome now opens the tailored questionnaire (question 1); older cases without items get a plain hello.
  const { currentItem, startQuestionnaire } = await import('./slack-questionnaire.ts');
  if (currentItem(ctx, c.id)) {
    await startQuestionnaire(ctx, c, name ?? c.worker_name);
  } else {
    await postSlack(ctx, {
      actionKey: `slack:welcome-dm:${c.id}`, caseId: c.id, kind: 'welcome_dm', channel: userId,
      text: `Hi ${name}, you're in! I'm your onboarding assistant. Ask me here if you have questions about your first weeks.`,
    });
  }
  await postSlack(ctx, {
    actionKey: `slack:joined-manager:${c.id}`, caseId: c.id, kind: 'joined_notice', channel: c.manager_slack_id,
    text: `✅ ${c.worker_name} (${c.id}) joined Slack as <@${userId}> and was welcomed in ${channel}.`,
  });
  if (r.state === 'sent') ctx.store.db.prepare('UPDATE invitations SET welcomed_at = ? WHERE case_id = ?').run(now(), c.id);
}

registerCommand('invite', 'invite <case>', async (ctx, args, event) => {
  const c = findCase(ctx, args[0]);
  return { text: await requestInvite(ctx, c, event.userId), buttons: [{ text: 'Status', command: `status ${c.id}` }] };
});

registerCommand('invite-sent', 'invite-sent <case>', async (ctx, args, event) => {
  const c = findCase(ctx, args[0]);
  const inv = getInvitation(ctx, c.id);
  if (!inv || !['manual_pending', 'failed', 'requested'].includes(inv.state)) throw new UserError(`${c.id} has no invitation waiting for a manual send.`);
  setInvitation(ctx, c.id, { state: 'sent', method: 'manual', sent_at: now() });
  ctx.store.setStatus(c.id, 'slack_invited');
  ctx.store.audit(c.id, event.userId, 'invite_sent_manually');
  await emailInviteNotice(ctx, c, inv.email);
  return { text: `Recorded: a Slack admin invited ${inv.email}. ${c.worker_name} is *not* marked as joined until Slack confirms membership.` };
});

registerCommand('link', 'link <case> <slack user id>', async (ctx, args, event) => {
  const c = findCase(ctx, args[0]);
  const userId = args[1]?.replace(/[<@>]/g, '');
  const inv = getInvitation(ctx, c.id);
  if (!userId || !inv || inv.state === 'membership_confirmed') throw new UserError('Usage: link <case> <slack user id>, for a case with a pending invitation.');
  ctx.store.audit(c.id, event.userId, 'identity_confirmed_by_manager', { slackUserId: userId });
  await confirmMembership(ctx, c, { id: userId }, `manager ${event.userId} confirmed identity`);
  return { text: `Linked <@${userId}> to ${c.id} and welcomed them.` };
});

registerCommand('verify-join', 'verify-join <case>', async (ctx, args) => {
  const c = findCase(ctx, args[0]);
  const inv = getInvitation(ctx, c.id);
  if (!inv) throw new UserError(`${c.id} has no invitation.`);
  if (inv.state === 'membership_confirmed') return { text: `${c.worker_name} is already confirmed as <@${inv.slack_user_id}>.` };
  const user = await ctx.adapters.slack.lookupUserByEmail(inv.email);
  if (!user || user.deleted) return { text: `No Slack member with ${inv.email} yet (invitation: ${inv.state}).` };
  await confirmMembership(ctx, c, user, 'users.lookupByEmail exact match');
  return { text: `✅ Confirmed: ${inv.email} is <@${user.id}>. Linked and welcomed.` };
});
