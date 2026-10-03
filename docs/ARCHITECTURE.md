# Architecture

```
            Slack (Enterprise sandbox)                         Worker's mailbox
   managers ─ /onboard, buttons, DMs ─┐                  ┌─ welcome, follow-ups, plan
   workers  ─ DMs after joining ──────┤                  │
   team_join events ──────────────────┤                  │
                                      ▼                  ▼
                        Socket Mode transport      AgentMail (poll + send)
                                      │                  │
                                      ▼                  ▼
   ┌──────────────────────── Onboarding Buddy service (GB10 host) ───────────────────────┐
   │ commands.ts   manager authz, event dedupe, command registry                         │
   │ intake.ts     correlation (thread id + sender), checklist with excerpts, follow-ups │
   │ plan.ts       extraction → validation → policy engine → versions → approval → email │
   │ join.ts       readiness → invite request → sent → membership confirmed → welcome    │
   │ agent.ts      scoped chat for managers / joined workers; suggests, never acts       │
   │ context.ts    outbox with stable action keys; uncertain sends flagged, not retried  │
   │ SQLite        cases, checklist, messages, documents, extractions, plans, approvals, │
   │               invitations, outbox, processed events, audit                          │
   │ status page   read-only internal monitor (:4600)                                    │
   └───────────────────────────────┬─────────────────────────────────────────────────────┘
                                   │ nemoclaw gb10-agent agent --session-id onboarding-<case>-<purpose> --json
                                   ▼
                 NemoClaw sandbox gb10-agent → OpenClaw → Qwen3.6-35B (vLLM, GB10)
                 (alternative: Nemotron Nano, OpenAI-compatible on 127.0.0.1:8001)
```

### Tool use inside the sandbox

For manager chat and the day-1 quiz, the agent does real tool work inside the OpenShell sandbox:

1. The host builds a **scoped snapshot**: all cases for a manager; one case's plan and the policy for a worker task, with no CV/email text and no contact details.
2. `nemoclaw gb10-agent upload` puts `onboarding-tools.mjs` and the snapshot under `/sandbox/onboarding/<scope>/`.
3. One OpenClaw turn (session `onboarding-manager-<id>` or `onboarding-<case>-quiz`) calls the tools with `exec`: `cases`, `case`, `plan`, `policy`, `blockers`, `quiz-check`.
4. The reply comes back to the host, which re-validates it (`checkQuiz`, command allowlist) before anything is shown or sent. Every run is logged in `agent_runs` with model, tool calls, duration and whether a fallback was used.

The sandbox has deny-by-default egress (verified: `https://example.com` unreachable) and no Slack, email or database credentials, so even a hijacked turn can only return text that the host then checks.

## Principles

- **One runtime, isolated state.** One service process and one NemoClaw/OpenClaw agent. Each worker is a case row; every worker-owned table is keyed by `case_id`, and model calls use a per-case session id (`onboarding-FW-001-extract`, `onboarding-FW-001-chat`).
- **The models propose, policy decides.** The local LLM extracts validated CV facts. Confirmed questionnaire snapshots feed CatBoost on GB10 loopback; demo mode proposes a policy tier, while advisory mode preserves the existing CV/license selection. Modules and route limits come from the written policy. The manager approves the hashed plan, including its prediction. Classifier failure visibly falls back to policy. See [the readiness integration](READINESS.md).
- **Untrusted input.** CVs and emails are data. Answers are read only from `Label: value` lines; quoted history is stripped; instruction-like CV text is flagged to the manager. Nothing in an email or CV can approve, invite or change permissions.
- **Authorization.** Only Slack users in `OB_MANAGER_SLACK_IDS` can start cases, approve plans, request invites, link identities or verify sends. The dashboard has no write actions.
- **Exactly-once-ish side effects.** Inbound events are claimed in `processed_events` inside the same transaction as their state change. Outbound sends go through the outbox keyed by a stable action key (`email:welcome:FW-001`, `email:followup:FW-001:<inbound id>`). A send whose outcome is unknown (timeout, crash) becomes `uncertain`, is shown to the manager and is not retried until `/onboard verify-send`.
- **Invite ≠ joined.** Invitation states are `requested → sent | manual_pending | failed → membership_confirmed`, plus `needs_review`. Only `membership_confirmed` (team_join or `users.lookupByEmail` with the invited email, or a manager's explicit `link`) links the Slack id and triggers the welcome.
- **Live safety rail.** With live connectors, email and invites only go to `OB_LIVE_RECIPIENT_ALLOWLIST`.

## Code map

| Path | Purpose |
|---|---|
| `src/types.ts` | Shared contracts for adapters and rows |
| `src/db/` | Schema and data access |
| `src/engine/` | Workflow (intake, plan, join, agent, commands) |
| `src/adapters/email/` | `mock`, `agentmail` |
| `src/adapters/slack/` | `mock`, `web` (Web API), `socket` (Socket Mode) |
| `src/adapters/llm/` | `mock`, `nemoclaw`, `openai-compatible` |
| `src/adapters/invite/` | `mock`, `manual`, `slack-admin` (`admin.users.invite`) |
| `src/server/` | Read-only status page |
| `src/demo/` | Scripted multi-phase demo |
| `scripts/` | `live-check.ts`, `probe-llm.ts` |
