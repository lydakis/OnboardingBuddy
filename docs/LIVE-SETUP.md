# Going live: the steps only you can do

Nothing here is done by the agent. Each step creates an account, a credential or a real message.
Put the resulting values in `~/.config/onboarding-buddy/env` on the GB10 (never in the repo).

## 1. Slack Enterprise developer sandbox

1. Join the Slack Developer Program (https://api.slack.com/developer-program) and confirm the email.
2. **Sandboxes → Provision sandbox → empty sandbox.** It is a free Enterprise org with up to 8 users. Note its workspace.
3. In the sandbox workspace, create a public channel `#new-couriers`. Copy its channel ID (channel details → bottom) → `OB_NEW_HIRE_CHANNEL`.
4. https://api.slack.com/apps → **Create New App → From a manifest** → choose the sandbox org → paste `slack/app-manifest.yaml`.
5. **Basic Information → App-Level Tokens → Generate**, scope `connections:write` → `SLACK_APP_TOKEN` (`xapp-…`).
6. **Install the app at the organization level** as the sandbox Org Owner/Admin, approve the `admin.users:write` user scope, and add the app to the workspace.
   - Bot token (`xoxb-…`) → `SLACK_BOT_TOKEN`
   - User token (`xoxp-…`, carries `admin.users:write`) → `SLACK_ADMIN_USER_TOKEN`
7. Workspace ID (`T…`, from the workspace URL or `auth.test`) → `SLACK_TEAM_ID`.
8. Each manager's member ID (profile → ⋮ → Copy member ID) → `OB_MANAGER_SLACK_IDS` (comma-separated).
9. In `#new-couriers`, run `/invite @Onboarding Buddy`.

Seat budget (8): you, your teammate, one manager persona if separate, and the two demo "workers". The workers must be email addresses one of you controls (for example `+rosa` / `+theo` aliases), so the invitation and the replies are real but reach only you.

## 2. Email (AgentMail)

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

## 4. Before the first real send

Run `npm run live:check` on the GB10. It calls `auth.test`, checks scopes, lists the AgentMail inbox and pings the model, and sends nothing. Then tell Claude which recipient addresses are approved for the first real welcome email and invite.
