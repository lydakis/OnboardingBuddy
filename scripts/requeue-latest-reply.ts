// Ops: re-run the latest inbound email of one case through the current code (after a fix).
//   node --env-file=... scripts/requeue-latest-reply.ts FW-004
import { loadConfig } from '../src/config.ts';
import { createApp } from '../src/app.ts';

const caseId = process.argv[2]!;
const app = await createApp(loadConfig());
const row = app.store.db
  .prepare(`SELECT provider_message_id FROM messages WHERE case_id = ? AND channel = 'email' AND direction = 'in' ORDER BY created_at DESC LIMIT 1`)
  .get(caseId) as { provider_message_id: string } | undefined;
if (!row) throw new Error(`no inbound email for ${caseId}`);
app.store.db.prepare('DELETE FROM processed_events WHERE event_key = ?').run(`email:${row.provider_message_id}`);
app.store.db.prepare(`DELETE FROM messages WHERE provider_message_id = ? AND direction = 'in'`).run(row.provider_message_id);
await app.adapters.email.requeue(row.provider_message_id);
app.store.audit(caseId, 'ops', 'reply_requeued', {});
console.log(`requeued latest reply for ${caseId}`);
app.close();
