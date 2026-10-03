import { assertLocalEndpoint } from '../../config.ts';
import type { ChatMessage, LlmAdapter } from '../../types.ts';

// LOCAL inference only: an OpenAI-compatible server on the GB10 (vLLM serving
// Nemotron Nano / Qwen, or the OpenClaw gateway's /v1/chat/completions).
// There is deliberately no cloud fallback: a failure surfaces as an error and the
// workflow routes the case to manual review.
export class OpenAiCompatibleLlm implements LlmAdapter {
  readonly mode = 'openai-compatible';
  readonly model: string;
  private readonly baseUrl: string;
  private readonly apiKey?: string;
  private readonly timeoutMs: number;
  private readonly disableThinking: boolean;

  constructor(opts: { baseUrl: string; model: string; apiKey?: string; timeoutMs: number; disableThinking?: boolean }) {
    assertLocalEndpoint(opts.baseUrl);
    this.baseUrl = opts.baseUrl.replace(/\/$/, '');
    this.model = opts.model;
    this.apiKey = opts.apiKey;
    this.timeoutMs = opts.timeoutMs;
    this.disableThinking = opts.disableThinking ?? false;
  }

  async complete(messages: ChatMessage[], options: { jsonSchema?: object; sessionKey?: string }): Promise<string> {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (this.apiKey) headers.authorization = `Bearer ${this.apiKey}`;
    // One runtime, isolated per-worker sessions: OpenClaw derives the session from this key.
    if (options.sessionKey) headers['x-openclaw-session-key'] = options.sessionKey;
    const body: Record<string, unknown> = { model: this.model, messages, temperature: 0, max_tokens: 1500 };
    if (options.sessionKey) body.user = options.sessionKey;
    // vLLM chat-template switch for reasoning models (Nemotron/Qwen): skip the thinking phase.
    if (this.disableThinking) body.chat_template_kwargs = { enable_thinking: false };
    if (options.jsonSchema) body.response_format = { type: 'json_schema', json_schema: { name: 'extraction', schema: options.jsonSchema } };
    const res = await fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!res.ok) throw new Error(`local model endpoint returned HTTP ${res.status}`);
    const json = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    const content = json.choices?.[0]?.message?.content;
    if (typeof content !== 'string') throw new Error('local model returned no message content');
    return content;
  }
}
