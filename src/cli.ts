// Mock-mode driver for the running service's database:
//   npm run cli -- slack U_MGR_DANA "status"
//   npm run cli -- reply theo.park@example.net fixtures/workers/theo-beginner/reply-2.txt [cv-file]
//   npm run cli -- join U_NEW new.person@example.net "New Person"
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { loadConfig } from './config.ts';
import { createApp } from './app.ts';
import { handleSlackCommand } from './engine/commands.ts';
import { pollEmail } from './engine/intake.ts';
import { handleTeamJoin } from './engine/join.ts';

const [kind, ...args] = process.argv.slice(2);
const app = await createApp(loadConfig());
if (!app.mocks.email || !app.mocks.slack) throw new Error('The CLI drives mock adapters only.');

if (kind === 'slack') {
  const [userId, text] = args;
  const r = await handleSlackCommand(app, { eventId: `cli-${Date.now()}`, userId: userId!, channel: userId!, text: text ?? 'help' });
  console.log(r.text);
} else if (kind === 'reply') {
  const [from, bodyFile, cvFile] = args;
  app.mocks.email.replyAsWorker({
    from: from!,
    text: readFileSync(bodyFile!, 'utf8'),
    attachments: cvFile ? [{ filename: basename(cvFile), contentType: 'text/plain', text: readFileSync(cvFile, 'utf8') }] : [],
  });
  console.log(JSON.stringify(await pollEmail(app), null, 2));
} else if (kind === 'join') {
  const [id, email, name] = args;
  app.mocks.slack.addUser({ id: id!, email, realName: name });
  console.log(await handleTeamJoin(app, { eventId: `cli-join-${Date.now()}`, user: { id: id!, email, realName: name } }));
} else if (kind === 'roster') {
  const [userId, file] = args;
  const { ingestRoster } = await import('./engine/roster.ts');
  console.log(await ingestRoster(app, { managerId: userId!, channel: userId!, filename: basename(file!), bytes: readFileSync(file!), eventId: `cli-roster-${Date.now()}` }));
} else {
  console.log('usage: cli roster <manager id> <file.csv|file.xlsx> | slack <user> "<command>" | reply <from> <body file> [cv file] | join <slack id> <email> [name]');
}
app.close();
