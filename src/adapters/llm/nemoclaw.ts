import { agentTurn } from '../nemoclaw-cli.ts';
import type { ChatMessage, LlmAdapter } from '../../types.ts';

// Inference through the event's NemoClaw runtime: one OpenClaw agent (`gb10-agent`,
// Qwen on the GB10) with an isolated session per case. Runs on the GB10 host.
// Output is untrusted text; callers validate it.
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
    const turn = await agentTurn({ bin: this.bin, sandbox: this.sandbox, session: options.sessionKey ?? 'onboarding-general', prompt, timeoutMs: this.timeoutMs });
    this.model = `gb10-agent → ${turn.model}`;
    return turn.text;
  }
}
