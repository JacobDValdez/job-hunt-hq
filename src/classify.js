// Sorts job-search emails into categories and pulls out interview times and job-alert listings.
// Uses Claude when ANTHROPIC_API_KEY is set; otherwise falls back to keyword rules.
import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';

export const CATEGORIES = ['interview', 'rejection', 'offer', 'recruiter', 'application_confirmation', 'job_alert', 'other'];

const EmailAnalysis = z.object({
  category: z.enum(CATEGORIES),
  company: z.string().describe('Hiring company name, or empty string if unknown'),
  role: z.string().describe('Job title this email is about, or empty string'),
  summary: z.string().describe('One short sentence describing what the email says or asks'),
  interview: z.object({
    scheduled: z.boolean().describe('True only if a specific interview date and time is confirmed or proposed'),
    start: z.string().describe('ISO 8601 start time with UTC offset, e.g. 2026-11-24T14:00:00-05:00, or empty string'),
    end: z.string().describe('ISO 8601 end time with UTC offset, or empty string'),
    location: z.string().describe('Video link, phone number, or address, or empty string'),
  }),
  jobs: z.array(z.object({
    title: z.string(), company: z.string(), location: z.string(), url: z.string(),
  })).describe('For job_alert emails only: the job listings in the email. Empty array otherwise.'),
});

const SYSTEM = `You sort emails for someone who is looking for a job. For each email decide:
- interview: the company wants to interview, schedule a call or phone screen, or confirms an interview time.
- rejection: the company is not moving forward with the application.
- offer: a job offer.
- recruiter: a recruiter or hiring manager reaching out about a role the person has not applied to.
- application_confirmation: an automated "we received your application" message.
- job_alert: a digest of job listings (LinkedIn, Indeed, Glassdoor, ZipRecruiter, etc.).
- other: anything else, including newsletters and marketing.
Resolve relative dates ("next Tuesday at 2pm") using the email's sent date and the person's time zone.
If a time is given in another time zone, keep that zone's offset. Never invent a time that is not in the email.
For job alerts, copy the job URLs exactly as they appear in the email.`;

let client = null;
export const claudeEnabled = () => Boolean(process.env.ANTHROPIC_API_KEY);

/**
 * To keep costs near zero, the free keyword rules run first. Emails they mark "other" (newsletters,
 * marketing) skip Claude unless `force` is set, e.g. when the sender matches a company you applied to.
 */
export async function analyzeEmail(email, { force = false } = {}) {
  const kw = analyzeWithKeywords(email);
  if (!force && kw.category === 'other') return { ...kw, classified_by: 'keywords' };
  if (claudeEnabled()) {
    try {
      const result = await analyzeWithClaude(email);
      if (result) return { ...result, classified_by: 'claude' };
    } catch (e) {
      if (e instanceof Anthropic.AuthenticationError) console.error('[claude] Invalid ANTHROPIC_API_KEY — using keyword rules.');
      else if (e instanceof Anthropic.RateLimitError) console.error('[claude] Rate limited — using keyword rules for this email.');
      else if (e instanceof Anthropic.APIError) console.error(`[claude] API error ${e.status}: ${e.message}`);
      else console.error('[claude]', e.message);
    }
  }
  return { ...kw, classified_by: 'keywords' };
}

// Running token count, so the app can show what Claude has cost.
export const usage = { calls: 0, input: 0, output: 0 };

function trimBody(email, isAlert) {
  let body = email.body || '';
  // Links only matter for job alerts (they become job leads); elsewhere they're long tracking URLs.
  // Meeting links (Zoom, Meet, Teams, …) are always kept so interviews get their join link.
  const MEETING = /zoom\.us|meet\.google|teams\.microsoft|teams\.live|calendly\.com|webex\.com|goodtime\.io|whereby\.com/i;
  if (!isAlert) {
    body = body
      .replace(/\s*\((https?:\/\/[^)\s]+)\)/g, (m, url) => (MEETING.test(url) ? ` ${url}` : ''))
      .replace(/https?:\/\/\S{60,}/g, (url) => (MEETING.test(url) ? url : '[link]'));
  }
  const limit = isAlert ? 15000 : 5000;
  return body.length > limit ? body.slice(0, limit) + '\n[email continues]' : body;
}

