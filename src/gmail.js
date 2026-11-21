// Gmail connection (read-only) using Google's OAuth 2.0 flow, plus the inbox sync.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { db, DATA_DIR, getSettings, getMeta, setMeta, nowIso } from './db.js';
import { analyzeEmail, usage } from './classify.js';
import { addAlertJobs } from './jobs.js';
import { htmlToText } from './util.js';

const TOKEN_FILE = path.join(DATA_DIR, 'google-token.json');
const SCOPE = 'https://www.googleapis.com/auth/gmail.readonly';
const API = 'https://gmail.googleapis.com/gmail/v1/users/me';
const pendingStates = new Set();

const redirectUri = () => `http://localhost:${process.env.PORT || 3000}/auth/google/callback`;
export const gmailConfigured = () => Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);

function readToken() {
  try { return JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8')); } catch { return null; }
}
function writeToken(t) { fs.writeFileSync(TOKEN_FILE, JSON.stringify(t, null, 2)); }

export function gmailStatus() {
  const t = readToken();
  return { configured: gmailConfigured(), connected: Boolean(t?.refresh_token), email: t?.email || null, lastSync: getMeta('lastGmailSync') };
}

export function authUrl() {
  const state = crypto.randomBytes(16).toString('hex');
  pendingStates.add(state);
  const p = new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID, redirect_uri: redirectUri(), response_type: 'code',
    scope: SCOPE, access_type: 'offline', prompt: 'consent', state,
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${p}`;
}

export async function handleCallback(code, state) {
  if (!pendingStates.delete(state)) throw new Error('Sign-in link expired or was not started from this app. Try Connect Gmail again.');
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code, client_id: process.env.GOOGLE_CLIENT_ID, client_secret: process.env.GOOGLE_CLIENT_SECRET,
      redirect_uri: redirectUri(), grant_type: 'authorization_code',
    }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`Google sign-in failed: ${data.error_description || data.error}`);
  const token = { ...data, expires_at: Date.now() + data.expires_in * 1000 };
  writeToken(token);
  const profile = await gmailGet('/profile');
  writeToken({ ...token, email: profile.emailAddress });
}

export function disconnect() {
  const t = readToken();
  if (t?.refresh_token) {
    fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(t.refresh_token)}`, { method: 'POST' }).catch(() => {});
  }
  fs.rmSync(TOKEN_FILE, { force: true });
}

async function accessToken() {
  const t = readToken();
  if (!t?.refresh_token) throw new Error('Gmail is not connected.');
  if (t.access_token && t.expires_at - 60_000 > Date.now()) return t.access_token;
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: process.env.GOOGLE_CLIENT_ID, client_secret: process.env.GOOGLE_CLIENT_SECRET,
      refresh_token: t.refresh_token, grant_type: 'refresh_token',
    }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`Could not refresh Gmail access (${data.error}). Reconnect Gmail in Settings.`);
  writeToken({ ...t, access_token: data.access_token, expires_at: Date.now() + data.expires_in * 1000 });
  return data.access_token;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function gmailGet(p) {
  // Gmail limits how fast one user can read mail; on a rate-limit reply, wait and retry.
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(API + p, { headers: { Authorization: `Bearer ${await accessToken()}` }, signal: AbortSignal.timeout(30000) });
    if (res.ok) return res.json();
    const body = await res.text();
    const rateLimited = res.status === 429 || (res.status === 403 && /rateLimit|quota exceeded/i.test(body));
    if (rateLimited && attempt < 6) {
      const retryAfter = Number(res.headers.get('retry-after'));
      const wait = retryAfter > 0 ? retryAfter * 1000 : Math.min(60_000, 5_000 * 2 ** attempt);
      console.log(`[gmail] Google rate limit reached, waiting ${Math.round(wait / 1000)}s…`);
      await sleep(wait);
      continue;
    }
    throw new Error(`Gmail API ${res.status}: ${body.slice(0, 200)}`);
  }
}

// ---------- message parsing ----------
const b64 = (s) => Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');

function extractBody(payload) {
  let plain = '', html = '';
  (function walk(part) {
    if (!part) return;
    if (part.body?.data) {
      if (part.mimeType === 'text/plain' && !plain) plain = b64(part.body.data);
      else if (part.mimeType === 'text/html' && !html) html = b64(part.body.data);
    }
    (part.parts || []).forEach(walk);
  })(payload);
  // Job alerts put their links in the HTML, so keep hrefs visible when converting.
  if (html) {
    const withLinks = html.replace(/<a\s[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, (_, href, text) => `${text} (${href})`);
    const fromHtml = htmlToText(withLinks);
    if (!plain || fromHtml.length > plain.length) return fromHtml;
  }
  return plain;
}

function parseFrom(v = '') {
  const m = v.match(/^\s*"?([^"<]*?)"?\s*<([^>]+)>/);
  return m ? { name: m[1].trim(), addr: m[2].trim().toLowerCase() } : { name: '', addr: v.trim().toLowerCase() };
}

