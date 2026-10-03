import type { App } from '../app.ts';
import { esc, extraSections } from './status.ts';
import { latestPlan, planContent } from '../engine/plan.ts';

extraSections.push((app: App, caseId: string) => {
  const row = latestPlan(app, caseId);
  if (!row) return '';
  const p = planContent(row);
  const ev = (list: { source: string; excerpt: string }[]) => list.map((e) => `<div class="muted">${esc(e.source)}: “${esc(e.excerpt)}”</div>`).join('');
  return `<div class="card"><h2>Training plan v${row.version} · <span class="${esc(row.status)}">${esc(row.status)}</span> · policy ${esc(p.policyId)}</h2>
<p><b>${esc(p.track.label)}</b> — ${esc(p.track.reason)}</p>${ev(p.track.evidence)}
<table><tr><th>module</th><th>hours</th><th>days</th><th>why (policy rule)</th><th>evidence required</th></tr>
${p.modules.map((m) => `<tr><td>${esc(m.id)} ${esc(m.title)}</td><td>${m.hours}</td><td>${esc(m.days.join(', '))}</td><td>${esc(m.reason)}${ev(m.evidence)}</td><td>${esc(m.evidenceRequired)}</td></tr>`).join('')}</table>
<p>Ramp (policy-defined stop limits): ${p.schedule.map((s) => `D${s.day}: ${s.targetStops}`).join(' · ')}</p>
${p.reviewItems.length ? `<h2>Review items</h2><ul>${p.reviewItems.map((r) => `<li class="${r.resolution ? 'complete' : r.blocking ? 'needs_review' : ''}">${esc(r.text)}${r.resolution ? ` — resolved: ${esc(r.resolution)}` : ''}</li>`).join('')}</ul>` : ''}
${p.missingInfo.length ? `<h2>Missing information</h2><ul>${p.missingInfo.map((m) => `<li>${esc(m)}</li>`).join('')}</ul>` : ''}
<h2>Extracted facts</h2><table><tr><th>fact</th><th>value</th><th>source</th><th>confidence</th><th>excerpt</th></tr>${p.facts.map((f) => `<tr><td>${esc(f.name)}</td><td>${esc(f.value)}</td><td>${esc(f.source)}</td><td>${esc(f.confidence)}</td><td>${esc(f.excerpt)}</td></tr>`).join('')}</table>
<p class="muted">${esc(p.disclaimer)}</p></div>`;
});

extraSections.push((app: App, caseId: string) => {
  const inv = app.store.db.prepare('SELECT * FROM invitations WHERE case_id = ?').get(caseId) as Record<string, unknown> | undefined;
  if (!inv) return '';
  const steps = ['requested_at', 'sent_at', 'confirmed_at', 'welcomed_at'];
  return `<div class="card"><h2>Slack invitation · <span class="${esc(inv.state)}">${esc(inv.state)}</span> · ${esc(inv.method ?? '')}</h2>
<table><tr><th>email</th>${steps.map((s) => `<th>${esc(s.replace('_at', ''))}</th>`).join('')}<th>slack user</th><th>review</th></tr>
<tr><td>${esc(inv.email)}</td>${steps.map((s) => `<td>${esc(inv[s] ?? '—')}</td>`).join('')}<td>${esc(inv.slack_user_id ?? '—')}</td><td>${esc(inv.review_reason ?? '')}</td></tr></table></div>`;
});
