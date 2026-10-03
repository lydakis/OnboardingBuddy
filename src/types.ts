// Shared domain and adapter contracts. Both workstreams code against this file;
// change it only by agreement.

export type CaseStatus =
  | 'intake' // welcome sent, waiting for CV + questionnaire
  | 'intake_complete' // every checklist item complete
  | 'plan_proposed' // plan waiting for manager decision
  | 'plan_approved'
  | 'plan_sent' // approved plan emailed to worker
  | 'slack_invited'
  | 'slack_joined'
  | 'questionnaire' // answering the tailored questions in a Slack DM
  | 'questionnaire_complete'
  | 'training'
  | 'training_complete';

export type ChecklistStatus = 'missing' | 'complete' | 'needs_review';

export interface CaseRow {
  id: string;
  worker_name: string;
  worker_email: string;
  manager_slack_id: string;
  status: CaseStatus;
  email_thread_id: string | null;
  slack_user_id: string | null;
  needs_attention: string | null;
  created_at: string;
  updated_at: string;
}

export interface ChecklistItemRow {
  case_id: string;
  key: string;
  label: string;
  status: ChecklistStatus;
  value: string | null;
  excerpt: string | null;
  note: string | null;
  source_message_id: string | null;
  completed_at: string | null;
  updated_at: string;
}

export interface OutboxRow {
  action_key: string;
  case_id: string | null;
  channel: 'email' | 'slack';
  kind: string;
  recipient: string;
  summary: string;
  status: 'pending' | 'sent' | 'uncertain' | 'failed';
  provider_message_id: string | null;
  thread_id: string | null;
  error: string | null;
  created_at: string;
  updated_at: string;
}

// ---- Email adapter -------------------------------------------------------

export interface EmailAttachment {
  filename: string;
  contentType: string;
  /** Extracted text. Binary formats we cannot read arrive with text undefined. */
  text?: string;
}

export interface OutboundEmail {
  to: string;
  subject: string;
  text: string;
  /** Provider message id we are replying to, so the provider threads the reply. */
  replyToProviderMessageId?: string;
  /** Stable key; adapters that support idempotency forward it to the provider. */
  idempotencyKey: string;
}

export interface SentEmail {
  providerMessageId: string;
  threadId: string;
}

export interface InboundEmail {
  providerMessageId: string;
  threadId?: string;
  inReplyTo?: string;
  references?: string[];
  from: string;
  to: string;
  subject: string;
  text: string;
  attachments: EmailAttachment[];
  receivedAt: string;
}

/** Thrown when the provider definitely rejected a send, so a retry is safe. */
export class DefiniteSendFailure extends Error {}

export interface EmailAdapter {
  readonly mode: string;
  send(message: OutboundEmail): Promise<SentEmail>;
  /** Returns inbound messages not yet acknowledged. The engine dedupes regardless. */
  poll(): Promise<InboundEmail[]>;
  acknowledge(providerMessageId: string): Promise<void>;
  /** Puts a message back in the unread queue so the next poll processes it again. */
  requeue(providerMessageId: string): Promise<void>;
}

// ---- Slack adapter -------------------------------------------------------

export interface SlackButton {
  text: string;
  /** Command line the button runs, e.g. "approve CASE-1 v2". */
  command: string;
  style?: 'primary' | 'danger';
}

export interface SlackButtonRow {
  label: string;
  buttons: SlackButton[];
}

export interface SlackPost {
  /** Channel id/name or a user id for a DM. */
  channel: string;
  text: string;
  buttons?: SlackButton[];
  /** Labelled rows of buttons (e.g. 1–5 ratings), rendered after `buttons`. */
  rows?: SlackButtonRow[];
  idempotencyKey: string;
}

export interface SlackUser {
  id: string;
  email?: string;
  realName?: string;
  isBot?: boolean;
  deleted?: boolean;
}

export interface SlackAdapter {
  readonly mode: string;
  post(message: SlackPost): Promise<{ ts: string; channel?: string }>;
  /** chat.update: replace an earlier bot message in place (used to swap a "thinking" placeholder for the answer). */
  update(channel: string, ts: string, text: string, buttons?: SlackButton[]): Promise<void>;
  lookupUserByEmail(email: string): Promise<SlackUser | null>;
  findUsersByName(name: string): Promise<SlackUser[]>;
  /** Downloads a file shared with the bot (Slack: url_private_download, needs files:read). */
  downloadFile(url: string): Promise<Buffer>;
  /** conversations.invite: add an EXISTING workspace member to a channel. */
  addToChannel(channel: string, userId: string): Promise<void>;
}

/** A manager command arriving from Slack (slash command, button, or mock CLI). */
export interface SlackCommandEvent {
  eventId: string;
  userId: string;
  channel: string;
  text: string;
}

export interface SlackTeamJoinEvent {
  eventId: string;
  user: SlackUser;
}

// ---- Model adapter -------------------------------------------------------

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface LlmAdapter {
  readonly mode: string;
  readonly model: string;
  /** Returns the raw assistant text. Callers validate it before using it. */
  complete(messages: ChatMessage[], options: { jsonSchema?: object; sessionKey?: string }): Promise<string>;
}

// ---- Workspace invitation adapter ---------------------------------------

export interface InviteCapability {
  automated: boolean;
  method: 'mock' | 'manual' | 'slack-admin-api';
  explanation: string;
}

export type InviteResult =
  | { outcome: 'sent'; reference: string }
  | { outcome: 'manual_required'; instructions: string }
  | { outcome: 'failed'; error: string };

export interface InviteAdapter {
  readonly mode: string;
  capability(): InviteCapability;
  inviteToWorkspace(input: { email: string; caseId: string; channelIds: string[] }): Promise<InviteResult>;
}

export interface Adapters {
  email: EmailAdapter;
  slack: SlackAdapter;
  llm: LlmAdapter;
  invite: InviteAdapter;
  /** Tool-using agent inside the NemoClaw/OpenShell sandbox (see src/adapters/sandbox). */
  sandbox?: import('./adapters/sandbox/types.ts').SandboxAgent;
}
