// Company logos: finds a company's website, downloads its icon once, and keeps it in data/logos.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { db, DATA_DIR } from './db.js';

const LOGO_DIR = path.join(DATA_DIR, 'logos');
fs.mkdirSync(LOGO_DIR, { recursive: true });

const NOT_EMPLOYER = /(greenhouse|lever\.co|workday|ashbyhq|smartrecruiters|icims|jobvite|teamtailor|applytojob|jazzhr|brassring|taleo|successfactors|oraclecloud|ultipro|paylocity|paycom|bamboohr|workable|recruitee|breezy|dayforce|rippling|adp\.com|calendly|goodtime|careerplug|sendgrid|mailgun|amazonses|gmail|googlemail|outlook|hotmail|live\.com|yahoo|icloud|aol|proton)/i;
const DOMAIN_RE = /^[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}$/;
const MISS_TTL = 7 * 86400_000; // retry companies with no logo after a week
const inflight = new Map();

const fileFor = (key) => path.join(LOGO_DIR, crypto.createHash('sha1').update(key).digest('hex').slice(0, 20));

function slug(company) {
  return company.toLowerCase()
    .replace(/&/g, 'and')
    .replace(/\b(inc|llc|l\.l\.c|corp|corporation|ltd|limited|co|company|group|holdings|incorporated|plc|gmbh|the)\b\.?/g, '')
    .replace(/[^a-z0-9]/g, '');
}

/** Best guess at the company's own website domain. */
function domainFor(company) {
  const c = company.trim();
  if (DOMAIN_RE.test(c.toLowerCase())) return c.toLowerCase(); // "hear.com"
  // A real address the company emailed you from is the most reliable clue.
  const rows = db.prepare(`SELECT from_addr FROM emails WHERE company = ? COLLATE NOCASE ORDER BY received_at DESC LIMIT 20`).all(c);
  for (const { from_addr } of rows) {
    const domain = (from_addr.split('@')[1] || '').toLowerCase();
    if (domain && !NOT_EMPLOYER.test(domain) && !/linkedin|indeed/.test(domain)) {
      const parts = domain.split('.');
      return parts.slice(-2).join('.') === 'co.uk' ? parts.slice(-3).join('.') : parts.slice(-2).join('.');
    }
  }
  const s = slug(c);
  return s.length >= 2 ? `${s}.com` : null;
}

async function download(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(8000), headers: { 'User-Agent': 'JobHuntHQ/1.0' } });
  const type = res.headers.get('content-type') || '';
  if (!res.ok || !type.startsWith('image/')) return null;
  const buf = Buffer.from(await res.arrayBuffer());
  return buf.length > 100 ? { type, buf } : null;
}

async function findLogo(company, domain) {
  // 1) Logo URL supplied by the job board itself (Remotive, RemoteOK).
  if (company) {
    const row = db.prepare(`SELECT logo FROM jobs WHERE company = ? COLLATE NOCASE AND logo LIKE 'https://%' LIMIT 1`).get(company);
    if (row) { const r = await download(row.logo).catch(() => null); if (r) return r; }
  }
  // 2) The website's icon, via Google's public favicon service (only the domain name is sent).
  const d = domain || (company && domainFor(company));
  if (!d) return null;
  return download(`https://www.google.com/s2/favicons?domain=${encodeURIComponent(d)}&sz=64`).catch(() => null);
}

/** Returns { type, buf } or null when no logo exists (cached either way). */
export async function getLogo({ company = '', domain = '' }) {
  company = String(company).trim().slice(0, 100);
  domain = String(domain).trim().toLowerCase();
  if (domain && !DOMAIN_RE.test(domain)) domain = '';
  if (!company && !domain) return null;
  const key = domain ? `d:${domain}` : `c:${company.toLowerCase()}`;
  const file = fileFor(key);

  try {
    const meta = JSON.parse(fs.readFileSync(file + '.json', 'utf8'));
    if (meta.type) return { type: meta.type, buf: fs.readFileSync(file) };
    if (Date.now() - meta.at < MISS_TTL) return null;
  } catch { /* not cached yet */ }

  if (!inflight.has(key)) {
    inflight.set(key, findLogo(company, domain).then((r) => {
      if (r) fs.writeFileSync(file, r.buf);
      fs.writeFileSync(file + '.json', JSON.stringify({ type: r?.type || null, at: Date.now() }));
      return r;
    }).finally(() => inflight.delete(key)));
  }
  return inflight.get(key);
}
