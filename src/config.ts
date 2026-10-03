// Runtime configuration. Everything comes from environment variables so the same
// build runs in mock mode on a laptop and in live mode on the GB10.
// Secrets are read here and never written to the database, logs or status page.

export type AdapterMode = 'mock' | 'live';

export interface Config {
  dbPath: string;
  statusPort: number;
  statusHost: string;
  companyName: string;
  managerSlackIds: string[];
  /** Live mode only emails/invites these addresses. Empty list = nobody. */
  liveRecipientAllowlist: string[];
  newHireChannel: string;
  email: {
    mode: 'mock' | 'agentmail';
    fromAddress: string;
    agentmailApiKey?: string;
    agentmailInboxId?: string;
    agentmailBaseUrl: string;
    pollIntervalMs: number;
  };
  slack: {
    mode: 'mock' | 'socket';
    botToken?: string;
    appToken?: string;
  };
  llm: {
    mode: 'mock' | 'openai-compatible' | 'nemoclaw';
    nemoclawSandbox: string;
    baseUrl?: string;
    model?: string;
    apiKey?: string;
    timeoutMs: number;
    disableThinking: boolean;
  };
  invite: {
    mode: 'mock' | 'manual' | 'slack-admin-api';
    adminUserToken?: string;
    teamId?: string;
  };
  readiness: {
    requireIntakeComplete: boolean;
    requirePlanSent: boolean;
  };
}

function list(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function oneOf<T extends string>(name: string, value: string | undefined, allowed: readonly T[], fallback: T): T {
  if (value === undefined || value === '') return fallback;
  if ((allowed as readonly string[]).includes(value)) return value as T;
  throw new Error(`${name} must be one of ${allowed.join(', ')} (got "${value}")`);
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const config: Config = {
    dbPath: env.OB_DB_PATH ?? 'data/onboarding.db',
    statusPort: Number(env.OB_STATUS_PORT ?? 4600),
    statusHost: env.OB_STATUS_HOST ?? '127.0.0.1',
    companyName: env.OB_COMPANY_NAME ?? 'Fleetwing Express (fictional, FedEx-inspired demo)',
    managerSlackIds: list(env.OB_MANAGER_SLACK_IDS ?? 'U_MGR_DANA'),
    liveRecipientAllowlist: list(env.OB_LIVE_RECIPIENT_ALLOWLIST).map((e) => e.toLowerCase()),
    newHireChannel: env.OB_NEW_HIRE_CHANNEL ?? '#new-couriers',
    email: {
      mode: oneOf('OB_EMAIL_MODE', env.OB_EMAIL_MODE, ['mock', 'agentmail'] as const, 'mock'),
      fromAddress: env.OB_EMAIL_FROM ?? 'onboarding@fleetwing.example',
      agentmailApiKey: env.AGENTMAIL_API_KEY || undefined,
      agentmailInboxId: env.AGENTMAIL_INBOX_ID || undefined,
      agentmailBaseUrl: env.AGENTMAIL_BASE_URL ?? 'https://api.agentmail.to/v0',
      pollIntervalMs: Number(env.OB_EMAIL_POLL_MS ?? 15000),
    },
    slack: {
      mode: oneOf('OB_SLACK_MODE', env.OB_SLACK_MODE, ['mock', 'socket'] as const, 'mock'),
      botToken: env.SLACK_BOT_TOKEN || undefined,
      appToken: env.SLACK_APP_TOKEN || undefined,
    },
    llm: {
      mode: oneOf('OB_LLM_MODE', env.OB_LLM_MODE, ['mock', 'openai-compatible', 'nemoclaw'] as const, 'mock'),
      nemoclawSandbox: env.OB_NEMOCLAW_SANDBOX ?? 'gb10-agent',
      baseUrl: env.OB_LLM_BASE_URL || undefined,
      model: env.OB_LLM_MODEL || undefined,
      apiKey: env.OB_LLM_API_KEY || undefined,
      timeoutMs: Number(env.OB_LLM_TIMEOUT_MS ?? 180000),
      disableThinking: env.OB_LLM_DISABLE_THINKING === 'true',
    },
    invite: {
      mode: oneOf('OB_INVITE_MODE', env.OB_INVITE_MODE, ['mock', 'manual', 'slack-admin-api'] as const, 'mock'),
      adminUserToken: env.SLACK_ADMIN_USER_TOKEN || undefined,
      teamId: env.SLACK_TEAM_ID || undefined,
    },
    readiness: {
      requireIntakeComplete: env.OB_READY_REQUIRE_INTAKE !== 'false',
      requirePlanSent: env.OB_READY_REQUIRE_PLAN_SENT !== 'false',
    },
  };
  validateConfig(config);
  return config;
}

export function validateConfig(config: Config): void {
  if (config.llm.mode === 'openai-compatible') {
    if (!config.llm.baseUrl || !config.llm.model) {
      throw new Error('OB_LLM_BASE_URL and OB_LLM_MODEL are required when OB_LLM_MODE=openai-compatible');
    }
    assertLocalEndpoint(config.llm.baseUrl);
  }
  if (config.email.mode === 'agentmail' && (!config.email.agentmailApiKey || !config.email.agentmailInboxId)) {
    throw new Error('AGENTMAIL_API_KEY and AGENTMAIL_INBOX_ID are required when OB_EMAIL_MODE=agentmail');
  }
  if (config.slack.mode === 'socket' && (!config.slack.botToken || !config.slack.appToken)) {
    throw new Error('SLACK_BOT_TOKEN and SLACK_APP_TOKEN are required when OB_SLACK_MODE=socket');
  }
  if (config.invite.mode === 'slack-admin-api' && (!config.invite.adminUserToken || !config.invite.teamId)) {
    throw new Error('SLACK_ADMIN_USER_TOKEN and SLACK_TEAM_ID are required when OB_INVITE_MODE=slack-admin-api');
  }
}

// Inference must stay on the GB10: loopback (an SSH tunnel or a process on the GB10 itself),
// private LAN ranges, or the Tailscale tailnet. Anything else is refused so there is no
// accidental cloud fallback.
export function assertLocalEndpoint(rawUrl: string): void {
  const url = new URL(rawUrl);
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const ok =
    host === 'localhost' ||
    host === '::1' ||
    /^127\./.test(host) ||
    /^10\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host) ||
    /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(host) ||
    host.endsWith('.ts.net') ||
    host.endsWith('.local') ||
    host === 'host.openshell.internal';
  if (!ok) {
    throw new Error(`Refusing non-local inference endpoint "${host}". Point OB_LLM_BASE_URL at the GB10.`);
  }
}

export function describeModes(config: Config): Record<string, string> {
  return {
    email: config.email.mode === 'mock' ? 'MOCK (deterministic in-database mailbox)' : 'LIVE AgentMail (unverified)',
    slack: config.slack.mode === 'mock' ? 'MOCK (deterministic in-database workspace)' : 'LIVE Socket Mode (unverified)',
    llm:
      config.llm.mode === 'mock'
        ? 'MOCK (deterministic heuristic extractor)'
        : config.llm.mode === 'nemoclaw'
          ? `LOCAL NemoClaw sandbox ${config.llm.nemoclawSandbox} (OpenClaw, GB10)`
          : `LOCAL ${config.llm.model} @ ${new URL(config.llm.baseUrl!).host}`,
    invite:
      config.invite.mode === 'mock'
        ? 'MOCK (simulated workspace invite)'
        : config.invite.mode === 'manual'
          ? 'MANUAL admin fallback'
          : 'LIVE admin.users.invite (Enterprise only, unverified)',
  };
}
