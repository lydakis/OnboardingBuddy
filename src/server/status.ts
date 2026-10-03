import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { describeModes } from '../config.ts';
import type { App } from '../app.ts';
import type { Row } from '../db/store.ts';

// Minimal read-only status page. Every value is HTML-escaped because it may come
// from worker emails or CVs. No tokens or config secrets are ever rendered.

export function esc(v: unknown): string {
  return String(v ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function table(rows: Row[], cols: string[]): string {
  if (rows.length === 0) return '<p class="muted">none</p>';
  return `<table><tr>${cols.map((c) => `<th>${esc(c)}</th>`).join('')}</tr>${rows
    .map((r) => `<tr>${cols.map((c) => `<td>${esc(r[c])}</td>`).join('')}</tr>`)
    .join('')}</table>`;
}

const STYLE = `
:root{--bg:#f7f7f5;--fg:#1d1d1b;--muted:#6b6b66;--card:#fff;--line:#e3e3df;--accent:#4d148c;--orange:#ff6200;--ok:#1a7f37;--warn:#b35900}
@media (prefers-color-scheme:dark){:root{--bg:#141413;--fg:#ececea;--muted:#9a9a94;--card:#1d1d1b;--line:#33332f}}
body{margin:0;font:14px/1.45 system-ui,sans-serif;background:var(--bg);color:var(--fg)}
header{padding:14px 20px;background:var(--accent);color:#fff;display:flex;gap:16px;align-items:baseline;flex-wrap:wrap}
header b{font-size:18px} header a{color:#fff}
main{padding:16px 20px;max-width:1200px;margin:auto}
.card{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:12px 16px;margin:12px 0;overflow-x:auto}
table{border-collapse:collapse;width:100%} th,td{text-align:left;padding:5px 8px;border-bottom:1px solid var(--line);vertical-align:top}
th{font-weight:600;color:var(--muted);font-size:12px;text-transform:uppercase}
.badge{display:inline-block;padding:1px 8px;border-radius:10px;font-size:12px;border:1px solid var(--line);margin-right:6px}
.mock{background:#fff3cd;color:#664d03;border-color:#e6c65c}.live{background:#d1e7dd;color:#0f5132}
.complete{color:var(--ok)}.missing{color:var(--muted)}.needs_review,.uncertain,.escalated{color:var(--warn);font-weight:600}
.muted{color:var(--muted)} pre{white-space:pre-wrap;margin:0;font:12px/1.4 ui-monospace,monospace}
a{color:var(--orange)} h2{font-size:16px;margin:4px 0 8px}
`;

function page(title: string, body: string, app: App): string {
  const modes = describeModes(app.config);
  const badges = Object.entries(modes)
    .map(([k, v]) => `<span class="badge ${v.startsWith('MOCK') ? 'mock' : 'live'}">${esc(k)}: ${esc(v)}</span>`)
    .join('');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="refresh" content="5"><title>${esc(title)}</title><style>${STYLE}</style></head><body>
<header><b>Onboarding Buddy</b><span>${esc(app.config.companyName)}</span><a href="/">all cases</a><a href="/slack">mock Slack</a></header>
<main><div class="card">${badges}</div>${body}</main></body></html>`;
}

function overview(app: App): string {
  const cases = app.store.listCases().map((c) => {
    const items = app.store.checklist(c.id);
    return {
      ...c,
      id: c.id,
      intake: `${items.filter((i) => i.status === 'complete').length}/${items.length}`,
    };
  });
  const rows = cases
    .map(
      (c) =>
        `<tr><td><a href="/case/${esc(c.id)}">${esc(c.id)}</a></td><td>${esc(c.worker_name)}</td><td>${esc(c.status)}</td><td>${esc(c.intake)}</td><td class="needs_review">${esc(c.needs_attention ?? '')}</td></tr>`,
    )
    .join('');
  const uncertain = app.store.outbox().filter((o) => o.status === 'uncertain') as unknown as Row[];
  return page(
    'Onboarding cases',
    `<div class="card"><h2>Cases</h2><table><tr><th>case</th><th>worker</th><th>status</th><th>intake</th><th>needs attention</th></tr>${rows}</table></div>
<div class="card"><h2>Sends needing verification</h2>${table(uncertain, ['action_key', 'case_id', 'kind', 'error'])}</div>
<div class="card"><h2>Unmatched / quarantined inbound email</h2>${table(app.store.unmatchedMessages(), ['created_at', 'from_addr', 'subject', 'correlation'])}</div>`,
    app,
  );
}

function caseDetail(app: App, id: string): string | null {
  const c = app.store.getCase(id);
  if (!c) return null;
  const checklist = app.store
    .checklist(id)
    .map(
      (i) =>
        `<tr><td>${esc(i.label)}</td><td class="${esc(i.status)}">${esc(i.status)}</td><td>${esc(i.value)}</td><td><pre>${esc(i.excerpt)}</pre>${i.note ? `<div class="muted">${esc(i.note)}</div>` : ''}</td><td>${esc(i.completed_at)}</td></tr>`,
    )
    .join('');
  const sections = extraSections.map((fn) => fn(app, id)).join('');
  return page(
    `${c.id} ${c.worker_name}`,
    `<div class="card"><h2>${esc(c.id)} · ${esc(c.worker_name)} · ${esc(c.status)}</h2>
<p>Email: ${esc(c.worker_email)} · Manager: ${esc(c.manager_slack_id)} · Slack user: ${esc(c.slack_user_id ?? 'not linked')}</p>
${c.needs_attention ? `<p class="needs_review">Needs attention: ${esc(c.needs_attention)}</p>` : ''}</div>
<div class="card"><h2>Intake checklist</h2><table><tr><th>item</th><th>status</th><th>value</th><th>supporting excerpt</th><th>completed</th></tr>${checklist}</table></div>
${sections}
<div class="card"><h2>Messages</h2>${table(app.store.messages(id), ['created_at', 'direction', 'from_addr', 'to_addr', 'subject', 'correlation'])}</div>
<div class="card"><h2>Outbound actions</h2>${table(app.store.outbox(id) as unknown as Row[], ['action_key', 'kind', 'status', 'error'])}</div>
<div class="card"><h2>Audit trail</h2>${table(app.store.auditTrail(id), ['at', 'actor', 'type', 'detail'])}</div>`,
    app,
  );
}

/** Later phases add case-page sections (plan, invitation, training) here. */
export const extraSections: ((app: App, caseId: string) => string)[] = [];
export { table };

function slackFeed(app: App): string {
  const posts = app.mocks.slack?.posts() ?? [];
  const body = posts
    .slice()
    .reverse()
    .map(
      (p) =>
        `<tr><td>${esc(p.channel)}</td><td><pre>${esc(p.text)}</pre>${p.buttons ? `<div class="muted">${(JSON.parse(p.buttons) as { text: string }[]).map((b) => `[${esc(b.text)}]`).join(' ')}</div>` : ''}</td></tr>`,
    )
    .join('');
  return page('Mock Slack', `<div class="card"><h2>Mock Slack messages (newest first)</h2><table><tr><th>channel</th><th>message</th></tr>${body}</table></div>`, app);
}

export async function startStatusServer(app: App): Promise<Server> {
  await import('./sections.ts');
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://local');
    let html: string | null = null;
    if (url.pathname === '/') html = overview(app);
    else if (url.pathname === '/slack') html = slackFeed(app);
    else if (url.pathname.startsWith('/case/')) html = caseDetail(app, decodeURIComponent(url.pathname.slice(6)));
    else if (url.pathname === '/api/cases') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(app.store.listCases().map((c) => ({ ...c, checklist: app.store.checklist(c.id) }))));
      return;
    }
    res.writeHead(html ? 200 : 404, { 'content-type': 'text/html; charset=utf-8' });
    res.end(html ?? 'not found');
  });
  server.listen(app.config.statusPort, app.config.statusHost);
  return server;
}
