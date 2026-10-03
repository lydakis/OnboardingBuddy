import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { SCHEMA, SCHEMA_VERSION } from './schema.ts';
import type { CaseRow, CaseStatus, ChecklistItemRow, ChecklistStatus, OutboxRow } from '../types.ts';

export type Row = Record<string, unknown>;

export function now(): string {
  return new Date().toISOString();
}

export function newId(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
}

export function openDatabase(path: string): DatabaseSync {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  db.exec(SCHEMA);
  db.prepare('INSERT OR IGNORE INTO meta (key, value) VALUES (?, ?)').run('schema_version', String(SCHEMA_VERSION));
  return db;
}

/** Thin data-access layer. Worker-owned reads always take a case id. */
export class Store {
  readonly db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
  }

  transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  // ---- cases ----
  insertCase(c: Omit<CaseRow, 'created_at' | 'updated_at' | 'email_thread_id' | 'slack_user_id' | 'needs_attention'>): CaseRow {
    const t = now();
    this.db
      .prepare(
        `INSERT INTO cases (id, worker_name, worker_email, manager_slack_id, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(c.id, c.worker_name, c.worker_email, c.manager_slack_id, c.status, t, t);
    return this.getCase(c.id)!;
  }

  getCase(id: string): CaseRow | undefined {
    return this.db.prepare('SELECT * FROM cases WHERE id = ?').get(id) as CaseRow | undefined;
  }

  listCases(): CaseRow[] {
    return this.db.prepare('SELECT * FROM cases ORDER BY created_at').all() as unknown as CaseRow[];
  }

  findOpenCasesByEmail(email: string): CaseRow[] {
    return this.db
      .prepare(`SELECT * FROM cases WHERE worker_email = ? AND status <> 'training_complete'`)
      .all(email.toLowerCase()) as unknown as CaseRow[];
  }

  nextCaseNumber(): number {
    const row = this.db.prepare('SELECT COUNT(*) AS n FROM cases').get() as { n: number };
    return row.n + 1;
  }

  updateCase(id: string, fields: Partial<Pick<CaseRow, 'status' | 'email_thread_id' | 'slack_user_id' | 'needs_attention'>>): void {
    const keys = Object.keys(fields) as (keyof typeof fields)[];
    if (keys.length === 0) return;
    const sets = keys.map((k) => `${k} = ?`).join(', ');
    const values = keys.map((k) => (fields[k] ?? null) as string | null);
    this.db.prepare(`UPDATE cases SET ${sets}, updated_at = ? WHERE id = ?`).run(...values, now(), id);
  }

  setStatus(id: string, status: CaseStatus): void {
    this.updateCase(id, { status });
  }

  // ---- checklist ----
  insertChecklistItem(caseId: string, key: string, label: string): void {
    this.db
      .prepare(`INSERT OR IGNORE INTO checklist_items (case_id, key, label, status, updated_at) VALUES (?, ?, ?, 'missing', ?)`)
      .run(caseId, key, label, now());
  }

  checklist(caseId: string): ChecklistItemRow[] {
    return this.db
      .prepare('SELECT * FROM checklist_items WHERE case_id = ? ORDER BY rowid')
      .all(caseId) as unknown as ChecklistItemRow[];
  }

  updateChecklistItem(
    caseId: string,
    key: string,
    fields: { status: ChecklistStatus; value?: string | null; excerpt?: string | null; note?: string | null; sourceMessageId?: string | null },
  ): void {
    const t = now();
    this.db
      .prepare(
        `UPDATE checklist_items SET status = ?, value = ?, excerpt = ?, note = ?, source_message_id = ?,
           completed_at = CASE WHEN ? = 'complete' THEN ? ELSE NULL END, updated_at = ?
         WHERE case_id = ? AND key = ?`,
      )
      .run(
        fields.status,
        fields.value ?? null,
        fields.excerpt ?? null,
        fields.note ?? null,
        fields.sourceMessageId ?? null,
        fields.status,
        t,
        t,
        caseId,
        key,
      );
  }

  // ---- messages & documents ----
  insertMessage(m: {
    caseId: string | null;
    channel: string;
    direction: 'in' | 'out';
    providerMessageId: string;
    threadId?: string | null;
    inReplyTo?: string | null;
    from?: string;
    to?: string;
    subject?: string;
    body?: string;
    correlation?: string;
  }): string {
    const id = newId('msg');
    this.db
      .prepare(
        `INSERT INTO messages (id, case_id, channel, direction, provider_message_id, thread_id, in_reply_to, from_addr, to_addr, subject, body, correlation, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        m.caseId,
        m.channel,
        m.direction,
        m.providerMessageId,
        m.threadId ?? null,
        m.inReplyTo ?? null,
        m.from ?? null,
        m.to ?? null,
        m.subject ?? null,
        m.body ?? null,
        m.correlation ?? null,
        now(),
      );
    return id;
  }

  findOutboundEmail(providerIds: string[]): { case_id: string; thread_id: string | null } | undefined {
    if (providerIds.length === 0) return undefined;
    const marks = providerIds.map(() => '?').join(',');
    return this.db
      .prepare(
        `SELECT case_id, thread_id FROM messages WHERE channel = 'email' AND direction = 'out' AND provider_message_id IN (${marks}) LIMIT 1`,
      )
      .get(...providerIds) as { case_id: string; thread_id: string | null } | undefined;
  }

  messages(caseId: string): Row[] {
    return this.db.prepare('SELECT * FROM messages WHERE case_id = ? ORDER BY created_at').all(caseId) as Row[];
  }

  unmatchedMessages(): Row[] {
    return this.db.prepare(`SELECT * FROM messages WHERE case_id IS NULL ORDER BY created_at`).all() as Row[];
  }

  insertDocument(d: { caseId: string; kind: string; filename: string; contentType: string; text: string | null; sourceMessageId: string }): string {
    const id = newId('doc');
    this.db
      .prepare(
        `INSERT INTO documents (id, case_id, kind, filename, content_type, content_text, source_message_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, d.caseId, d.kind, d.filename, d.contentType, d.text, d.sourceMessageId, now());
    return id;
  }

  documents(caseId: string, kind?: string): Row[] {
    return kind
      ? (this.db.prepare('SELECT * FROM documents WHERE case_id = ? AND kind = ? ORDER BY created_at').all(caseId, kind) as Row[])
      : (this.db.prepare('SELECT * FROM documents WHERE case_id = ? ORDER BY created_at').all(caseId) as Row[]);
  }

  // ---- inbound dedupe ----
  /** Returns false if the event was already processed. */
  claimEvent(eventKey: string, caseId: string | null, outcome: string): boolean {
    const result = this.db
      .prepare('INSERT OR IGNORE INTO processed_events (event_key, case_id, outcome, processed_at) VALUES (?, ?, ?, ?)')
      .run(eventKey, caseId, outcome, now());
    return result.changes > 0;
  }

  setEventOutcome(eventKey: string, caseId: string | null, outcome: string): void {
    this.db.prepare('UPDATE processed_events SET case_id = ?, outcome = ? WHERE event_key = ?').run(caseId, outcome, eventKey);
  }

  // ---- outbox ----
  getOutbox(actionKey: string): OutboxRow | undefined {
    return this.db.prepare('SELECT * FROM outbox WHERE action_key = ?').get(actionKey) as OutboxRow | undefined;
  }

  insertOutbox(o: { actionKey: string; caseId: string | null; channel: 'email' | 'slack'; kind: string; recipient: string; summary: string }): void {
    const t = now();
    this.db
      .prepare(
        `INSERT INTO outbox (action_key, case_id, channel, kind, recipient, summary, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
      )
      .run(o.actionKey, o.caseId, o.channel, o.kind, o.recipient, o.summary, t, t);
  }

  updateOutbox(actionKey: string, fields: { status: OutboxRow['status']; providerMessageId?: string | null; threadId?: string | null; error?: string | null }): void {
    this.db
      .prepare(`UPDATE outbox SET status = ?, provider_message_id = ?, thread_id = ?, error = ?, updated_at = ? WHERE action_key = ?`)
      .run(fields.status, fields.providerMessageId ?? null, fields.threadId ?? null, fields.error ?? null, now(), actionKey);
  }

  deleteOutbox(actionKey: string): void {
    this.db.prepare('DELETE FROM outbox WHERE action_key = ?').run(actionKey);
  }

  outbox(caseId?: string): OutboxRow[] {
    return (caseId
      ? this.db.prepare('SELECT * FROM outbox WHERE case_id = ? ORDER BY created_at').all(caseId)
      : this.db.prepare('SELECT * FROM outbox ORDER BY created_at').all()) as unknown as OutboxRow[];
  }

  /** Sends left 'pending' by a crash have an unknown outcome. */
  markStalePendingUncertain(): number {
    const r = this.db
      .prepare(`UPDATE outbox SET status = 'uncertain', error = 'process stopped mid-send; verify before resending', updated_at = ? WHERE status = 'pending'`)
      .run(now());
    return Number(r.changes);
  }

  // ---- audit ----
  audit(caseId: string | null, actor: string, type: string, detail?: unknown): void {
    this.db
      .prepare('INSERT INTO audit_events (case_id, at, actor, type, detail) VALUES (?, ?, ?, ?, ?)')
      .run(caseId, now(), actor, type, detail === undefined ? null : JSON.stringify(detail));
  }

  auditTrail(caseId: string): Row[] {
    return this.db.prepare('SELECT * FROM audit_events WHERE case_id = ? ORDER BY id').all(caseId) as Row[];
  }

  globalAudit(limit = 50): Row[] {
    return this.db.prepare('SELECT * FROM audit_events ORDER BY id DESC LIMIT ?').all(limit) as Row[];
  }
}
