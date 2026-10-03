import type { App } from '../app.ts';
import type { Log } from './scenario.ts';
import { runPhase1, runPhase2, runPhase3 } from './scenario.ts';

export const PHASES: ((app: App, log: Log) => Promise<void>)[] = [runPhase1, runPhase2, runPhase3];
