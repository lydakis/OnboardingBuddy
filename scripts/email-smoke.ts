// Live AgentMail smoke test: sends ONE email to an allowlisted address and shows what polling sees.
//   node --env-file=.env scripts/email-smoke.ts <allowlisted address>
import { AgentMailAdapter } from '../src/adapters/email/agentmail.ts';

const to = process.argv[2];
const allow = (process.env.OB_LIVE_RECIPIENT_ALLOWLIST ?? '').split(',').map((s) => s.trim().toLowerCase());
if (!to || !allow.includes(to.toLowerCase())) throw new Error('recipient must be on OB_LIVE_RECIPIENT_ALLOWLIST');
const mail = new AgentMailAdapter({ apiKey: process.env.AGENTMAIL_API_KEY!, inboxId: process.env.AGENTMAIL_INBOX_ID!, baseUrl: 'https://api.agentmail.to/v0' });
const sent = await mail.send({ to, subject: 'Fleetwing onboarding: email check (fictional demo)', text: 'This is a one-time check that the onboarding assistant can send email. No reply needed.', idempotencyKey: `smoke:${Date.now()}` });
console.log('sent ok; thread id present:', Boolean(sent.threadId), 'message id format:', sent.providerMessageId.replace(/[^<>@.]/g, 'x').slice(0, 24));
const inbound = await mail.poll();
console.log('poll returned', inbound.length, 'unread inbound message(s)');
