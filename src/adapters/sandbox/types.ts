import type { AgentTurn } from '../nemoclaw-cli.ts';
import type { Snapshot } from '../../engine/snapshot.ts';

export type SandboxPurpose = 'manager_chat' | 'day1_quiz';

/** An agent that works inside the NemoClaw/OpenShell sandbox using our read-only business tools. */
export interface SandboxAgent {
  readonly mode: string;
  run(input: { purpose: SandboxPurpose; dataDir: string; snapshot: Snapshot; sessionKey: string; prompt: string }): Promise<AgentTurn>;
}
