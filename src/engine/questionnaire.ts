// Intake checklist definition and the deterministic reply parser.
// Worker emails are untrusted data: we only ever pull labelled answers out of them
// and validate each one; nothing in an email can trigger an action by itself.

export interface Question {
  key: string;
  label: string;
  prompt: string;
  /** Returns the normalized value, or an error string explaining what is wrong. */
  validate(raw: string): { value: string } | { error: string };
}

const EMAIL_RE = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;

export const QUESTIONS: Question[] = [
  {
    key: 'preferred_name',
    label: 'Preferred name',
    prompt: 'What name would you like us to use?',
    validate: (raw) => (raw.length >= 1 && raw.length <= 80 ? { value: raw } : { error: 'Please give the name you would like us to use.' }),
  },
  {
    key: 'linkedin',
    label: 'LinkedIn',
    prompt: 'Your LinkedIn profile URL (or "none" if you do not use LinkedIn).',
    validate: (raw) => {
      if (/^(none|n\/a|no linkedin)$/i.test(raw)) return { value: 'none' };
      const m = raw.match(/(https?:\/\/)?(www\.)?linkedin\.com\/in\/[A-Za-z0-9_-]+\/?/i);
      return m ? { value: m[0] } : { error: 'That does not look like a LinkedIn profile URL (linkedin.com/in/...). Reply "none" if you do not have one.' };
    },
  },
  {
    key: 'drivers_license',
    label: "Driver's license",
    prompt: 'Do you hold a driver\'s license? Give the class (for example "Class C" or "CDL-B"), or "none".',
    validate: (raw) => {
      if (/^(none|no|n\/a)$/i.test(raw)) return { value: 'none' };
      return /(class|cdl|license|licence|[A-D]\b)/i.test(raw) ? { value: raw } : { error: 'Please give your license class, or "none".' };
    },
  },
  {
    key: 'delivery_experience',
    label: 'Delivery/logistics experience',
    prompt: 'Briefly describe any delivery, courier, warehouse or logistics experience, with roughly how many years (or "none").',
    validate: (raw) => (/^(none|no)$/i.test(raw) ? { value: 'none' } : raw.length >= 3 ? { value: raw } : { error: 'Please describe your experience, or reply "none".' }),
  },
  {
    key: 'equipment',
    label: 'Equipment used',
    prompt: 'Which of these have you used: handheld scanner, pallet jack, hand truck, forklift, box truck? (or "none")',
    validate: (raw) => (raw.length >= 2 ? { value: raw } : { error: 'Please list equipment you have used, or "none".' }),
  },
  {
    key: 'preferred_shift',
    label: 'Preferred shift',
    prompt: 'Preferred shift: early, day, or late.',
    validate: (raw) => {
      const m = raw.toLowerCase().match(/\b(early|day|late)\b/);
      return m ? { value: m[1]! } : { error: 'Please choose one of: early, day, late.' };
    },
  },
  {
    key: 'slack_email',
    label: 'Email for Slack invite',
    prompt: 'Which email address should we use to invite you to our team Slack?',
    validate: (raw) => {
      const m = raw.match(/[^\s@<>:]+@[^\s@<>]+\.[A-Za-z]{2,}/);
      return m && EMAIL_RE.test(m[0]) ? { value: m[0].toLowerCase() } : { error: 'Please give a valid email address.' };
    },
  },
];

export const CV_ITEM = { key: 'cv', label: 'CV / résumé' } as const;

export const CHECKLIST: { key: string; label: string }[] = [CV_ITEM, ...QUESTIONS.map((q) => ({ key: q.key, label: q.label }))];

const ALIASES: Record<string, string[]> = {
  preferred_name: ['preferred name', 'name'],
  linkedin: ['linkedin', 'linkedin url', 'linkedin profile'],
  drivers_license: ["driver's license", 'drivers license', 'driver license', 'license', 'licence', "driver's licence"],
  delivery_experience: ['delivery/logistics experience', 'delivery experience', 'logistics experience', 'experience'],
  equipment: ['equipment used', 'equipment'],
  preferred_shift: ['preferred shift', 'shift'],
  slack_email: ['email for slack invite', 'slack email', 'email for slack'],
};

/** Removes quoted history so labels in our own template are not re-read as answers. */
export function stripQuoted(text: string): string {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const out: string[] = [];
  for (const line of lines) {
    if (/^On .+wrote:\s*$/.test(line.trim()) || /^-{2,}\s*Original Message\s*-{2,}$/i.test(line.trim())) break;
    if (line.trimStart().startsWith('>')) continue;
    out.push(line);
  }
  return out.join('\n');
}

export interface ParsedAnswer {
  key: string;
  raw: string;
  excerpt: string;
  result: { value: string } | { error: string };
}

/** Parse "Label: answer" lines. Unlabelled prose is ignored rather than guessed at. */
export function parseAnswers(body: string): { answers: ParsedAnswer[]; cvText: string | null } {
  const text = stripQuoted(body);
  const answers = new Map<string, ParsedAnswer>();
  let cvText: string | null = null;
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const m = line.match(/^\s*(?:\d+[.)]\s*)?([A-Za-z'’ /]+?)\s*[:\-–]\s*(.*)$/);
    if (!m) continue;
    const label = m[1]!.toLowerCase().replace('’', "'").trim();
    const raw = m[2]!.trim();
    if (label === 'cv' || label === 'resume' || label === 'résumé') {
      const rest = [raw, ...lines.slice(i + 1)].join('\n').trim();
      if (rest.length > 40) cvText = rest;
      break;
    }
    const key = Object.keys(ALIASES).find((k) => ALIASES[k]!.includes(label));
    if (!key) continue;
    if (raw === '' || /^(\?|tbd|todo|later|-+)$/i.test(raw)) continue;
    const question = QUESTIONS.find((q) => q.key === key)!;
    answers.set(key, { key, raw, excerpt: line.trim(), result: question.validate(raw) });
  }
  return { answers: [...answers.values()], cvText };
}

export function questionnaireTemplate(): string {
  return QUESTIONS.map((q) => `${q.label}: `).join('\n');
}
