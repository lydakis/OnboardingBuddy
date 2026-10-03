# Live-integration checklist

Status as of 2026-10-03. ✅ ready (verified live) · 🧪 mocked (deterministic mock, covered by tests) · 🟡 built, untested live · ⛔ blocked on setup.

| Component | Status | Evidence / what is missing |
|---|---|---|
| Slack Enterprise developer sandbox | ✅ ready | https://onboardingbuddy.enterprise.slack.com/ (`E0C625RK7QX`); workspace `T0C6M7CJKTN`. Chat app `A0C6260TD9D` installed to workspace, admin app `A0C7BU4CMUG` installed to organization after George approved. Bot `U0C62871A79` added to public `new-couriers` and private `onboarding-managers`. Live token checks passed. |
| Local inference via NemoClaw (`gb10-agent`, OpenClaw → Qwen3.6-35B) | ✅ ready | `live:check` on GB10: replied in ~3 s. Phase 2 demo ran end to end with real extraction. |
| Local inference via Nemotron Nano (OpenAI-compatible, :8001) | ✅ ready | `live:check` ~0.2 s; CV extraction ~35 s with thinking off (`probe:llm`), 9/9 facts valid. |
| No cloud fallback | ✅ ready | `assertLocalEndpoint` refuses non-local URLs; NemoClaw mode never leaves the GB10. |
| Experience extraction validation | ✅ ready | Unit tests: invented excerpts, bad values, broken JSON rejected; failures become review items. |
| Email intake logic (correlation, dedupe, follow-ups, persistence) | 🧪 mocked | 8 tests in `test/intake.test.ts`. |
| AgentMail email adapter | 🟡 outbound verified live | GB10 uses inbox `fleetwing-onboarding@agentmail.to` and an inbox-scoped mail key. George approved the Rosa test email; provider acceptance and case persistence verified at 18:53:11 UTC. Fresh-process replay returned the same message ID without sending again. Gmail receipt and real inbound acknowledgment remain pending. Reply recipient and extracted-text regressions pass. See `docs/EMAIL-SETUP.md`. |
| Slack Web API adapter (posts, DMs, buttons, lookupByEmail, conversations.invite) | ✅ partial live | Real manager DMs, buttons, channel mention response and invite preflight lookup exercised. Adding a confirmed worker to a channel still awaits membership acceptance. |
| Slack Socket Mode transport (slash commands, buttons, team_join, DMs) | ✅ partial live | Connected; `/onboard help`, manager DMs, action button and channel mention work. Real `team_join` still awaits worker acceptance. |
| Workspace invite via `admin.users.invite` | ✅ ready | Org admin token scope verified; real invitations for allowlisted Rosa (`FW-001`) and Theo (`FW-002`) succeeded. Both remain `sent`, not joined. |
| Manual-admin invite fallback | 🧪 mocked | `/onboard invite-sent` path covered by tests; needs no credentials. |
| Membership confirmation (team_join / lookupByEmail) | 🧪 mocked | Tests: invite never marks joined, ambiguous identity → review. Live needs `users:read.email`. |
| Slack chat agent (managers + joined workers) | ✅ partial live | Manager chat and suggestion button exercised over live Slack with mock reasoning. Joined-worker chat awaits worker acceptance. Tests restrict worker context to own case. |
| Live recipient allowlist | ✅ ready | Two George-controlled Gmail plus aliases selected and configured in `slack/sandbox.env`; Rosa live invitation passed the allowlist. |
| Sandboxed tool use (gb10-agent calls `onboarding-tools.mjs` via `exec`) | ✅ ready | GB10 run: day-1 quiz took 8 tool calls in 25 s and passed host validation; manager "anything blocked?" took 2 tool calls in 3.8 s. Model `nvidia/Qwen3.6-35B-A3B-NVFP4`, `fallbackUsed: false`. Files go in with `nemoclaw upload`; no network policy change. |
| Spreadsheet bulk start (CSV/XLSX in Slack DM) | 🟡 untested live | Real NemoClaw/Qwen read the synthetic Excel roster on the GB10 in ~9 s: 3 people, duplicate and missing email set aside. Live Slack download needs the `files:read` bot scope (added to `slack/app-manifest.yaml`; app must be reinstalled). |
| Phase 4 training follow-through | deferred | Out of scope for today by decision. |

## Known limitations

- PDF/DOCX CV text extraction is not implemented; non-text attachments are marked `needs_review`.
- The `gb10-agent` OpenClaw agent has its default tool set. Prompts tell it not to use tools, the sandbox has no business credentials and its egress is deny-by-default, and every output is validated, but a dedicated tool-less agent profile would be stronger.
- The status page has no authentication. Bind it to `127.0.0.1` and reach it through `errand -L 4600` or an SSH tunnel.