// ---------- sync ----------
const JOB_QUERY = '(subject:(application OR applying OR interview OR position OR role OR job OR jobs OR opportunity OR candidate OR candidacy OR offer OR recruiter OR hiring OR "next steps") ' +
  'OR from:(linkedin.com OR indeed.com OR greenhouse.io OR lever.co OR ashbyhq.com OR myworkday.com OR workday.com OR glassdoor.com OR ziprecruiter.com OR smartrecruiters.com OR icims.com OR jobvite.com OR wellfound.com OR dice.com))';

let syncing = null;
export function syncGmail() {
  if (!syncing) syncing = doSync().finally(() => { syncing = null; });
  return syncing;
}

async function doSync() {
  const settings = getSettings();
  // The cursor only moves forward after a sync with no errors, so failed emails are retried next time.
  // Overlap by a day so nothing slips through; already-seen messages are skipped.
  const cursor = getMeta('gmailCursor');
  const since = cursor
    ? Math.floor(new Date(cursor).getTime() / 1000) - 86400
    : Math.floor(Date.now() / 1000) - settings.gmailLookbackDays * 86400;
  const startedAt = nowIso();

  const companies = db.prepare(`SELECT DISTINCT company FROM applications WHERE status NOT IN ('rejected','ghosted') AND company != '' LIMIT 40`).all()
    .map((r) => `"${r.company.replace(/"/g, '')}"`);
  const query = `after:${since} -in:sent -in:drafts ` + (companies.length ? `(${JOB_QUERY} OR ${companies.join(' OR ')})` : JOB_QUERY);

  const ids = [];
  let pageToken;
  do {
    const p = new URLSearchParams({ q: query, maxResults: '100' });
    if (pageToken) p.set('pageToken', pageToken);
    const page = await gmailGet(`/messages?${p}`);
    ids.push(...(page.messages || []).map((m) => m.id));
    pageToken = page.nextPageToken;
  } while (pageToken && ids.length < 500);

  const seen = db.prepare('SELECT 1 FROM emails WHERE id = ?');
  const fresh = ids.filter((id) => !seen.get(id)).reverse(); // oldest first so statuses update in order
  const usageBefore = { ...usage };
  const report = { startedAt, found: ids.length, processed: 0, interviews: 0, alertJobs: 0, errors: 0 };

  // Read and sort a few emails at a time (Claude takes a few seconds each), then save them oldest-first
  // so application statuses move forward in the right order.
  const BATCH = 4;
  for (let i = 0; i < fresh.length; i += BATCH) {
    const results = await Promise.all(fresh.slice(i, i + BATCH).map(async (id, k) => {
      await sleep(k * 150); // stagger requests to stay under Gmail's per-minute limit
      try {
        const msg = await gmailGet(`/messages/${id}?format=full`);
        const headers = Object.fromEntries((msg.payload?.headers || []).map((h) => [h.name.toLowerCase(), h.value]));
        const from = parseFrom(headers.from);
        const email = {
          id, thread_id: msg.threadId, from_name: from.name, from_addr: from.addr,
          subject: headers.subject || '(no subject)', snippet: htmlToText(msg.snippet || ''),
          received_at: new Date(Number(msg.internalDate)).toISOString(),
          body: extractBody(msg.payload).slice(0, 20000),
        };
        // Emails from a company you applied to always get a proper read, even if they look like marketing.
        return { email, analysis: await analyzeEmail(email, { force: Boolean(findApplication(email, '')) }) };
      } catch (e) {
        return { id, error: e };
      }
    }));
    for (const r of results) {
      if (r.error) {
        report.errors++;
        console.error(`[gmail] message ${r.id}:`, r.error.message);
        if (/not connected|refresh Gmail/.test(r.error.message)) throw r.error;
        continue;
      }
      const s = storeEmail(r.email, r.analysis);
      report.processed++;
      report.interviews += s.interview ? 1 : 0;
      report.alertJobs += s.alertJobs;
    }
    if (fresh.length > 20) console.log(`[gmail] ${Math.min(i + BATCH, fresh.length)}/${fresh.length} emails done`);
  }
  report.claude = { calls: usage.calls - usageBefore.calls, inputTokens: usage.input - usageBefore.input, outputTokens: usage.output - usageBefore.output };
  report.finishedAt = nowIso();
  if (!report.errors) setMeta('gmailCursor', startedAt);
  setMeta('lastGmailSync', report);
  console.log(`[gmail] synced ${report.processed} new emails`);
  return report;
}

