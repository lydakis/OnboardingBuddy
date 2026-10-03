# Integration research (verified against primary docs, 2026-10-03)

Facts the live adapters are designed around. "Inferred" marks conclusions the docs imply but do not state.

## Slack: inviting a new person to the workspace

| Route | Works with a normal bot token? | Requirements |
| --- | --- | --- |
| `admin.users.invite` | **No** | Enterprise plan. User token (not bot) with `admin.users:write`, from an app installed org-wide by an Enterprise Org Admin/Owner. Args: `team_id`, `email`, `channel_ids` (≥1). [docs](https://docs.slack.dev/reference/methods/admin.users.invite), [scope](https://docs.slack.dev/reference/scopes/admin.users.write/) |
| `admin.inviteRequests.approve/deny/list` | **No** | Enterprise org-wide install, user token with `admin.invites:write`. [docs](https://docs.slack.dev/reference/methods/admin.inviteRequests.approve) |
| `users.admin.invite` (legacy, undocumented) | **No** | Legacy token with `client` scope; Slack stopped issuing these in 2020. Not viable. [changelog](https://docs.slack.dev/changelog/2020-02-legacy-test-token-creation-to-retire/) |
| `conversations.inviteShared` | Bot token, `conversations.connect:write` | Slack Connect channel invite. Does **not** make the person a workspace member. [docs](https://docs.slack.dev/reference/methods/conversations.inviteShared) |
| `conversations.invite` | Bot token, `channels:manage` / `channels:write.invites` | Adds **existing members** to a channel only. [docs](https://docs.slack.dev/reference/methods/conversations.invite) |

Conclusion (inferred): on a free/Pro/Business+ demo workspace there is no API to invite a new person. The invite adapter therefore defaults to **manual-admin fallback**: a manager or admin sends the invite in Slack's UI (or shares the workspace invite link) and then marks it sent with `/onboard invite-sent <case>`.

### Detecting membership

- `team_join` event, scope `users:read`, delivered over Events API, therefore over Socket Mode (inferred). Must be subscribed in the app config. [docs](https://docs.slack.dev/reference/events/team_join)
- `users.lookupByEmail`, scope `users:read.email`; returns `users_not_found` for unknown or deactivated users. [docs](https://docs.slack.dev/reference/methods/users.lookupByEmail)

### Socket Mode

App-level token `xapp-` with `connections:write`; slash commands and Block Kit buttons are delivered over the socket; each envelope must be acked. [docs](https://docs.slack.dev/apis/events-api/using-socket-mode)

## AgentMail

- Base `https://api.agentmail.to/v0`, header `Authorization: Bearer <key>`. Inbox id is the address. Message ids are RFC-style `<...>` and must be URL-encoded in paths.
- Send `POST /inboxes/{inbox}/messages/send` → `{message_id, thread_id}`. Reply `POST /inboxes/{inbox}/messages/{message_id}/reply`.
- List `GET /inboxes/{inbox}/messages?labels=unread` (items include `in_reply_to`, `references`, `thread_id`, `attachments`). Get message adds `text` and `extracted_text` (quotes stripped). Mark processed with label PATCH (`add_labels`/`remove_labels`).
- Attachment `GET .../attachments/{attachment_id}` → signed `download_url`.
- [API reference](https://docs.agentmail.to/api-reference.md)

## OpenClaw / NemoClaw

- OpenClaw gateway OpenAI-compatible endpoint: disabled by default; enable `gateway.http.endpoints.chatCompletions.enabled: true`. `POST /v1/chat/completions` on the gateway port (default 18789), `Authorization: Bearer <gateway token>` (full operator access, keep private). `model`: `openclaw/<agentId>`. Session isolation: the OpenAI `user` field derives a stable session key, or send `x-openclaw-session-key`. [docs](https://docs.openclaw.ai/gateway/openai-http-api)
- Skills: directory with `SKILL.md` (`name`, `description` frontmatter), installed with `nemoclaw <sandbox> skill install ./dir` into `/sandbox/.openclaw/workspace/skills/<name>`. [docs](https://docs.openclaw.ai/tools/creating-skills)
- NemoClaw sandbox egress is deny-by-default and blocks loopback/private IPs; a host service is reachable as `host.openshell.internal:<port>` after adding a policy preset (`nemoclaw <sandbox> policy add --from-file preset.yaml`).
- NemoClaw onboarding supports Slack Socket Mode itself (`SLACK_BOT_TOKEN`, `SLACK_APP_TOKEN`).
- Unconfirmed: whether NemoClaw's `gb10-agent` has `chatCompletions` enabled. Check on the GB10 before relying on it.
