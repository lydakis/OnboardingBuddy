// SQLite schema. Every worker-owned row carries case_id and every query in the
// store is scoped by it, which is how worker data stays separate.

export const SCHEMA_VERSION = 1;

export const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS cases (
  id TEXT PRIMARY KEY,
  worker_name TEXT NOT NULL,
  worker_email TEXT NOT NULL,
  manager_slack_id TEXT NOT NULL,
  status TEXT NOT NULL,
  email_thread_id TEXT,
  slack_user_id TEXT,
  needs_attention TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS cases_email ON cases(worker_email);

CREATE TABLE IF NOT EXISTS checklist_items (
  case_id TEXT NOT NULL REFERENCES cases(id),
  key TEXT NOT NULL,
  label TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('missing','complete','needs_review')),
  value TEXT,
  excerpt TEXT,
  note TEXT,
  source_message_id TEXT,
  completed_at TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (case_id, key)
);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  case_id TEXT REFERENCES cases(id),
  channel TEXT NOT NULL,
  direction TEXT NOT NULL CHECK (direction IN ('in','out')),
  provider_message_id TEXT NOT NULL,
  thread_id TEXT,
  in_reply_to TEXT,
  from_addr TEXT,
  to_addr TEXT,
  subject TEXT,
  body TEXT,
  correlation TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (channel, direction, provider_message_id)
);

CREATE TABLE IF NOT EXISTS documents (
  id TEXT PRIMARY KEY,
  case_id TEXT NOT NULL REFERENCES cases(id),
  kind TEXT NOT NULL,
  filename TEXT NOT NULL,
  content_type TEXT,
  content_text TEXT,
  source_message_id TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS processed_events (
  event_key TEXT PRIMARY KEY,
  case_id TEXT,
  outcome TEXT NOT NULL,
  processed_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS outbox (
  action_key TEXT PRIMARY KEY,
  case_id TEXT,
  channel TEXT NOT NULL,
  kind TEXT NOT NULL,
  recipient TEXT NOT NULL,
  summary TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending','sent','uncertain','failed')),
  provider_message_id TEXT,
  thread_id TEXT,
  error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS extractions (
  id TEXT PRIMARY KEY,
  case_id TEXT NOT NULL REFERENCES cases(id),
  kind TEXT NOT NULL,
  model TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('accepted','rejected')),
  output_json TEXT,
  errors TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS plans (
  id TEXT PRIMARY KEY,
  case_id TEXT NOT NULL REFERENCES cases(id),
  version INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('proposed','needs_review','approved','superseded','sent')),
  content_json TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (case_id, version)
);

CREATE TABLE IF NOT EXISTS approvals (
  id TEXT PRIMARY KEY,
  case_id TEXT NOT NULL REFERENCES cases(id),
  subject_type TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  subject_hash TEXT,
  decision TEXT NOT NULL CHECK (decision IN ('approved','revision_requested','rejected')),
  manager_slack_id TEXT NOT NULL,
  note TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS invitations (
  case_id TEXT PRIMARY KEY REFERENCES cases(id),
  state TEXT NOT NULL,
  method TEXT,
  email TEXT NOT NULL,
  requested_by TEXT,
  requested_at TEXT,
  sent_at TEXT,
  confirmed_at TEXT,
  welcomed_at TEXT,
  slack_user_id TEXT,
  review_reason TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS training_tasks (
  id TEXT PRIMARY KEY,
  case_id TEXT NOT NULL REFERENCES cases(id),
  plan_version INTEGER NOT NULL,
  module_id TEXT NOT NULL,
  title TEXT NOT NULL,
  day INTEGER NOT NULL,
  evidence_required TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending','delivered','done','escalated')),
  delivered_at TEXT,
  completed_at TEXT,
  evidence TEXT,
  escalation_reason TEXT,
  updated_at TEXT NOT NULL,
  UNIQUE (case_id, module_id)
);

CREATE TABLE IF NOT EXISTS agent_runs (
  id TEXT PRIMARY KEY,
  case_id TEXT,
  purpose TEXT NOT NULL,
  session_key TEXT NOT NULL,
  mode TEXT NOT NULL,
  model TEXT NOT NULL,
  tools TEXT NOT NULL,
  tool_calls INTEGER NOT NULL,
  tool_failures INTEGER NOT NULL,
  duration_ms INTEGER NOT NULL,
  fallback_used INTEGER NOT NULL,
  warnings TEXT,
  outcome TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS rosters (
  id TEXT PRIMARY KEY,
  manager_slack_id TEXT NOT NULL,
  filename TEXT NOT NULL,
  table_text TEXT NOT NULL,
  people_json TEXT,
  review_json TEXT,
  status TEXT NOT NULL CHECK (status IN ('extracted','failed','started','cancelled')),
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS case_senders (
  case_id TEXT NOT NULL REFERENCES cases(id),
  address TEXT NOT NULL,
  approved_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (case_id, address)
);

CREATE TABLE IF NOT EXISTS questionnaire_items (
  case_id TEXT NOT NULL REFERENCES cases(id),
  seq INTEGER NOT NULL,
  field TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('confirm','number_text','enum','ratings','text')),
  prompt TEXT NOT NULL,
  options_json TEXT,
  status TEXT NOT NULL CHECK (status IN ('pending','asked','answered')),
  answer_raw TEXT,
  answer_value_json TEXT,
  excerpt TEXT,
  nudges INTEGER NOT NULL DEFAULT 0,
  answered_at TEXT,
  slack_ts TEXT,
  PRIMARY KEY (case_id, seq)
);

CREATE TABLE IF NOT EXISTS feature_snapshots (
  case_id TEXT NOT NULL REFERENCES cases(id),
  version INTEGER NOT NULL,
  policy_id TEXT NOT NULL,
  reason TEXT NOT NULL,
  json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (case_id, version)
);

CREATE TABLE IF NOT EXISTS audit_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  case_id TEXT,
  at TEXT NOT NULL,
  actor TEXT NOT NULL,
  type TEXT NOT NULL,
  detail TEXT
);
CREATE INDEX IF NOT EXISTS audit_case ON audit_events(case_id);
`;