// Status changes an email can cause, and which ones they may overwrite.
const STATUS_RANK = { applied: 0, replied: 1, interview: 2, rejected: 3, offer: 4 };
const CATEGORY_STATUS = { interview: 'interview', rejection: 'rejected', offer: 'offer', recruiter: 'replied' };

// "The Hunt Agency Inc" and "Hunt Agency" should count as the same company.
const normCompany = (s = '') => s.toLowerCase().replace(/&/g, ' and ')
  .replace(/\b(the|inc|llc|l\.l\.c|corp|corporation|ltd|limited|co|company|incorporated|plc|gmbh)\b\.?/g, ' ')
  .replace(/[^a-z0-9]+/g, ' ').trim();
const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function findApplication(email, company) {
  const apps = db.prepare('SELECT * FROM applications ORDER BY applied_at DESC').all();
  const hay = normCompany(`${company} ${email.from_name} ${email.from_addr.replace(/[@.]/g, ' ')} ${email.subject}`);
  const want = normCompany(company);
  return apps.find((app) => {
    const c = normCompany(app.company);
    if (c.length < 2) return false;
    if (want && want === c) return true;
    // Whole-word match only, so "Fi" doesn't match "Finance" or "confirmed".
    return new RegExp(`(^| )${escRe(c)}( |$)`).test(hay);
  });
}

export function storeEmail(email, a) {
  const result = { interview: false, alertJobs: 0 };
  let app = a.category === 'job_alert' || a.category === 'other' ? null : findApplication(email, a.company);

  // Auto-track applications discovered from email (e.g., you applied on a site the app doesn't watch).
  if (!app && a.company && ['application_confirmation', 'interview', 'rejection', 'offer'].includes(a.category)) {
    const status = a.category === 'application_confirmation' ? 'applied' : CATEGORY_STATUS[a.category];
    const info = db.prepare(`INSERT INTO applications (company, title, status, applied_at, last_activity, source, notes)
      VALUES (?, ?, ?, ?, ?, 'gmail', 'Added automatically from an email.')`)
      .run(a.company, a.role || '', status, email.received_at, email.received_at);
    app = db.prepare('SELECT * FROM applications WHERE id = ?').get(info.lastInsertRowid);
  } else if (app) {
    const next = CATEGORY_STATUS[a.category];
    if (next && STATUS_RANK[next] >= (STATUS_RANK[app.status] ?? 0)) {
      db.prepare('UPDATE applications SET status = ?, last_activity = ? WHERE id = ?').run(next, email.received_at, app.id);
    } else {
      db.prepare(`UPDATE applications SET last_activity = MAX(COALESCE(last_activity, ''), ?) WHERE id = ?`).run(email.received_at, app.id);
    }
    if (a.role && !app.title) db.prepare('UPDATE applications SET title = ? WHERE id = ?').run(a.role, app.id);
  }

  let needsDate = 0;
  if (a.category === 'interview') {
    const start = a.interview.scheduled ? new Date(a.interview.start) : null;
    // Confirmation and reminder emails describe the same interview: skip it if it's already on the calendar.
    const duplicate = start && !Number.isNaN(start.getTime()) && db.prepare(`SELECT 1 FROM events
      WHERE ABS(julianday(start_at) - julianday(?)) * 1440 < 30
        AND ((? IS NOT NULL AND application_id = ?) OR title LIKE ?)`)
      .get(start.toISOString(), app?.id ?? null, app?.id ?? null, `%${a.company || email.from_name}%`);
    if (duplicate) {
      result.interview = false;
    } else if (start && !Number.isNaN(start.getTime())) {
      const end = a.interview.end && !Number.isNaN(new Date(a.interview.end).getTime())
        ? new Date(a.interview.end).toISOString() : new Date(start.getTime() + 3600_000).toISOString();
      db.prepare(`INSERT INTO events (application_id, email_id, title, start_at, end_at, location, notes, source)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'gmail')`)
        .run(app?.id ?? null, email.id, `Interview: ${a.company || email.from_name}${a.role ? ' — ' + a.role : ''}`,
          start.toISOString(), end, a.interview.location || '', a.summary || '');
      result.interview = true;
    } else {
      needsDate = 1;
    }
  }

  if (a.category === 'job_alert' && a.jobs?.length) {
    result.alertJobs = addAlertJobs(a.jobs, email.id, email.received_at);
  }

  db.prepare(`INSERT OR REPLACE INTO emails (id, thread_id, from_name, from_addr, subject, snippet, received_at, category, company, summary, application_id, classified_by, needs_date)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(email.id, email.thread_id, email.from_name, email.from_addr, email.subject, email.snippet, email.received_at,
      a.category, a.company || '', a.summary || '', app?.id ?? null, a.classified_by, needsDate);
  return result;
}
