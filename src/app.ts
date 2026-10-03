import type { Config } from './config.ts';
import { Store, openDatabase } from './db/store.ts';
import type { EngineContext } from './engine/context.ts';
import { MockEmailAdapter } from './adapters/email/mock.ts';
import { MockSlackAdapter } from './adapters/slack/mock.ts';
import { MockLlm } from './adapters/llm/mock.ts';
import { OpenAiCompatibleLlm } from './adapters/llm/openai-compatible.ts';
import { MockInviteAdapter } from './adapters/invite/mock.ts';
import { ManualInviteAdapter } from './adapters/invite/manual.ts';
import { SlackAdminInviteAdapter } from './adapters/invite/slack-admin.ts';
import { heuristicResponder } from './engine/extract.ts';
import type { EmailAdapter, InviteAdapter, LlmAdapter, SlackAdapter } from './types.ts';
import './engine/register.ts';

export interface App extends EngineContext {
  mocks: { email?: MockEmailAdapter; slack?: MockSlackAdapter; llm?: MockLlm; invite?: MockInviteAdapter };
  close(): void;
}

/** Wires config → adapters → engine context. Live adapters are loaded lazily so mock mode needs no extra deps. */
export async function createApp(config: Config): Promise<App> {
  const db = openDatabase(config.dbPath);
  const store = new Store(db);
  const recovered = store.markStalePendingUncertain();
  if (recovered > 0) store.audit(null, 'system', 'recovered_pending_sends', { count: recovered });

  const mocks: App['mocks'] = {};
  let email: EmailAdapter;
  if (config.email.mode === 'mock') email = mocks.email = new MockEmailAdapter(db, config.email.fromAddress);
  else {
    const { AgentMailAdapter } = await import('./adapters/email/agentmail.ts');
    email = new AgentMailAdapter({ apiKey: config.email.agentmailApiKey!, inboxId: config.email.agentmailInboxId!, baseUrl: config.email.agentmailBaseUrl });
  }

  let slack: SlackAdapter;
  if (config.slack.mode === 'mock') slack = mocks.slack = new MockSlackAdapter(db);
  else {
    const { SlackWebAdapter } = await import('./adapters/slack/web.ts');
    slack = new SlackWebAdapter(config.slack.botToken!);
  }

  let llm: LlmAdapter;
  if (config.llm.mode === 'mock') llm = mocks.llm = new MockLlm(heuristicResponder);
  else if (config.llm.mode === 'nemoclaw') {
    const { NemoClawAgentLlm } = await import('./adapters/llm/nemoclaw.ts');
    llm = new NemoClawAgentLlm({ sandbox: config.llm.nemoclawSandbox, timeoutMs: config.llm.timeoutMs });
  } else llm = new OpenAiCompatibleLlm({ baseUrl: config.llm.baseUrl!, model: config.llm.model!, apiKey: config.llm.apiKey, timeoutMs: config.llm.timeoutMs, disableThinking: config.llm.disableThinking });

  let invite: InviteAdapter;
  if (config.invite.mode === 'mock') invite = mocks.invite = new MockInviteAdapter();
  else if (config.invite.mode === 'manual') invite = new ManualInviteAdapter();
  else invite = new SlackAdminInviteAdapter(config.invite.adminUserToken!, config.invite.teamId!);

  return { store, config, adapters: { email, slack, llm, invite }, mocks, close: () => db.close() };
}
