import type { InviteAdapter, InviteCapability, InviteResult } from '../../types.ts';

// Manual-admin fallback. Slack has no API that lets a normal bot token invite a new
// person to a workspace (admin.users.invite is Enterprise-only, see
// docs/INTEGRATION-RESEARCH.md), so a human admin sends the invite and then
// records it with `/onboard invite-sent <case>`.
export class ManualInviteAdapter implements InviteAdapter {
  readonly mode = 'manual';

  capability(): InviteCapability {
    return {
      automated: false,
      method: 'manual',
      explanation: 'Automated workspace invites need an Enterprise org admin token. A Slack admin must invite the worker manually.',
    };
  }

  async inviteToWorkspace(input: { email: string; caseId: string }): Promise<InviteResult> {
    return {
      outcome: 'manual_required',
      instructions: `A Slack admin should invite ${input.email} (Slack → Invite people to the workspace), then run \`/onboard invite-sent ${input.caseId}\`.`,
    };
  }
}
