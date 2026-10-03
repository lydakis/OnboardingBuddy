# Live-integration checklist

Status as of 2026-10-03. ✅ ready (verified live) · 🧪 mocked (deterministic mock, covered by tests) · 🟡 built, untested live · ⛔ blocked on setup.

| Component | Status | Evidence / what is missing |
|---|---|---|
| Local inference via NemoClaw (`gb10-agent`, OpenClaw → Qwen3.6-35B) | ✅ ready | `live:check` on GB10: replied in ~3 s. Phase 2 demo ran end to end with real extraction. |
| Local inference via Nemotron Nano (OpenAI-compatible, :8001) | ✅ ready | `live:check` ~0.2 s; CV extraction ~35 s with thinking off (`probe:llm`), 9/9 facts valid. |
| No cloud fallback | ✅ ready | `assertLocalEndpoint` refuses non-local URLs; NemoClaw mode never leaves the GB10. |
| Experience extraction validation | ✅ ready | Unit tests: invented excerpts, bad values, broken JSON rejected; failures become review items. |
| Email intake logic (correlation, dedupe, follow-ups, persistence) | 🧪 mocked | 8 tests in `test/intake.test.ts`. |
| AgentMail email adapter | ⛔ blocked | Needs `AGENTMAIL_API_KEY` + inbox. Built from API docs; send/poll/label not yet exercised. |
| Slack Web API adapter (posts, DMs, buttons, lookupByEmail, conversations.invite) | ⛔ blocked | Needs sandbox bot token. Built from API docs. |
| Slack Socket Mode transport (slash commands, buttons, team_join, DMs) | ⛔ blocked | Needs `xapp-` token. Uses Node's built-in WebSocket. |
| Workspace invite via `admin.users.invite` | ⛔ blocked | Needs Enterprise sandbox org-level install + `admin.users:write` user token. `live:check` reports enterprise id and scope without inviting. |
| Manual-admin invite fallback | 🧪 mocked | `/onboard invite-sent` path covered by tests; needs no credentials. |
| Membership confirmation (team_join / lookupByEmail) | 🧪 mocked | Tests: invite never marks joined, ambiguous identity → review. Live needs `users:read.email`. |
| Slack chat agent (managers + joined workers) | 🧪 mocked | Tests: worker sees only own case; suggestions are buttons, never auto-run. Live model route verified separately. |
| Live recipient allowlist | 🧪 mocked | Test: non-allowlisted address is never sent to. Needs `OB_LIVE_RECIPIENT_ALLOWLIST`. |
| OpenClaw skill for querying cases from the agent | 🟡 untested | `openclaw/skills/onboarding-buddy/`; needs a network policy preset to reach the host service. |
| Phase 4 training follow-through | deferred | Out of scope for today by decision. |

## Known limitations

- PDF/DOCX CV text extraction is not implemented; non-text attachments are marked `needs_review`.
- The `gb10-agent` OpenClaw agent has its default tool set. Prompts tell it not to use tools, the sandbox has no business credentials and its egress is deny-by-default, and every output is validated, but a dedicated tool-less agent profile would be stronger.
- The status page has no authentication. Bind it to `127.0.0.1` and reach it through `errand -L 4600` or an SSH tunnel.
