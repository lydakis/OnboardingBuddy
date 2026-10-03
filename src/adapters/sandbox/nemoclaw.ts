import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { agentTurn, runCli } from '../nemoclaw-cli.ts';
import type { AgentTurn } from '../nemoclaw-cli.ts';
import type { SandboxAgent, SandboxPurpose } from './types.ts';
import type { Snapshot } from '../../engine/snapshot.ts';

const TOOLS = fileURLToPath(new URL('../../../openclaw/skills/onboarding-buddy/tools/onboarding-tools.mjs', import.meta.url));

// LIVE: uploads the tools and a scoped snapshot into the gb10-agent sandbox, then runs one
// OpenClaw turn that calls them with its exec tool. The sandbox has no egress and no
// business credentials; the host validates whatever comes back.
export class NemoClawSandboxAgent implements SandboxAgent {
  readonly mode = 'nemoclaw';
  private readonly sandbox: string;
  private readonly bin: string;
  private readonly timeoutMs: number;
  private toolsUploaded = false;
  /** Last uploaded snapshot per scope; skip the upload when nothing changed. */
  private readonly uploaded = new Map<string, string>();

  constructor(opts: { sandbox: string; bin?: string; timeoutMs: number }) {
    this.sandbox = opts.sandbox;
    this.bin = opts.bin ?? 'nemoclaw';
    this.timeoutMs = opts.timeoutMs;
  }

  private async upload(local: string, remote: string): Promise<void> {
    const r = await runCli(this.bin, [this.sandbox, 'upload', local, remote], 60000);
    if (r.code !== 0) throw new Error(`nemoclaw upload ${remote} failed: ${(r.stderr || r.stdout).slice(-200)}`);
  }

  async run(input: { purpose: SandboxPurpose; dataDir: string; snapshot: Snapshot; sessionKey: string; prompt: string }): Promise<AgentTurn> {
    if (!this.toolsUploaded) {
      await this.upload(TOOLS, '/sandbox/onboarding/tools/onboarding-tools.mjs');
      this.toolsUploaded = true;
    }
    const { generatedAt: _ignored, ...stable } = input.snapshot;
    const hash = createHash('sha256').update(JSON.stringify(stable)).digest('hex');
    if (this.uploaded.get(input.dataDir) !== hash) {
      const tmp = mkdtempSync(join(tmpdir(), 'obuddy-snap-'));
      const file = join(tmp, 'snapshot.json');
      writeFileSync(file, JSON.stringify(input.snapshot), { mode: 0o600 });
      await this.upload(file, `/sandbox/onboarding/${input.dataDir}/snapshot.json`);
      rmSync(tmp, { recursive: true, force: true });
      this.uploaded.set(input.dataDir, hash);
    }
    return agentTurn({ bin: this.bin, sandbox: this.sandbox, session: input.sessionKey, prompt: input.prompt, timeoutMs: this.timeoutMs });
  }
}
