// Job sources. Each fetcher returns an array of normalized jobs:
// { id, source, title, company, location, remote, anywhere, url, description, salary, tags, posted_at, logo }
// `anywhere` = no location requirement at all (work from any country), as opposed to "Remote (US only)".
import { fetchJson, fetchText, parseRss, htmlToText, toIso, sleep } from './util.js';

const clip = (s, n = 8000) => (s && s.length > n ? s.slice(0, n) + '…' : s || '');
const ANYWHERE = /\b(anywhere|worldwide|global(ly)?|any (country|location))\b/i;
const money = (min, max, cur = 'USD', period = '') => {
  if (!min && !max) return '';
  const sym = cur === 'USD' || !cur ? '$' : `${cur} `;
  const f = (n) => `${sym}${Math.round(n).toLocaleString()}`;
  return `${min ? f(min) : ''}${min && max ? '–' : ''}${max ? f(max) : ''}${period && period !== 'annual' ? `/${period.replace(/ly$/, '')}` : ''}`;
};

async function weworkremotely() {
  // Category feeds relevant to sales, support, web/design and general roles; keyword matching narrows them down.
  const feeds = ['remote-sales-and-marketing-jobs', 'remote-customer-support-jobs', 'remote-design-jobs', 'all-other-remote-jobs', 'remote-full-stack-programming-jobs'];
  const out = [];
  for (const feed of feeds) {
    const xml = await fetchText(`https://weworkremotely.com/categories/${feed}.rss`);
    for (const it of parseRss(xml)) {
      const [company, ...rest] = (it.title || '').split(': ');
      const region = it.region || '';
      out.push({
        id: `wwr:${(it.guid || it.link || '').replace(/^.*\/remote-jobs\//, '')}`, source: 'We Work Remotely',
        title: rest.join(': ') || it.title, company: rest.length ? company : '', location: region || 'Remote',
        remote: 1, anywhere: /anywhere in the world/i.test(region) ? 1 : 0, url: it.link || it.guid,
        description: clip(htmlToText(it.description)), salary: '', tags: [it.category, it.type].filter(Boolean).join(', '),
        posted_at: toIso(it.pubDate), logo: (it['media:content'] || '').match(/https:\/\/[^"\s]+/)?.[0] || '',
      });
    }
  }
  return out;
}

async function himalayas(settings) {
  const out = [];
  const queries = settings.keywords.length ? settings.keywords : [''];
  for (const q of queries) {
    const data = await fetchJson(`https://himalayas.app/jobs/api/search?q=${encodeURIComponent(q)}&limit=20`);
    for (const j of data.jobs || []) {
      const where = j.locationRestrictions || [];
      // Skip jobs only open to people in other countries.
      const home = (settings.homeCountry || '').toLowerCase();
      if (where.length && home && !where.some((w) => w.toLowerCase().includes(home))) continue;
      out.push({
        id: `himalayas:${(j.guid || '').replace(/^.*\/companies\//, '')}`, source: 'Himalayas',
        title: j.title, company: j.companyName, location: where.length ? `Remote (${where.slice(0, 3).join(', ')}${where.length > 3 ? '…' : ''})` : 'Anywhere in the world',
        remote: 1, anywhere: where.length ? 0 : 1, url: j.applicationLink || j.guid,
        description: clip(htmlToText(j.description || j.excerpt)), salary: money(j.minSalary, j.maxSalary, j.currency, j.salaryPeriod),
        tags: [...(j.seniority || []), j.employmentType].filter(Boolean).join(', '), posted_at: toIso(j.pubDate), logo: j.companyLogo || '',
      });
    }
    await sleep(400); // be polite to their free API
  }
  return out;
}

async function ashby(settings) {
  const out = [];
  const errors = [];
  for (const org of settings.ashbyCompanies) {
    try {
      const data = await fetchJson(`https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(org)}?includeCompensation=true`);
      const name = org.charAt(0).toUpperCase() + org.slice(1);
      for (const j of data.jobs || []) {
        if (j.isListed === false) continue;
        const loc = [j.location, ...(j.secondaryLocations || []).map((s) => s.location)].filter(Boolean).join(' / ');
        out.push({
          id: `ashby:${org}:${j.id}`, source: 'Ashby', title: j.title, company: name, location: loc || (j.isRemote ? 'Remote' : ''),
          remote: j.isRemote || /remote/i.test(loc) ? 1 : 0, anywhere: ANYWHERE.test(loc) ? 1 : 0, url: j.jobUrl,
          description: clip(j.descriptionPlain || htmlToText(j.descriptionHtml)), salary: j.compensation?.compensationTierSummary || '',
          tags: [j.department, j.employmentType].filter(Boolean).join(', '), posted_at: toIso(j.publishedAt),
        });
      }
    } catch (e) { errors.push(`${org}: ${e.message}`); }
  }
  if (errors.length && !out.length) throw new Error(errors.join('; '));
  return out;
}

async function remotive(settings) {
  const out = [];
  for (const kw of settings.keywords.length ? settings.keywords : ['']) {
    const data = await fetchJson(`https://remotive.com/api/remote-jobs?limit=100&search=${encodeURIComponent(kw)}`);
    for (const j of data.jobs || []) {
      out.push({
        id: `remotive:${j.id}`, source: 'Remotive', title: j.title, company: j.company_name,
        location: j.candidate_required_location || 'Remote', remote: 1, anywhere: ANYWHERE.test(j.candidate_required_location || '') ? 1 : 0, url: j.url,
        description: clip(htmlToText(j.description)), salary: j.salary || '',
        tags: (j.tags || []).join(', '), posted_at: toIso(j.publication_date), logo: j.company_logo || j.company_logo_url || '',
      });
    }
  }
  return out;
}

async function arbeitnow() {
  const out = [];
  for (let page = 1; page <= 3; page++) {
    const data = await fetchJson(`https://www.arbeitnow.com/api/job-board-api?page=${page}`);
    for (const j of data.data || []) {
      out.push({
        id: `arbeitnow:${j.slug}`, source: 'Arbeitnow', title: j.title, company: j.company_name,
        location: j.location || '', remote: j.remote ? 1 : 0, url: j.url,
        description: clip(htmlToText(j.description)), salary: '',
        tags: [...(j.tags || []), ...(j.job_types || [])].join(', '), posted_at: toIso(j.created_at),
      });
    }
    if (!data.links?.next) break;
  }
  return out;
}

async function remoteok() {
  const data = await fetchJson('https://remoteok.com/api');
  return (Array.isArray(data) ? data : [])
    .filter((j) => j && j.id && j.position)
    .map((j) => ({
      id: `remoteok:${j.id}`, source: 'RemoteOK', title: j.position, company: j.company,
      location: j.location || 'Remote', remote: 1, anywhere: ANYWHERE.test(`${j.location || ''} ${(j.tags || []).join(' ')}`) ? 1 : 0, url: j.url || j.apply_url,
      description: clip(htmlToText(j.description)),
      salary: j.salary_min ? `$${j.salary_min.toLocaleString()}–$${(j.salary_max || j.salary_min).toLocaleString()}` : '',
      tags: (j.tags || []).join(', '), posted_at: toIso(j.epoch || j.date), logo: j.company_logo || j.logo || '',
    }));
}

async function greenhouse(settings) {
  const out = [];
  const errors = [];
  for (const token of settings.greenhouseCompanies) {
    try {
      const data = await fetchJson(`https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(token)}/jobs?content=true`);
      for (const j of data.jobs || []) {
        const loc = j.location?.name || '';
        out.push({
          id: `greenhouse:${token}:${j.id}`, source: 'Greenhouse', title: j.title,
          company: j.company_name || token, location: loc, remote: /remote/i.test(loc) ? 1 : 0, anywhere: ANYWHERE.test(loc) ? 1 : 0,
          url: j.absolute_url, description: clip(htmlToText(j.content)), salary: '', tags: '',
          posted_at: toIso(j.first_published || j.updated_at),
        });
      }
    } catch (e) { errors.push(`${token}: ${e.message}`); }
  }
  if (errors.length && !out.length) throw new Error(errors.join('; '));
  return out;
}

async function lever(settings) {
  const out = [];
  const errors = [];
  for (const company of settings.leverCompanies) {
    try {
      const data = await fetchJson(`https://api.lever.co/v0/postings/${encodeURIComponent(company)}?mode=json`);
      for (const j of Array.isArray(data) ? data : []) {
        const loc = j.categories?.location || '';
        out.push({
          id: `lever:${company}:${j.id}`, source: 'Lever', title: j.text, company,
          location: loc, remote: j.workplaceType === 'remote' || /remote/i.test(loc) ? 1 : 0, anywhere: ANYWHERE.test(loc) ? 1 : 0,
          url: j.hostedUrl, description: clip(j.descriptionPlain || htmlToText(j.description)),
          salary: j.salaryRange ? `${j.salaryRange.min}–${j.salaryRange.max} ${j.salaryRange.currency || ''}` : '',
          tags: [j.categories?.team, j.categories?.commitment].filter(Boolean).join(', '),
          posted_at: toIso(j.createdAt),
        });
      }
    } catch (e) { errors.push(`${company}: ${e.message}`); }
  }
  if (errors.length && !out.length) throw new Error(errors.join('; '));
  return out;
}

async function adzuna(settings) {
  const { ADZUNA_APP_ID: id, ADZUNA_APP_KEY: key } = process.env;
  if (!id || !key) return null; // not configured -> skipped
  const country = (process.env.ADZUNA_COUNTRY || 'us').toLowerCase();
  const out = [];
  for (const kw of settings.keywords.length ? settings.keywords : ['']) {
    const params = new URLSearchParams({ app_id: id, app_key: key, results_per_page: '50', what: kw });
    if (settings.location) params.set('where', settings.location);
    const data = await fetchJson(`https://api.adzuna.com/v1/api/jobs/${country}/search/1?${params}`);
    for (const j of data.results || []) {
      const loc = j.location?.display_name || '';
      out.push({
        id: `adzuna:${j.id}`, source: 'Adzuna', title: htmlToText(j.title), company: j.company?.display_name || '',
        location: loc, remote: /remote/i.test(`${loc} ${j.title}`) ? 1 : 0, url: j.redirect_url,
        description: clip(htmlToText(j.description)),
        salary: j.salary_min ? `${Math.round(j.salary_min).toLocaleString()}–${Math.round(j.salary_max || j.salary_min).toLocaleString()}` : '',
        tags: j.category?.label || '', posted_at: toIso(j.created),
      });
    }
  }
  return out;
}

export const SOURCES = { weworkremotely, himalayas, remotive, remoteok, arbeitnow, greenhouse, lever, ashby, adzuna };

/** Relevance score: 0 means "doesn't match your search", -1 means excluded. */
export function scoreJob(job, settings) {
  const title = (job.title || '').toLowerCase();
  const text = `${title} ${(job.tags || '').toLowerCase()} ${(job.description || '').toLowerCase()}`;
  for (const ex of settings.excludeKeywords) {
    if (ex && title.includes(ex.toLowerCase())) return -1;
  }
  if (settings.remoteOnly && !job.remote) return -1;
  if (settings.anywhereOnly && !job.anywhere) return -1;

  let score = 0;
  const kws = settings.keywords.filter(Boolean);
  if (!kws.length) score = 1;
  for (const kw of kws) {
    const k = kw.toLowerCase();
    if (title.includes(k)) score += 10;
    else if (k.split(/\s+/).every((w) => title.includes(w))) score += 6;
    else if (text.includes(k)) score += 2;
  }
  if (score > 0 && settings.location) {
    const loc = settings.location.toLowerCase();
    if ((job.location || '').toLowerCase().includes(loc)) score += 3;
    else if (job.remote) score += 1;
  }
  return score;
}
