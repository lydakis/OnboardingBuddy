// Advisory readiness estimate from the local model in ml/ (beginner / okay / expert).
// It reads the per-case feature snapshot written when the questionnaire is confirmed and
// runs entirely on this machine. The estimate is shown to the manager only and never
// changes modules or stop targets on its own; a mismatch with the policy track becomes a
// non-blocking review note.
//
// Enabled when OB_READINESS_CMD is set (the snapshot path is appended as the last
// argument and the command must print predict.py's JSON), or automatically when ml/ has
// a trained model and its virtualenv. OB_READINESS=off turns it off.
import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { EngineContext } from './context.ts';
import type { Readiness, ReadinessLabel } from './policy.ts';

const LABELS: ReadinessLabel[] = ['beginner', 'okay', 'expert'];
const ML_DIR = new URL('../../ml/', import.meta.url).pathname;
const cache = new Map<string, Readiness>();

function command(snapshotPath: string): { file: string; args: string[]; cwd?: string } | null {
  if (process.env.OB_READINESS === 'off') return null;
  const custom = process.env.OB_READINESS_CMD;
  if (custom) return { file: '/bin/sh', args: ['-c', `${custom} "$1"`, 'readiness', snapshotPath] };
  const python = join(ML_DIR, '.venv/bin/python');
  if (existsSync(python) && existsSync(join(ML_DIR, 'artifacts/catboost.cbm'))) {
    return { file: python, args: ['predict.py', snapshotPath, '--model', 'catboost', '--artifacts', 'artifacts'], cwd: ML_DIR };
  }
  return null;
}

export function parsePrediction(stdout: string): Readiness | null {
  try {
    const out = JSON.parse(stdout.slice(stdout.indexOf('{'), stdout.lastIndexOf('}') + 1)) as { label?: unknown; probabilities?: Record<string, unknown> };
    const label = out.label as ReadinessLabel;
    const p = Number(out.probabilities?.[label]);
    if (!LABELS.includes(label) || !Number.isFinite(p) || p < 0 || p > 1) return null;
    return { label, confidence: Math.round(p * 100) / 100 };
  } catch {
    return null;
  }
}

/** Latest snapshot's estimate, or null when the model isn't set up or fails (the plan never waits on it). */
export async function predictReadiness(ctx: EngineContext, caseId: string): Promise<Readiness | null> {
  const snap = ctx.store.db
    .prepare('SELECT version, json FROM feature_snapshots WHERE case_id = ? ORDER BY version DESC LIMIT 1')
    .get(caseId) as { version: number; json: string } | undefined;
  if (!snap) return null;
  const key = `${ctx.config.dbPath}:${caseId}:v${snap.version}`;
  if (cache.has(key)) return cache.get(key)!;
  const dir = mkdtempSync(join(tmpdir(), 'ob-readiness-'));
  const path = join(dir, `${caseId}.json`);
  const cmd = command(path);
  if (!cmd) { rmSync(dir, { recursive: true, force: true }); return null; }
  writeFileSync(path, snap.json);
  const result = await new Promise<Readiness | null>((resolve) => {
    execFile(cmd.file, cmd.args, { cwd: cmd.cwd, timeout: 30_000 }, (err, stdout) => resolve(err ? null : parsePrediction(String(stdout))));
  });
  rmSync(dir, { recursive: true, force: true });
  ctx.store.audit(caseId, 'agent', result ? 'readiness_estimated' : 'readiness_unavailable', result ? { ...result, snapshot: snap.version } : { snapshot: snap.version });
  if (result) cache.set(key, result);
  return result;
}
