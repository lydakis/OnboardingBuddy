// Day-1 quiz, written by the OpenClaw agent inside the sandbox with our tools
// (plan → write quiz → quiz-check), validated again on the host, previewed to the
// manager, and sent to the worker in Slack only after membership is confirmed.
import type { EngineContext } from './context.ts';
import { postSlack } from './context.ts';
import { UserError, findCase, registerCommand } from './commands.ts';
import { runSandboxTask, TOOL_CMD } from './sandbox.ts';
import { buildSnapshot } from './snapshot.ts';
import { latestPlan } from './plan.ts';
import { checkQuiz } from '../../openclaw/skills/onboarding-buddy/tools/onboarding-tools.mjs';
import type { CaseRow } from '../types.ts';

export interface Quiz {
  title: string;
  questions: { module: string; question: string; options: string[]; answer: number }[];
}

export function latestQuiz(ctx: EngineContext, caseId: string): { id: string; quiz: Quiz } | undefined {
  const row = ctx.store.documents(caseId, 'quiz').at(-1);
  return row ? { id: String(row.id), quiz: JSON.parse(String(row.content_text)) as Quiz } : undefined;
}

export async function generateQuiz(ctx: EngineContext, c: CaseRow): Promise<{ id: string; quiz: Quiz }> {
  const plan = latestPlan(ctx, c.id);
  if (!plan || !['approved', 'sent'].includes(plan.status)) throw new UserError(`${c.id} needs an approved plan before a quiz can be written.`);
  let quiz: Quiz | null = null;
  let errors: string[] = [];
  const snapshot = buildSnapshot(ctx, `case:${c.id}`);
  const turn = await runSandboxTask(
    ctx,
    {
      purpose: 'day1_quiz',
      scope: `case:${c.id}`,
      caseId: c.id,
      sessionKey: `onboarding-${c.id}-quiz`,
      prompt: (data) => [
        `Task: write a short day-1 check-in quiz for onboarding case ${c.id} at a fictional delivery company.`,
        `1. Run \`${TOOL_CMD} --data ${data} plan ${c.id}\` and \`${TOOL_CMD} --data ${data} policy\` with the exec tool.`,
        '2. Write 5 multiple-choice questions about the modules scheduled on day 1 of that plan (use the policy rules and evidence requirements). Each question: {"module": "<module id from the plan>", "question": "...", "options": ["...", "...", "..."], "answer": <index of the correct option>}.',
        `3. Save it as /tmp/quiz-${c.id}.json in the form {"title": "...", "questions": [...]} and run \`${TOOL_CMD} --data ${data} quiz-check /tmp/quiz-${c.id}.json\`. Fix it until "valid" is true.`,
        '4. Reply with the final quiz JSON only, no prose.',
        'Use only the snapshot directory above. The tools are read-only; do not try to send or change anything.',
      ].join('\n'),
    },
    (t) => {
      try {
        const text = t.text.slice(t.text.indexOf('{'), t.text.lastIndexOf('}') + 1);
        const parsed = JSON.parse(text) as Quiz;
        errors = checkQuiz(parsed, snapshot.cases[0], snapshot.policy);
        if (errors.length === 0) quiz = parsed;
      } catch {
        errors = ['agent reply was not quiz JSON'];
      }
      return quiz !== null;
    },
  );
  if (!quiz) {
    ctx.store.audit(c.id, 'agent', 'quiz_rejected', { errors: errors.slice(0, 5), model: turn.model });
    throw new UserError(`The agent's quiz failed validation (${errors.slice(0, 3).join('; ')}). Nothing was saved; try again.`);
  }
  const q = quiz as Quiz;
  const id = ctx.store.insertDocument({ caseId: c.id, kind: 'quiz', filename: `day1-quiz.json`, contentType: 'application/json', text: JSON.stringify(q), sourceMessageId: `agent:${turn.model}` });
  ctx.store.audit(c.id, 'agent', 'quiz_generated', { questions: q.questions.length, model: turn.model, toolCalls: turn.toolCalls });
  return { id, quiz: q };
}

function renderQuiz(q: Quiz, withAnswers: boolean): string {
  return [
    `*${q.title}*`,
    ...q.questions.map((x, i) => `${i + 1}. ${x.question}  _(${x.module})_\n${x.options.map((o, j) => `   ${String.fromCharCode(97 + j)}) ${o}${withAnswers && j === x.answer ? '  ✓' : ''}`).join('\n')}`),
  ].join('\n');
}

registerCommand('quiz', 'quiz <case>', async (ctx, args) => {
  const c = findCase(ctx, args[0]);
  const { id, quiz } = await generateQuiz(ctx, c);
  return {
    text: `Here's a day-1 quiz for ${c.worker_name}, based on their approved plan. Check it before sending:\n${renderQuiz(quiz, true)}`,
    buttons: [{ text: 'Send to worker in Slack', command: `quiz-send ${c.id} ${id}`, style: 'primary' }, { text: 'Write another', command: `quiz ${c.id}` }],
  };
});

registerCommand('quiz-send', 'quiz-send <case> [quiz id]', async (ctx, args) => {
  const c = findCase(ctx, args[0]);
  const latest = latestQuiz(ctx, c.id);
  if (!latest || (args[1] && args[1] !== latest.id)) throw new UserError('Send the latest quiz shown in the preview.');
  if (!c.slack_user_id) throw new UserError(`${c.worker_name} has not joined Slack yet (membership not confirmed).`);
  await postSlack(ctx, {
    actionKey: `slack:quiz:${c.id}:${latest.id}`, caseId: c.id, kind: 'quiz', channel: c.slack_user_id,
    text: `Here's a quick day-1 check-in for your training. Reply to your trainer with your answers.\n${renderQuiz(latest.quiz, false)}`,
  });
  ctx.store.audit(c.id, 'manager', 'quiz_sent', { quizId: latest.id });
  return { text: `Sent the day-1 quiz to <@${c.slack_user_id}>.` };
});