async function analyzeWithClaude(email) {
  client ??= new Anthropic();
  const model = process.env.CLAUDE_MODEL || 'claude-opus-5-5';
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const isAlert = analyzeWithKeywords(email).category === 'job_alert';
  const response = await client.messages.parse({
    model,
    max_tokens: 8000,
    system: SYSTEM,
    // Sorting an email is simple: lowest effort, and on Haiku skip thinking entirely to save tokens.
    ...(/haiku/.test(model) ? { thinking: { type: 'disabled' } } : {}),
    output_config: { effort: 'low', format: zodOutputFormat(EmailAnalysis) },
    messages: [{
      role: 'user',
      content: `Person's time zone: ${tz}
Email sent: ${email.received_at}
From: ${email.from_name} <${email.from_addr}>
Subject: ${email.subject}

${trimBody(email, isAlert)}`,
    }],
  });
  usage.calls++;
  usage.input += response.usage?.input_tokens || 0;
  usage.output += response.usage?.output_tokens || 0;
  if (response.stop_reason === 'refusal' || !response.parsed_output) return null;
  return response.parsed_output;
}

// ---------- keyword fallback ----------
const RULES = [
  ['offer', /\b(pleased to offer|offer letter|extend (you )?an offer|job offer)\b/i],
  ['rejection', /(unfortunately|not (be )?moving forward|decided to (move|proceed) forward with other|pursue other candidates|position has been filled|not selected|regret to inform|will not be proceeding)/i],
  ['interview', /\b(interview|phone screen|schedule (a|some) (time|call)|your availability|calendly\.com|goodtime\.io|meet with (the|our) team)\b/i],
  ['application_confirmation', /(thank you for (applying|your application|your interest)|application (has been )?(received|submitted)|we('ve| have) received your application)/i],
  ['recruiter', /\b(recruiter|came across your (profile|background)|great fit for|open to (new )?opportunities|talent (partner|acquisition))\b/i],
];
const ALERT_SENDERS = /^[^@]*(alert|jobs-noreply|jobs-listings)[^@]*@|@(match\.)?indeed\.com$|glassdoor\.com$|ziprecruiter\.com$/i;

export function analyzeWithKeywords(email) {
  const text = `${email.subject}\n${email.body}`;
  let category = 'other';
  if (/application (was )?(sent|submitted) to\b/i.test(email.subject)) category = 'application_confirmation';
  else if (ALERT_SENDERS.test(email.from_addr) || /\bjob alert\b|\b\d+\+? new jobs?\b|\bjobs? (for you|matching|you may be interested)/i.test(email.subject)) category = 'job_alert';
  else for (const [cat, re] of RULES) if (re.test(text)) { category = cat; break; }

  const company = guessCompany(email);
  return {
    category, company, role: '',
    summary: email.subject,
    interview: { scheduled: false, start: '', end: '', location: (text.match(/https:\/\/[^\s"'>]*(zoom\.us|meet\.google\.com|teams\.microsoft\.com)[^\s"'<>]*/i) || [''])[0] },
    jobs: [],
  };
}

// Email services that send on behalf of employers (applicant tracking systems and job sites).
const SENDER_SERVICES = /(greenhouse|lever|workday|myworkday|ashbyhq|smartrecruiters|icims|jobvite|teamtailor|applytojob|jazzhr|brassring|taleo|successfactors|oraclecloud|ultipro|ukg|paylocity|paycom|bamboohr|workable|recruitee|breezy|dayforce|rippling|hirebridge|adp|linkedin|indeed|ziprecruiter|glassdoor|wellfound|dice|monster|careerbuilder|weworkremotely|remotetalentcloud|workremot|remotive|remoteok|flexjobs|simplyhired|aiapply|hiring\.cafe|otta|builtin|handshake|myjobhelper|jobright|talent\.com|sendgrid|mailgun|amazonses|calendly|goodtime|careerplug|aiapplymail)/i;
const FREE_MAIL = /^(gmail|googlemail|outlook|hotmail|live|msn|yahoo|ymail|icloud|me|aol|proton|protonmail|gmx)\./i;
const GENERIC_NAME = /^(no-?reply|notifications?|talent( acquisition)?|recruiting|careers?|hiring( team)?|jobs?|hr|team|support|info|workday|icims|greenhouse|lever|linkedin|indeed)$/i;

function cleanName(s = '') {
  return s.replace(/\s*(@|via|\||–|—| - ).*$/i, '')
    .replace(/\b(careers?|recruiting|recruitment|talent acquisition|talent|hiring team|hiring|jobs|hr|no-?reply|notifications?|team)\b/gi, '')
    .replace(/\s+/g, ' ').trim();
}

const titleCase = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const looksLikeCompany = (s) => s && s.length <= 50 && s.split(/\s+/).length <= 6 && (/^[A-Z]/.test(s) || /^[a-z0-9-]+\.(com|io|co|ai|org)$/.test(s))
  && !/\b(role|position|job|opportunit|the |our |your |this )/i.test(s);

function guessCompany(email) {
  const subject = email.subject || '';
  const END = '(?=[!.,:|–—(]| - |\\s(?:is|in|on|for|has|was|with)\\s|$)';
  const patterns = [
    /application (?:was )?(?:sent|submitted) to (.+?)\s*$/i,
    /^your (.+?) application\b/i,
    new RegExp(`(?:applying|application|applied) (?:to|at|with) (.+?)${END}`, 'i'),
    new RegExp(`interest in (?:joining |working (?:at|with) )?(.+?)${END}`, 'i'),
    new RegExp(`interview (?:w/\\s*|with )(.+?)${END}`, 'i'),
    /confirmed:? - (.+?) interview\b/i,
    /^([\w.&' -]{2,40}?)\s*[–—|]\s*thank you/i,
    new RegExp(`\\bat (.+?)${END}`),
  ];
  for (const re of patterns) {
    const m = subject.match(re);
    const c = m && m[1].replace(/^(the|team) /i, '').trim();
    if (looksLikeCompany(c)) return c;
  }

  const [local = '', domain = ''] = email.from_addr.toLowerCase().split('@');
  const name = cleanName(email.from_name);
  if (!domain || FREE_MAIL.test(domain)) return ''; // a person writing from a personal address
  if (SENDER_SERVICES.test(domain)) {
    if (/linkedin|calendly/.test(domain)) return ''; // display name is a person, not the employer
    // Many hiring systems put the employer in the address: crimsoneducation.teamtailor-mail.com, devoted@myworkday.com
    const sub = domain.split('.')[0];
    if (domain.split('.').length > 2 && sub.length >= 3 && !/^(mail|email|e|em|talent|us|eu|hire|jobs|careers?|notifications?|recruiting|app|www|smtp|bounce)$/.test(sub) && !SENDER_SERVICES.test(sub)) return titleCase(sub);
    if (/myworkday|workday/.test(domain) && !/no-?reply|notification|workday/.test(local)) return titleCase(local);
    return name && !GENERIC_NAME.test(name) && !SENDER_SERVICES.test(name) ? name : '';
  }

  const parts = domain.split('.');
  const sld = parts.length > 2 && /^(co|com|org|net|ac|gov)$/.test(parts[parts.length - 2]) ? parts.length - 3 : parts.length - 2;
  const base = parts[Math.max(0, sld)];
  // Prefer the sender's display name when it spells the same company ("Beyond Finance" for beyondfinance.com).
  if (name && name.toLowerCase().replace(/[^a-z0-9]/g, '') === base.replace(/[^a-z0-9]/g, '')) return name;
  return base.charAt(0).toUpperCase() + base.slice(1);
}
