import { execFile } from 'node:child_process';

// Shared helpers for driving the NemoClaw CLI on the GB10 host.

export function runCli(bin: string, args: string[], timeoutMs: number): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve, reject) => {
    execFile(bin, args, { timeout: timeoutMs, maxBuffer: 20 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err && (err as NodeJS.ErrnoException).code === 'ENOENT') return reject(new Error(`${bin} not found; run this on the GB10 host`));
      if (err && err.killed) return reject(new Error(`${bin} ${args.slice(0, 2).join(' ')} timed out after ${timeoutMs} ms`));
      resolve({ stdout: String(stdout), stderr: String(stderr), code: err ? Number((err as { code?: number }).code ?? 1) : 0 });
    });
  });
}

/** Returns the first complete top-level JSON object in mixed CLI output. */
export function firstJsonObject(text: string): unknown {
  const start = text.search(/^\{/m);
  if (start < 0) throw new Error('no JSON object in output');
  let depth = 0;
  let inString = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (ch === '\\') i++;
      else if (ch === '"') inString = false;
    } else if (ch === '"') inString = true;
    else if (ch === '{') depth++;
    else if (ch === '}' && --depth === 0) return JSON.parse(text.slice(start, i + 1));
  }
  throw new Error('unterminated JSON object in output');
}

export interface AgentTurn {
  text: string;
  model: string;
  toolCalls: number;
  tools: string[];
  toolFailures: number;
  durationMs: number;
  fallbackUsed: boolean;
  warnings: string[];
}

/** One `nemoclaw <sandbox> agent` turn in an isolated session. */
export async function agentTurn(opts: { bin: string; sandbox: string; session: string; prompt: string; timeoutMs: number }): Promise<AgentTurn> {
  const session = opts.session.replace(/[^A-Za-z0-9_-]/g, '-');
  const { stdout, stderr, code } = await runCli(opts.bin, [opts.sandbox, 'agent', '--session-id', session, '--json', '-m', opts.prompt], opts.timeoutMs);
  let run: {
    status?: string;
    result?: {
      payloads?: { text?: string }[];
      meta?: {
        durationMs?: number;
        replayInvalid?: boolean;
        agentMeta?: { model?: string };
        toolSummary?: { calls?: number; tools?: string[]; failures?: number };
        executionTrace?: { winnerModel?: string; fallbackUsed?: boolean };
      };
    };
  };
  try {
    run = firstJsonObject(stdout) as typeof run;
  } catch {
    throw new Error(`nemoclaw agent (exit ${code}) gave no JSON: ${stderr.slice(0, 200)}`);
  }
  if (run.status !== 'ok') throw new Error(`nemoclaw agent run status ${run.status ?? 'unknown'} (exit ${code})`);
  const meta = run.result?.meta ?? {};
  const warnings: string[] = [];
  // NemoClaw marks turns that used tools as not replayable and exits 1; the reply is still complete.
  if (meta.replayInvalid) warnings.push('replayInvalid: turn used tools, not replayable');
  const text = (run.result?.payloads ?? []).map((p) => p.text ?? '').join('\n').trim();
  if (!text) throw new Error('nemoclaw agent returned an empty reply');
  return {
    text,
    model: meta.executionTrace?.winnerModel ?? meta.agentMeta?.model ?? 'unknown',
    toolCalls: meta.toolSummary?.calls ?? 0,
    tools: meta.toolSummary?.tools ?? [],
    toolFailures: meta.toolSummary?.failures ?? 0,
    durationMs: meta.durationMs ?? 0,
    fallbackUsed: meta.executionTrace?.fallbackUsed ?? false,
    warnings,
  };
}
