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

## Principles

- **One runtime, isolated state.** One service process and one NemoClaw/OpenClaw agent. Each worker is a case row; every worker-owned table is keyed by `case_id`, and model calls use a per-case session id (`onboarding-FW-001-extract`, `onboarding-FW-001-chat`).
- **The model proposes, code decides.** The model only extracts facts. `validateExtraction` keeps a fact only if its excerpt appears verbatim in the named source and its value is in range. Track, modules and daily stop targets come from `fixtures/policy/training-policy.json`. A failed or garbled model call becomes a blocking review item, never a guess.
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
