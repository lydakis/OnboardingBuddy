#!/usr/bin/env node
// Onboarding Buddy business tools for the OpenClaw agent inside the NemoClaw sandbox.
// Read-only over a snapshot the host service uploads; no network, no credentials.
// Usage: node onboarding-tools.mjs --data <snapshot dir> <command> [args]
//   cases | case <id> | plan <id> | policy | blockers | quiz-check <quiz.json | ->
import { readFileSync } from 'node:fs';

const args = process.argv.slice(2);
let dir = process.env.ONBOARDING_DATA ?? '.';
if (args[0] === '--data') { dir = args[1]; args.splice(0, 2); }
const [command, arg] = args;

function load() {
  return JSON.parse(readFileSync(`${dir}/snapshot.json`, 'utf8'));
}
function out(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}
function fail(message) {
  out({ error: message });
  process.exit(1);
}
function findCase(snap, id) {
  const c = snap.cases.find((x) => x.id.toUpperCase() === String(id ?? '').toUpperCase());
  if (!c) fail(`no case "${id}" in this snapshot (scope: ${snap.scope})`);
  return c;
}

export function checkQuiz(quiz, c, policy) {
  const errors = [];
  const planModules = new Set((c?.plan?.modules ?? []).map((m) => m.id));
  if (!quiz || !Array.isArray(quiz.questions)) return ['quiz must be {"title", "questions": [...]}'];
  if (typeof quiz.title !== 'string' || !quiz.title.trim()) errors.push('missing title');
  if (quiz.questions.length < 4 || quiz.questions.length > 8) errors.push('need 4 to 8 questions');
  quiz.questions.forEach((q, i) => {
    if (typeof q.question !== 'string' || q.question.length < 10) errors.push(`q${i + 1}: question too short`);
    if (!Array.isArray(q.options) || q.options.length < 3 || q.options.length > 4) errors.push(`q${i + 1}: need 3-4 options`);
    if (!Number.isInteger(q.answer) || q.answer < 0 || q.answer >= (q.options?.length ?? 0)) errors.push(`q${i + 1}: answer must index an option`);
    if (!planModules.has(q.module)) errors.push(`q${i + 1}: module "${q.module}" is not in this worker's approved plan`);
    if (policy && !policy.modules.some((m) => m.id === q.module)) errors.push(`q${i + 1}: module not in policy`);
  });
  return errors;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const snap = load();
  switch (command) {
    case 'cases':
      out(snap.cases.map(({ id, worker, status, needsAttention, intake, invitation }) => ({ id, worker, status, needsAttention, intake, invitation: invitation?.state ?? null })));
      break;
    case 'case': {
      const { plan, ...rest } = findCase(snap, arg);
      out({ ...rest, plan: plan ? { version: plan.version, status: plan.status, track: plan.track.label, openReview: plan.reviewItems.filter((r) => r.blocking && !r.resolution).map((r) => r.id) } : null });
      break;
    }
    case 'plan': {
      const c = findCase(snap, arg);
      if (!c.plan) fail(`${c.id} has no plan yet`);
      out(c.plan);
      break;
    }
    case 'policy':
      out(snap.policy);
      break;
    case 'blockers':
      out(snap.cases.flatMap((c) => {
        const items = [];
        if (c.needsAttention) items.push({ case: c.id, issue: c.needsAttention });
        for (const r of c.plan?.reviewItems ?? []) if (r.blocking && !r.resolution) items.push({ case: c.id, issue: `plan review: ${r.id}` });
        if (c.invitation?.state === 'needs_review') items.push({ case: c.id, issue: `identity review: ${c.invitation.reviewReason}` });
        if (c.intake && c.intake.missing.length && c.status === 'intake') items.push({ case: c.id, issue: `intake missing: ${c.intake.missing.join(', ')}` });
        return items;
      }));
      break;
    case 'quiz-check': {
      const raw = arg === '-' || !arg ? readFileSync(0, 'utf8') : readFileSync(arg, 'utf8');
      let quiz;
      try { quiz = JSON.parse(raw); } catch { fail('quiz is not valid JSON'); }
      const c = snap.scope.startsWith('case:') ? snap.cases[0] : findCase(snap, quiz.caseId);
      const errors = checkQuiz(quiz, c, snap.policy);
      out({ valid: errors.length === 0, errors });
      break;
    }
    default:
      fail('commands: cases | case <id> | plan <id> | policy | blockers | quiz-check <file|->');
  }
}
