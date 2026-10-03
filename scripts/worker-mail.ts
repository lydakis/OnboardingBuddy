// Demo helper for worker personas that live in AgentMail inboxes (all synthetic).
//   node --env-file=.env scripts/worker-mail.ts inbox <worker inbox>              # latest messages + any Slack join link
//   node --env-file=.env scripts/worker-mail.ts reply <worker inbox> <body file> [attachment]
// Replies go to the latest message from the onboarding inbox, so they thread correctly.
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';

const base = process.env.AGENTMAIL_BASE_URL ?? 'https://api.agentmail.to/v0';
const key = process.env.AGENTMAIL_API_KEY!;
const [cmd, inbox, bodyFile, attachment] = process.argv.slice(2);
if (!inbox) throw new Error('usage: worker-mail.ts inbox|reply <worker inbox> ...');
const enc = encodeURIComponent;

async function api<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${base}${path}`, { method, headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  if (!res.ok) throw new Error(`${method} ${path}: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
  return (await res.json()) as T;
}

const list = await api<{ messages: { message_id: string; from: string; subject: string; timestamp: string }[] }>('GET', `/inboxes/${enc(inbox)}/messages?limit=10`);
if (cmd === 'inbox') {
  for (const m of list.messages) console.log(`${m.timestamp}  ${m.from}  ${m.subject}`);
  for (const m of list.messages.filter((x) => /slack/i.test(x.from) || /slack/i.test(x.subject))) {
    const full = await api<{ text?: string; html?: string }>('GET', `/inboxes/${enc(inbox)}/messages/${enc(m.message_id)}`);
    const link = `${full.text ?? ''} ${full.html ?? ''}`.match(/https:\/\/[a-z0-9.-]*slack\.com\/[^\s"'<>]+/i)?.[0];
    if (link) console.log(`\nSlack join link (${m.subject}):\n${link.replace(/&amp;/g, '&')}`);
  }
} else if (cmd === 'reply') {
  const target = list.messages.find((m) => /onboarding@agentmail\.to/i.test(m.from));
  if (!target) throw new Error('no message from the onboarding inbox to reply to');
  const att = attachment
    ? [{ filename: basename(attachment), content_type: attachment.endsWith('.pdf') ? 'application/pdf' : 'text/plain', content: readFileSync(attachment).toString('base64') }]
    : undefined;
  const r = await api<{ message_id: string }>('POST', `/inboxes/${enc(inbox)}/messages/${enc(target.message_id)}/reply`, { text: readFileSync(bodyFile!, 'utf8'), attachments: att });
  console.log('replied; message id present:', Boolean(r.message_id));
}
