import { execFile } from 'node:child_process';
import type { ChatMessage, LlmAdapter } from '../../types.ts';

// Inference through the event's NemoClaw runtime: one OpenClaw agent (`gb10-agent`,
// Qwen on the GB10) with an isolated session per case, via
//   nemoclaw <sandbox> agent --session-id <case session> --json -m <prompt>
// Runs on the GB10 host. Output is untrusted text; callers validate it.
export class NemoClawAgentLlm implements LlmAdapter {
  readonly mode = 'nemoclaw';
  model = 'gb10-agent (OpenClaw)';
  private readonly sandbox: string;
  private readonly bin: string;
  private readonly timeoutMs: number;

  constructor(opts: { sandbox: string; bin?: string; timeoutMs: number }) {
    this.sandbox = opts.sandbox;
    this.bin = opts.bin ?? 'nemoclaw';
    this.timeoutMs = opts.timeoutMs;
  }

  async complete(messages: ChatMessage[], options: { jsonSchema?: object; sessionKey?: string }): Promise<string> {
    const prompt = [
      ...messages.map((m) => (m.role === 'system' ? m.content : `${m.role.toUpperCase()}:\n${m.content}`)),
      options.jsonSchema ? 'Respond with the JSON object only. Do not call any tools.' : 'Do not call any tools.',
    ].join('\n\n');
    const session = (options.sessionKey ?? 'onboarding-general').replace(/[^A-Za-z0-9_-]/g, '-');
    const stdout = await new Promise<string>((resolve, reject) => {
      execFile(
        this.bin,
        [this.sandbox, 'agent', '--session-id', session, '--json', '-m', prompt],
        { timeout: this.timeoutMs, maxBuffer: 20 * 1024 * 1024 },
        (err, out, errOut) => (err ? reject(new Error(`nemoclaw agent failed: ${err.message.split('\n')[0]} ${String(errOut).slice(0, 200)}`)) : resolve(out)),
      );
    });
    const start = stdout.search(/^\{/m);
    if (start < 0) throw new Error('nemoclaw agent returned no JSON');
    const run = JSON.parse(stdout.slice(start)) as {
      status?: string;
      result?: { payloads?: { text?: string }[]; meta?: { agentMeta?: { model?: string } } };
    };
    if (run.status !== 'ok') throw new Error(`nemoclaw agent run status ${run.status ?? 'unknown'}`);
    const model = run.result?.meta?.agentMeta?.model;
    if (model) this.model = `gb10-agent → ${model}`;
    const text = (run.result?.payloads ?? []).map((p) => p.text ?? '').join('\n').trim();
    if (!text) throw new Error('nemoclaw agent returned an empty reply');
    return text;
  }
}
