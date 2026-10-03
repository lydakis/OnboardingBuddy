# Onboarding Buddy

An onboarding agent for **Fleetwing Express**, a fictional, FedEx-inspired delivery company. Built for the Dell × NVIDIA hackathon. All workers, CVs and policies are synthetic.

Path: `/Users/lydakis/Developer/OnboardingBuddy`

A manager starts a case in Slack. The agent emails the new worker, collects their CV and contact details, and helps them join Slack. After the worker confirms the tailored Slack questionnaire, a frozen snapshot feeds local CatBoost readiness prediction and an explicit company policy to propose a two-week training plan. The manager reviews and approves the plan. CV extraction runs through NemoClaw/OpenClaw; CatBoost and the application also run on the GB10. See [the readiness integration](docs/READINESS.md).

## Quick start (mock mode, no credentials)

Requires Node ≥ 22.18 (runs TypeScript directly; SQLite is built in).

```sh
npm install
npm run demo -- --phase 3          # 1 = intake, 2 = Slack questionnaire, 3 = training plan
```

The script prints the Slack/email conversation and then serves the internal status page at http://127.0.0.1:4600 (mock Slack feed at `/slack`). Add `--no-serve` to exit after the script.

On the GB10 with real local inference through NemoClaw:

```sh
errand --on gb10 -L 4600 -e OB_LLM_MODE=nemoclaw -e OB_STATUS_HOST=0.0.0.0 -- sh -c 'npm ci && npm run demo -- --phase 3'
```

## Checks

```sh
npm run check        # tsc --noEmit + app tests
npm run live:check   # read-only readiness of live Slack, AgentMail, invites and the model; sends nothing
npm run probe:llm -- rosa-experienced   # one real extraction against the configured local model
```

Tests cover missing answers, duplicate deliveries, restart persistence, case isolation, manager approval, invitation versus joined state, model-output validation, the live recipient allowlist and the chat agent's scoping.

## Phases

| Phase | What it shows | Status |
|---|---|---|
| 1 Email intake | `/onboard start`, welcome email, reply correlation by thread id + sender, focused follow-ups, dedupe, quarantine of wrong-sender replies, `/onboard status` | done |
| 3 Training plan | Local-model fact extraction with verbatim evidence, policy-driven track/modules/targets, conflicts block approval, revise/approve, approved plan emailed | done |
| 2 Join Slack + questionnaire | Readiness checks, manager-approved invite (`admin.users.invite` or manual fallback), `sent` ≠ joined, identity review, channel welcome | done |
| Slack agent | Managers and joined workers can DM the bot; scoped answers; suggestions are buttons, never auto-run | done |
| Sandboxed tool use | The OpenClaw agent in the NemoClaw/OpenShell sandbox calls our read-only business tools (`openclaw/skills/onboarding-buddy`) to answer managers and write a day-1 quiz; the host re-validates everything | done |
| 4 Training follow-through | Deferred by decision | — |

## Slack commands (`/onboard …`, managers only)

`start "Name" email` · `status [case]` · `plan <case>` · `evidence <case>` · `revise <case> [track=] [add=] [remove=] [resolve=<item>] "note"` · `approve <case> v<n>` · `invite <case>` · `invite-sent <case>` · `verify-join <case>` · `link <case> <slack id>` · `clear <case> "note"` · `verify-send <action key> sent|not-sent` · `quiz <case>` · `quiz-send <case>` · `help`

Or drop a CSV/Excel roster of new hires into the bot's DM: it lists who it found and starts them all after one click (`npm run cli -- roster U_MGR_DANA fixtures/rosters/october-new-hires.xlsx` in mock mode).

## Docs

- [docs/READINESS.md](docs/READINESS.md): GB10 classifier, three planning tiers, deployment and verification
- [docs/FLOWS.md](docs/FLOWS.md): every flow, and what happens in Slack vs email vs the dashboard
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md): components, safety principles, code map
- [docs/LIVE-SETUP.md](docs/LIVE-SETUP.md): the steps you take to go live (Slack Enterprise sandbox, AgentMail, GB10 env)
- [docs/LIVE-CHECKLIST.md](docs/LIVE-CHECKLIST.md): ready / mocked / blocked / untested per component
- [docs/INTEGRATION-RESEARCH.md](docs/INTEGRATION-RESEARCH.md): Slack invite API, AgentMail and OpenClaw facts with sources
- [fixtures/](fixtures/): synthetic workers and the example training policy
- [.env.example](.env.example): every setting, secret-free

## Scope

Not included: offer signing, identity verification, payroll, HRIS, real employee documents. No Blue code was reused.
