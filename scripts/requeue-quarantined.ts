// Ops: put quarantined inbound emails for one case back in the queue (after a correlation fix).
//   node --env-file=... scripts/requeue-quarantined.ts FW-004
import { loadConfig } from '../src/config.ts';
import { createApp } from '../src/app.ts';

const caseId = process.argv[2];
const app = await createApp(loadConfig());
const audit = app.store.auditTrail(caseId!).filter((a) => a.type === 'reply_quarantined');
const rows = app.store.db
  .prepare(`SELECT provider_message_id FROM messages WHERE case_id IS NULL AND correlation = 'quarantined:sender_mismatch' AND provider_message_id IN (SELECT substr(event_key, 7) FROM processed_events WHERE case_id = ? AND outcome = 'quarantined')`)
  .all(caseId!) as { provider_message_id: string }[];
for (const r of rows) {
  app.store.db.prepare('DELETE FROM processed_events WHERE event_key = ?').run(`email:${r.provider_message_id}`);
  app.store.db.prepare(`DELETE FROM messages WHERE provider_message_id = ? AND case_id IS NULL`).run(r.provider_message_id);
  await app.adapters.email.requeue(r.provider_message_id);
}
app.store.updateCase(caseId!, { needs_attention: null });
app.store.audit(caseId!, 'ops', 'quarantine_requeued', { count: rows.length, quarantinedEvents: audit.length });
console.log(`requeued ${rows.length} message(s) for ${caseId}`);
app.close();
