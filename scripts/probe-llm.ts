// Live check of the local model endpoint: one extraction on a synthetic fixture.
//   OB_LLM_MODE=openai-compatible OB_LLM_BASE_URL=... OB_LLM_MODEL=... npm run probe:llm -- rosa-experienced
import { readFileSync } from 'node:fs';
import { loadConfig } from '../src/config.ts';
import { OpenAiCompatibleLlm } from '../src/adapters/llm/openai-compatible.ts';
import { EXTRACTION_SCHEMA, buildExtractionMessages, validateExtraction } from '../src/engine/extract.ts';

const config = loadConfig();
if (config.llm.mode !== 'openai-compatible') throw new Error('Set OB_LLM_MODE=openai-compatible, OB_LLM_BASE_URL and OB_LLM_MODEL');
const worker = process.argv[2] ?? 'rosa-experienced';
const dir = new URL(`../fixtures/workers/${worker}/`, import.meta.url);
const cv = readFileSync(new URL('cv.txt', dir), 'utf8');
const questionnaire = readFileSync(new URL(worker.startsWith('rosa') ? 'reply-1.txt' : 'reply-1-partial.txt', dir), 'utf8');
const llm = new OpenAiCompatibleLlm({ baseUrl: config.llm.baseUrl!, model: config.llm.model!, apiKey: config.llm.apiKey, timeoutMs: config.llm.timeoutMs, disableThinking: config.llm.disableThinking });
const started = Date.now();
const raw = await llm.complete(buildExtractionMessages(cv, questionnaire), { jsonSchema: EXTRACTION_SCHEMA, sessionKey: `probe-${worker}` });
console.log(`model ${config.llm.model} answered in ${Date.now() - started} ms`);
console.log(raw.slice(0, 3000));
const result = validateExtraction(raw, { cv, questionnaire });
console.log(`\nvalid facts: ${result.facts.length}, rejected: ${result.errors.length}`);
for (const e of result.errors) console.log(`  ✗ ${e}`);
