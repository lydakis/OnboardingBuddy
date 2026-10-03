import type { ChatMessage, LlmAdapter } from '../../types.ts';

export type MockResponder = (messages: ChatMessage[]) => string;

// MOCK model: deterministic, no network. The responder is supplied by the caller
// (phase 2 plugs in a heuristic extractor) so outputs still go through the same
// validation as real model output.
export class MockLlm implements LlmAdapter {
  readonly mode = 'mock';
  readonly model = 'mock-heuristic-v1';
  private readonly responder: MockResponder;
  calls = 0;

  constructor(responder: MockResponder) {
    this.responder = responder;
  }

  async complete(messages: ChatMessage[]): Promise<string> {
    this.calls++;
    return this.responder(messages);
  }
}
