import type { InviteAdapter, InviteCapability, InviteResult } from '../../types.ts';

// MOCK workspace invitation. "Sent" only means the invitation left; it never
// creates a Slack member. Membership must be observed separately (team_join).
export class MockInviteAdapter implements InviteAdapter {
  readonly mode = 'mock';
  sent: { email: string; caseId: string }[] = [];

  capability(): InviteCapability {
    return { automated: true, method: 'mock', explanation: 'Simulated invite. No real Slack workspace is touched.' };
  }

  async inviteToWorkspace(input: { email: string; caseId: string }): Promise<InviteResult> {
    this.sent.push({ email: input.email, caseId: input.caseId });
    return { outcome: 'sent', reference: `mock-invite-${this.sent.length}` };
  }
}
