import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config.ts';
import { createApp } from '../src/app.ts';
import type { App } from '../src/app.ts';
import { handleSlackCommand } from '../src/engine/commands.ts';

export function tempDbPath(): string {
  return join(mkdtempSync(join(tmpdir(), 'obuddy-')), 'test.db');
}

export async function makeApp(dbPath = tempDbPath()): Promise<App> {
  const env: NodeJS.ProcessEnv = { OB_DB_PATH: dbPath, OB_MANAGER_SLACK_IDS: 'U_MGR_DANA,U_MGR_SAM' };
  return createApp(loadConfig(env));
}

let seq = 0;
export function command(app: App, userId: string, text: string) {
  return handleSlackCommand(app, { eventId: `t-${++seq}-${Date.now()}`, userId, channel: userId, text });
}

export const FULL_ANSWERS = [
  'Preferred name: Rosa',
  'LinkedIn: https://www.linkedin.com/in/rosa-delgado-demo',
  "Driver's license: CDL-B",
  'Delivery/logistics experience: 5 years route driver',
  'Equipment used: handheld scanner, box truck',
  'Preferred shift: early',
  'Email for Slack invite: rosa.delgado@example.net',
].join('\n');

export const CV = { filename: 'cv.txt', contentType: 'text/plain', text: 'ROSA DELGADO — Route Driver, Coastline Parcel Co. (fictional), March 2021 to August 2026.' };
