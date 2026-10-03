import type { InviteAdapter, InviteCapability, InviteResult } from '../../types.ts';

// UNVERIFIED: admin.users.invite. Only works on an Enterprise organization with a
// user token (admin.users:write) from an org-wide install by an Org Admin/Owner.
// Not exercised in the hackathon; kept so the route is ready if such a workspace exists.
export class SlackAdminInviteAdapter implements InviteAdapter {
  readonly mode = 'slack-admin-api';
  private readonly token: string;
  private readonly teamId: string;

  constructor(token: string, teamId: string) {
    this.token = token;
    this.teamId = teamId;
  }

  capability(): InviteCapability {
    return { automated: true, method: 'slack-admin-api', explanation: 'admin.users.invite (Enterprise org admin token). Unverified in this demo.' };
  }

  async inviteToWorkspace(input: { email: string; caseId: string; channelIds: string[] }): Promise<InviteResult> {
    if (input.channelIds.length === 0) return { outcome: 'failed', error: 'admin.users.invite requires at least one channel id' };
    const res = await fetch('https://slack.com/api/admin.users.invite', {
      method: 'POST',
      headers: { authorization: `Bearer ${this.token}`, 'content-type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ team_id: this.teamId, email: input.email, channel_ids: input.channelIds.join(',') }),
      signal: AbortSignal.timeout(15000),
    });
    const json = (await res.json()) as { ok: boolean; error?: string };
    return json.ok ? { outcome: 'sent', reference: `admin.users.invite:${input.email}` } : { outcome: 'failed', error: json.error ?? `HTTP ${res.status}` };
  }
}
