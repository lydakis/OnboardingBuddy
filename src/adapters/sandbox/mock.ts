import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AgentTurn } from '../nemoclaw-cli.ts';
import type { SandboxAgent, SandboxPurpose } from './types.ts';
import type { Snapshot } from '../../engine/snapshot.ts';

const TOOLS = fileURLToPath(new URL('../../../openclaw/skills/onboarding-buddy/tools/onboarding-tools.mjs', import.meta.url));

// MOCK sandbox agent: runs the REAL tools script locally against the snapshot, with a
// scripted "agent" deciding which tools to call. Exercises the same tools and validation.
export class MockSandboxAgent implements SandboxAgent {
  readonly mode = 'mock';
  runs: { purpose: SandboxPurpose; tools: string[] }[] = [];

  async run(input: { purpose: SandboxPurpose; dataDir: string; snapshot: Snapshot; sessionKey: string; prompt: string }): Promise<AgentTurn> {
    const dir = mkdtempSync(join(tmpdir(), `obuddy-${input.dataDir}-`));
    writeFileSync(join(dir, 'snapshot.json'), JSON.stringify(input.snapshot));
    const tool = (...args: string[]) => JSON.parse(execFileSync(process.execPath, [TOOLS, '--data', dir, ...args], { encoding: 'utf8' }));
    const called: string[] = [];
    let text: string;
    if (input.purpose === 'day1_quiz') {
      const caseId = input.snapshot.cases[0]!.id;
      const plan = tool('plan', caseId) as { modules: { id: string; title: string; days: number[]; evidenceRequired: string }[] };
      called.push('plan');
      const day1 = plan.modules.filter((m) => m.days.includes(1));
      const questions = day1.flatMap((m) => [
        { module: m.id, question: `Which module covers "${m.title}" on day 1?`, options: [m.id, 'ROUTE-999', 'NONE'], answer: 0 },
        { module: m.id, question: `What evidence completes ${m.id}?`, options: [m.evidenceRequired, 'Nothing', 'A selfie'], answer: 0 },
      ]).slice(0, 6);
      const quiz = { title: 'Day 1 check-in', questions };
      const qf = join(dir, 'quiz.json');
      writeFileSync(qf, JSON.stringify(quiz));
      tool('quiz-check', qf);
      called.push('quiz-check');
      text = JSON.stringify(quiz);
    } else {
      const blockers = tool('blockers') as { case: string; issue: string }[];
      const cases = tool('cases') as { id: string; worker: string; status: string }[];
      called.push('blockers', 'cases');
      const reply = blockers.length
        ? `${blockers.length} item(s) need you:\n${blockers.map((b) => `• ${b.case}: ${b.issue}`).join('\n')}`
        : `All ${cases.length} case(s) are moving: ${cases.map((c) => `${c.id} ${c.status}`).join(', ')}.`;
      const first = blockers[0];
      text = JSON.stringify({ reply, suggested_command: first ? `status ${first.case}` : null });
    }
    this.runs.push({ purpose: input.purpose, tools: called });
    return { text, model: 'mock-sandbox-agent', toolCalls: called.length, tools: ['exec'], toolFailures: 0, durationMs: 0, fallbackUsed: false, warnings: [] };
  }
}
