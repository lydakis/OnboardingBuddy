// Runs a task with the tool-using agent inside the NemoClaw/OpenShell sandbox and logs
// every run (model, tools, duration, fallback) for the status page.
import type { EngineContext } from './context.ts';
import { buildSnapshot, scopeDir } from './snapshot.ts';
import type { SnapshotScope } from './snapshot.ts';
import type { SandboxPurpose } from '../adapters/sandbox/types.ts';
import type { AgentTurn } from '../adapters/nemoclaw-cli.ts';
import { newId, now } from '../db/store.ts';

export const TOOL_CMD = 'node /sandbox/onboarding/tools/onboarding-tools.mjs';

export async function runSandboxTask(
  ctx: EngineContext,
  input: { purpose: SandboxPurpose; scope: SnapshotScope; caseId: string | null; sessionKey: string; prompt: (dataPath: string) => string },
  accept: (turn: AgentTurn) => boolean,
): Promise<AgentTurn> {
  const agent = ctx.adapters.sandbox;
  if (!agent) throw new Error('sandbox agent is off (OB_SANDBOX_MODE=off)');
  const dataDir = scopeDir(input.scope);
  const started = Date.now();
  const log = (turn: Partial<AgentTurn>, outcome: string) =>
    ctx.store.db
      .prepare('INSERT INTO agent_runs (id, case_id, purpose, session_key, mode, model, tools, tool_calls, tool_failures, duration_ms, fallback_used, warnings, outcome, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(newId('run'), input.caseId, input.purpose, input.sessionKey, agent.mode, turn.model ?? 'unknown', JSON.stringify(turn.tools ?? []), turn.toolCalls ?? 0, turn.toolFailures ?? 0, turn.durationMs || Date.now() - started, turn.fallbackUsed ? 1 : 0, JSON.stringify(turn.warnings ?? []), outcome, now());
  try {
    const turn = await agent.run({
      purpose: input.purpose,
      dataDir,
      snapshot: buildSnapshot(ctx, input.scope),
      sessionKey: input.sessionKey,
      prompt: input.prompt(`/sandbox/onboarding/${dataDir}`),
    });
    log(turn, accept(turn) ? 'accepted' : 'rejected');
    return turn;
  } catch (err) {
    log({ warnings: [err instanceof Error ? err.message : String(err)] }, 'error');
    throw err;
  }
}

export function agentRuns(ctx: EngineContext, limit = 30): Record<string, unknown>[] {
  return ctx.store.db.prepare('SELECT * FROM agent_runs ORDER BY created_at DESC LIMIT ?').all(limit) as Record<string, unknown>[];
}
