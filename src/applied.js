// "Did I already apply to this?" — matches job leads against your applications so the app can
// warn you before you spend time applying to the same job twice.
//
// Why this is needed: the same job often reaches you more than once (a company board, a job site,
// a LinkedIn or Indeed alert email, or a repost with a new ID), and applications found in Gmail
// aren't linked to any lead. So we compare company + job title and the posting link, not just IDs.
import { db } from './db.js';

const COMPANY_NOISE = /\b(inc|llc|ltd|limited|corp|corporation|co|company|the|gmbh|plc|group|holdings|technologies|technology)\b/g;
export const normCompany = (s) => String(s || '').toLowerCase().replace(/&/g, ' and ').replace(COMPANY_NOISE, ' ').replace(/[^a-z0-9]+/g, ' ').trim();

// Words that don't change which job it is.
const TITLE_NOISE = new Set(['remote', 'hybrid', 'onsite', 'on', 'site', 'us', 'usa', 'united', 'states', 'full', 'time', 'fulltime', 'part', 'contract', 'job', 'position', 'role', 'opening', 'the', 'and', 'of', 'for', 'a', 'an', 'in', 'at', 'to', 'with']);
// Common job-title abbreviations, spelled out so "SDR" matches "Sales Development Representative".
const ABBREV = {
  sdr: 'sales development representative', bdr: 'business development representative', ae: 'account executive',
  am: 'account manager', csm: 'customer success manager', cse: 'customer success', csr: 'customer service representative',
  sr: 'senior', jr: 'junior', mgr: 'manager', rep: 'representative', ii: '2', iii: '3', iv: '4',
};
// Seniority changes which job it is: "Account Executive" and "Senior Account Executive" are different roles.
const SENIORITY = new Set(['senior', 'junior', 'lead', 'principal', 'staff', 'head', 'director', 'vp', 'chief', 'manager', 'associate', 'intern', 'entry', 'level', '2', '3', '4']);
const titleWords = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').split(' ')
  .flatMap((w) => (ABBREV[w] || w).split(' '))
  .filter((w) => w && (w.length > 1 || /\d/.test(w)) && !TITLE_NOISE.has(w));

// 1 = same words, 0 = nothing in common. Measured against the shorter title, so
// "Sales Development Representative" matches "Sales Development Representative (SDR) - Remote".
export function titleSimilarity(a, b) {
  const A = new Set(titleWords(a)), B = new Set(titleWords(b));
  if (!A.size || !B.size) return 0;
  let shared = 0;
  for (const w of A) if (B.has(w)) shared++;
  const sim = shared / Math.min(A.size, B.size);
  const levelDiffers = [...A, ...B].some((w) => SENIORITY.has(w) && A.has(w) !== B.has(w));
  return levelDiffers ? Math.min(sim, 0.5) : sim;
}
const SAME_TITLE = 0.8;

// Posting links without tracking bits, so ?utm_source=... doesn't hide a match.
export function normUrl(u) {
  try {
    const x = new URL(u);
    return `${x.hostname.replace(/^www\./, '')}${x.pathname.replace(/\/+$/, '')}`.toLowerCase();
  } catch { return ''; }
}

/** Build once per request: all applications, grouped by company and by link. */
export function appliedIndex() {
  const apps = db.prepare('SELECT id, job_id, company, title, url, status, applied_at FROM applications').all();
  const byCompany = new Map(), byUrl = new Map(), byJob = new Map();
  for (const a of apps) {
    const c = normCompany(a.company);
    if (c) (byCompany.get(c) || byCompany.set(c, []).get(c)).push(a);
    const u = normUrl(a.url);
    if (u) byUrl.set(u, a);
    if (a.job_id) byJob.set(a.job_id, a);
  }
  return { byCompany, byUrl, byJob };
}

const brief = (a) => ({ id: a.id, company: a.company, title: a.title, status: a.status, applied_at: a.applied_at });

/**
 * What you've already done for this job.
 * - { level: 'same', app, how }  you applied to this exact job (same lead, same link, or same company + title)
 * - { level: 'company', apps }   you applied to other roles at this company
 * - null                         nothing yet
 */
export function priorApplication(job, index = appliedIndex()) {
  const direct = index.byJob.get(job.id);
  if (direct) return { level: 'same', how: 'this lead', app: brief(direct) };
  const u = normUrl(job.url);
  if (u && index.byUrl.has(u)) return { level: 'same', how: 'same posting link', app: brief(index.byUrl.get(u)) };
  const atCompany = index.byCompany.get(normCompany(job.company)) || [];
  const best = atCompany
    .map((a) => ({ a, sim: titleSimilarity(a.title, job.title) }))
    .filter((x) => x.sim >= SAME_TITLE)
    .sort((x, y) => y.sim - x.sim || (y.a.applied_at > x.a.applied_at ? 1 : -1))[0];
  if (best) return { level: 'same', how: 'same company and job title', app: brief(best.a) };
  if (atCompany.length) return { level: 'company', apps: atCompany.map(brief) };
  return null;
}

/** For the manual "Add application" form: is this already in your tracker? */
export function existingApplication(company, title) {
  const c = normCompany(company);
  if (!c) return null;
  const rows = db.prepare('SELECT id, company, title, status, applied_at FROM applications').all().filter((a) => normCompany(a.company) === c);
  if (!rows.length) return null;
  const same = title ? rows.find((a) => titleSimilarity(a.title, title) >= SAME_TITLE) : rows.find((a) => !a.title);
  return same ? brief(same) : null;
}
