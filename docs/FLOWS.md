# Flows and where each action happens

Three surfaces, each with one job:

- **Slack** is where managers act. Every state-changing decision (start, approve, revise, invite, verify) is a Slack command or button from a Slack user id listed in `OB_MANAGER_SLACK_IDS`. After joining, the worker gets training tasks in Slack too.
- **Email** is the only channel to the worker until they join Slack.
- **Dashboard** (`http://<host>:4600`) is read-only. It shows the case state, the evidence behind every recommendation, invitation state, training progress, the audit trail, quarantined emails and sends that need verification. It has no approve buttons, because it has no login and an approval must carry an authenticated Slack identity.

The OpenClaw agent on the GB10 (`gb10-agent`) does the reasoning: it runs CV/questionnaire extraction through the local model, and through the `onboarding-buddy` skill it can answer manager questions from the dashboard API ("who is blocked?"). It never approves anything; approvals only come from Slack manager actions.

| # | Flow | Trigger (where) | What the agent does | Worker sees (where) | Manager sees (where) | Dashboard shows |
|---|---|---|---|---|---|---|
| 1 | Start case | Manager: `/onboard start "Name" email` (Slack) | Creates case + checklist, sends welcome | Welcome email with CV request + questionnaire (email) | Confirmation with Status button (Slack) | New case, checklist all missing |
| 2 | Intake reply | Worker replies (email) | Correlates by thread id + sender, records valid answers with excerpts, ignores quoted text, dedupes re-deliveries | Focused follow-up listing only what is missing or invalid (email) | Nothing until complete; "Intake complete" with Propose Plan button (Slack) | Checklist with excerpt + timestamp per item; quarantined/unmatched mail |
| 3 | Status | Manager: `/onboard status [case]` or Status button (Slack) | Reads case | | Checklist summary (Slack) | Same, in more detail |
| 4 | Plan proposal | Manager: Propose Plan button or `/onboard plan FW-001` (Slack) | Local model extracts facts, validator keeps only verbatim-supported facts, policy engine picks track/modules/targets | | Plan with track reason, evidence, review items, missing info; Approve / Evidence / Revise buttons (Slack) | Plan, rule per module, extracted facts, review items |
| 5 | Review / revise | Manager: `/onboard revise FW-002 resolve=experience-conflict "note"` or `add=`/`remove=`/`track=` (Slack) | New plan version, old one superseded, manager change recorded | | New version (Slack) | Version history, manager notes |
| 6 | Approve + send plan | Manager: Approve vN button (Slack) | Checks manager, latest version, no open blocking items, hash unchanged; emails plan once | Approved two-week plan (email) | Confirmation + Request Slack Invite button (Slack) | Plan status `sent`, approval record |
| 7 | Slack invite | Manager: `/onboard invite FW-001` (Slack) | Checks readiness (intake complete, plan sent), calls `admin.users.invite` (Enterprise sandbox) or asks an admin to invite manually | Slack's own invitation email | "Invitation sent" or manual-admin instructions (Slack) | Invitation: requested → sent |
| 8 | Join | Worker accepts invite (Slack) → `team_join` event | Matches Slack user to case by the invite email; ambiguous matches go to review; only then marks joined, links Slack id, adds to `#new-couriers`, posts welcome | Welcome in `#new-couriers` + DM (Slack) | "Joined" notice, or review request (Slack) | Invitation: membership_confirmed, Slack id linked |
| 9 | Training | Manager: `/onboard training FW-001` (Slack) | Turns approved modules into tasks, DMs them to the worker | Task list with Done buttons; `/onboard done SAFE-101 <evidence>` (Slack) | Progress, escalations for missing/conflicting evidence (Slack) | Task table: delivered / done / escalated |

Not on any surface: offer signing, identity verification, payroll, HRIS, real documents.
