# Going live: setup steps

The agent can prepare manifests and operate the setup UI. George handles payment
verification and stores credentials; app permission grants are reviewed at the
actual installation screen. See [the Slack-only setup and acceptance record](../slack/README.md).
Put the resulting values in `~/.config/onboarding-buddy/env` on the GB10 (never in the repo).

## 1. Slack Enterprise developer sandbox

1. Join the Slack Developer Program (https://api.slack.com/developer-program) and confirm the email.
2. **Sandboxes → Provision sandbox → empty sandbox.** It is a free Enterprise org with up to 8 users. Note its workspace.
3. In the sandbox workspace, create a public channel `#new-couriers`. Copy its channel ID (channel details → bottom) → `OB_NEW_HIRE_CHANNEL`.
4. https://api.slack.com/apps → **Create New App → From a manifest** → choose the sandbox workspace → paste `slack/app-manifest.yaml`. Install the chat bot to that workspace.
5. **Basic Information → App-Level Tokens → Generate**, scope `connections:write` → `SLACK_APP_TOKEN` (`xapp-…`).
6. Bot token from the chat app (`xoxb-…`) → `SLACK_BOT_TOKEN`. For automated workspace invitations, create a **separate app** from `slack/provisioning-app-manifest.yaml` and complete its OAuth installation at the **organization level** as the sandbox Org Owner/Admin.
   - Provisioning app's user token (`xoxp-…`, carries `admin.users:write`) → `SLACK_ADMIN_USER_TOKEN`
   - If admin installation is unavailable, keep `OB_INVITE_MODE=manual`; the chat app still works.
7. Workspace ID (`T…`, from the workspace URL or `auth.test`) → `SLACK_TEAM_ID`.
8. Each manager's member ID (profile → ⋮ → Copy member ID) → `OB_MANAGER_SLACK_IDS` (comma-separated).
9. In `#new-couriers`, run `/invite @Onboarding Buddy`.

Seat budget (8): you, your teammate, one manager persona if separate, and the two demo "workers". The workers must be email addresses one of you controls (for example `+rosa` / `+theo` aliases), so the invitation and the replies are real but reach only you.

## 2. Email (AgentMail)

The Fleetwing inbox has now been created and the GB10 service switched to
AgentMail. See [the email-only setup and acceptance record](EMAIL-SETUP.md) for
the current configuration and first-send status.

1. Create an AgentMail account and an API key → `AGENTMAIL_API_KEY`.
2. Create an inbox, e.g. `fleetwing-onboarding@agentmail.to` → `AGENTMAIL_INBOX_ID` and `OB_EMAIL_FROM`.
3. Decide the demo worker addresses (the aliases above) and list them in `OB_LIVE_RECIPIENT_ALLOWLIST`. Live mode refuses to email or invite any address not on that list.

## 3. GB10 runtime

The service runs on the GB10 host (it needs Slack and AgentMail egress, which the NemoClaw sandbox blocks by default) and uses the local model there.

```sh
# ~/.config/onboarding-buddy/env on the GB10 (chmod 600)
OB_EMAIL_MODE=agentmail
OB_SLACK_MODE=socket
OB_INVITE_MODE=slack-admin-api      # or "manual" if admin.users.invite is refused
OB_LLM_MODE=nemoclaw               # gb10-agent (OpenClaw → Qwen), one session per case
OB_STATUS_HOST=0.0.0.0
OB_DB_PATH=/home/dell/.local/share/onboarding-buddy/onboarding.db   # outside the Errand job workspace, so state survives restarts
# plus the Slack, AgentMail and allowlist values above
```

Start it (from this Mac):

```sh
errand --on gb10 -L 4600 -- sh -c 'npm ci && set -a && . ~/.config/onboarding-buddy/env && npm start'
```

`OB_LLM_MODE=nemoclaw` runs each model call as `nemoclaw gb10-agent agent --session-id onboarding-<case>-… --json`, so all reasoning goes through the event's NemoClaw/OpenClaw runtime with an isolated session per worker. Verified on the GB10: about 3 s per call with Qwen. Alternative without NemoClaw: `OB_LLM_MODE=openai-compatible`, `OB_LLM_BASE_URL=http://127.0.0.1:8001/v1`, `OB_LLM_MODEL=nemotron3-nano-4b-fp8`, `OB_LLM_DISABLE_THINKING=true` (about 35 s per CV).

The OpenClaw gateway's own OpenAI-compatible endpoint is disabled on `gb10-agent` (HTTP 404); we do not need it.

### Readiness classifier on the plan card

Questionnaire confirmation freezes the inputs and automatically drafts the plan with the local classifier and tailored lessons. The manager previews and approves the complete plan before it reaches the worker. See [the GB10 classifier setup](READINESS.md).

`OB_CLASSIFIER_MODE=advisory` records the estimate while preserving the existing CV/license track selection. `demo` maps beginner/okay/expert to Foundations/Intermediate/Experienced policy tiers, with review for ambiguous or missing inputs. `off` disables inference. These settings replace the earlier `OB_READINESS_CMD` and `OB_READINESS` subprocess configuration. The classifier runs as a persistent GB10 service; it does not need a model or Python environment inside each app workspace.

### Interactive training link

The approved-plan DM links to `https://onboarding-buddy-chi.vercel.app/training/#p=...`, a static page in `site/training/`. The plan rides in the URL fragment, which the browser never sends to the server, so nothing about the worker is uploaded. Override the base with `OB_TRAINING_URL`, or set it to `off` to leave the link out. When a plan is drafted, the local model also writes each module's intro and scenario around the hire's CV facts and answers (one call per plan, validated, approved with the plan). Set `OB_TAILORED_LESSONS=off` to use the standard lessons only.

## 4. Before the first real send

Run `npm run live:check` on the GB10. It calls `auth.test`, checks scopes, lists the AgentMail inbox and pings the model, and sends nothing. Then tell Claude which recipient addresses are approved for the first real welcome email and invite.

## 5. Readiness classifier

See [GB10 readiness installation and planning](READINESS.md). The classifier runs as a persistent GB10 user service; the application loads its non-secret settings from `~/.config/onboarding-buddy/readiness.env` with `sh scripts/start-gb10.sh`. Preserve the current connector profile and persistent database when restarting. The questionnaire-first flow requires Slack joining and confirmed answers before proposal, so keep `OB_READY_REQUIRE_PLAN_SENT=false`.
