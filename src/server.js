import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const envFile = path.join(here, '..', '.env');
if (fs.existsSync(envFile)) process.loadEnvFile(envFile);

const { default: express } = await import('express');
const { db, getSettings, saveSettings, getMeta, nowIso } = await import('./db.js');
const { fetchAllJobs } = await import('./jobs.js');
const gmail = await import('./gmail.js');
const { claudeEnabled, CATEGORIES } = await import('./classify.js');
const { toIcs } = await import('./ics.js');
const { getLogo } = await import('./logos.js');
const profileMod = await import('./profile.js');
const applyMod = await import('./apply.js');
const skillsMod = await import('./skills.js');

const app = express();
const PORT = Number(process.env.PORT || 3000);
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(here, '..', 'public')));
app.use('/fonts', express.static(path.join(here, '..', 'node_modules', '@fontsource'), { maxAge: '30d' }));

// Block other websites from triggering actions on this local app: every change must carry this
// header, which browsers won't send cross-site without a CORS preflight (which we never allow).
app.use('/api', (req, res, next) => {
  if (req.method !== 'GET' && req.get('X-JobHunt') !== '1') return res.status(403).json({ error: 'Missing app header' });
  next();
});

const wrap = (fn) => (req, res) => Promise.resolve(fn(req, res)).catch((e) => {
  console.error(e);
  res.status(500).json({ error: e.message });
});

// ---------- status ----------
app.get('/api/status', (req, res) => {
  const count = (sql, ...p) => db.prepare(sql).get(...p).n;
  res.json({
    gmail: gmail.gmailStatus(),
    claude: claudeEnabled(),
    adzuna: Boolean(process.env.ADZUNA_APP_ID && process.env.ADZUNA_APP_KEY),
    lastJobFetch: getMeta('lastJobFetch'),
    counts: {
      newJobs: count(`SELECT COUNT(*) n FROM jobs WHERE status = 'new'`),
      savedJobs: count(`SELECT COUNT(*) n FROM jobs WHERE status = 'saved'`),
      applications: count('SELECT COUNT(*) n FROM applications'),
      active: count(`SELECT COUNT(*) n FROM applications WHERE status IN ('applied','replied','interview')`),
      interviews: count(`SELECT COUNT(*) n FROM applications WHERE status = 'interview'`),
      offers: count(`SELECT COUNT(*) n FROM applications WHERE status = 'offer'`),
      upcoming: count('SELECT COUNT(*) n FROM events WHERE start_at >= ?', nowIso()),
      needsDate: count('SELECT COUNT(*) n FROM emails WHERE needs_date = 1'),
    },
  });
});

// ---------- jobs ----------
// Skills your resume shows (recomputed only when the profile text changes).
let resumeCache = { key: null, skills: new Set() };
function resumeSkills() {
  const p = profileMod.getProfile();
  const text = `${p.resumeText}\n${p.currentTitle}\n${p.extraInfo}`;
  if (resumeCache.key !== text) resumeCache = { key: text, skills: new Set(skillsMod.extractSkills(text)) };
  return resumeCache.skills;
}

app.get('/api/jobs', (req, res) => {
  const { status = 'new', q = '', source = '', place = '', sort = '' } = req.query;
  const where = [];
  const params = [];
  if (status !== 'all') { where.push('status = ?'); params.push(status); }
  if (place === 'anywhere') where.push('anywhere = 1');
  if (place === 'remote') where.push('remote = 1');
  if (source) { where.push('source = ?'); params.push(source); }
  if (q) { where.push('(title LIKE ? OR company LIKE ? OR location LIKE ?)'); params.push(`%${q}%`, `%${q}%`, `%${q}%`); }
  const byMatch = sort === 'match';
  let rows = db.prepare(`SELECT * FROM jobs ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY score DESC, COALESCE(posted_at, fetched_at) DESC LIMIT ${byMatch ? 2000 : 300}`).all(...params);
  const mine = resumeSkills();
  rows = rows.map((j) => ({ ...j, match: mine.size ? skillsMod.matchJob(j, mine) : null }));
  if (byMatch) {
    // Best fit first: match %, then search relevance. Jobs too vague to score go last.
    rows.sort((a, b) => (b.match?.pct ?? -1) - (a.match?.pct ?? -1) || b.score - a.score);
    rows = rows.slice(0, 300);
  }
  const sources = db.prepare(`SELECT source, COUNT(*) n FROM jobs WHERE status = 'new' GROUP BY source ORDER BY source`).all();
  res.json({ jobs: rows, sources, hasResume: mine.size > 0 });
});

// Which skills your leads ask for most, and which your resume already shows (like a career report).
app.get('/api/skills', (req, res) => {
  const mine = resumeSkills();
  const jobs = db.prepare(`SELECT title, tags, description FROM jobs WHERE status IN ('new','saved') AND source != 'Email alert' AND description != ''`).all();
  const demand = skillsMod.skillDemand(jobs, mine);
  const top = demand.rows.slice(0, 40);
  res.json({
    hasResume: mine.size > 0,
    resumeSkills: [...mine],
    jobsAnalyzed: demand.jobsAnalyzed,
    alignment: top.length ? Math.round((top.filter((r) => r.have).length / top.length) * 100) : 0,
    haveCount: top.filter((r) => r.have).length,
    total: top.length,
    rows: top,
  });
});

app.post('/api/jobs/refresh', wrap(async (req, res) => res.json(await fetchAllJobs())));

app.post('/api/jobs/:id/status', (req, res) => {
  const { status } = req.body;
  if (!['new', 'saved', 'dismissed'].includes(status)) return res.status(400).json({ error: 'Bad status' });
  db.prepare('UPDATE jobs SET status = ? WHERE id = ?').run(status, req.params.id);
  res.json({ ok: true });
});

app.post('/api/jobs/:id/apply', (req, res) => {
  const job = db.prepare('SELECT * FROM jobs WHERE id = ?').get(req.params.id);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  const existing = db.prepare('SELECT id FROM applications WHERE job_id = ?').get(job.id);
  if (!existing) {
    db.prepare(`INSERT INTO applications (job_id, company, title, url, status, applied_at, last_activity, source)
      VALUES (?, ?, ?, ?, 'applied', ?, ?, 'job-board')`).run(job.id, job.company || 'Unknown', job.title, job.url, nowIso(), nowIso());
  }
  db.prepare(`UPDATE jobs SET status = 'applied' WHERE id = ?`).run(job.id);
  res.json({ ok: true });
});

// ---------- applications ----------
const APP_STATUSES = ['applied', 'replied', 'interview', 'offer', 'rejected', 'ghosted'];

app.get('/api/applications', (req, res) => {
  res.json(db.prepare(`SELECT a.*,
      (SELECT COUNT(*) FROM emails e WHERE e.application_id = a.id) AS email_count,
      (SELECT MIN(start_at) FROM events v WHERE v.application_id = a.id AND v.start_at >= ?) AS next_event
    FROM applications a ORDER BY COALESCE(a.last_activity, a.applied_at) DESC`).all(nowIso()));
});

app.post('/api/applications', (req, res) => {
  const { company, title = '', url = '', status = 'applied', notes = '', applied_at } = req.body;
  if (!company?.trim()) return res.status(400).json({ error: 'Company is required' });
  if (!APP_STATUSES.includes(status)) return res.status(400).json({ error: 'Bad status' });
  const when = applied_at ? new Date(applied_at).toISOString() : nowIso();
  const r = db.prepare(`INSERT INTO applications (company, title, url, status, notes, applied_at, last_activity, source)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'manual')`).run(company.trim(), title, url, status, notes, when, when);
  res.json({ id: Number(r.lastInsertRowid) });
});

app.patch('/api/applications/:id', (req, res) => {
  const allowed = ['company', 'title', 'url', 'status', 'notes'];
  const fields = Object.keys(req.body).filter((k) => allowed.includes(k));
  if (req.body.status && !APP_STATUSES.includes(req.body.status)) return res.status(400).json({ error: 'Bad status' });
  if (!fields.length) return res.status(400).json({ error: 'Nothing to update' });
  db.prepare(`UPDATE applications SET ${fields.map((f) => `${f} = ?`).join(', ')}, last_activity = ? WHERE id = ?`)
    .run(...fields.map((f) => req.body[f]), nowIso(), req.params.id);
  res.json({ ok: true });
});

app.delete('/api/applications/:id', (req, res) => {
  const a = db.prepare('SELECT job_id FROM applications WHERE id = ?').get(req.params.id);
  db.prepare('DELETE FROM applications WHERE id = ?').run(req.params.id);
  if (a?.job_id) db.prepare(`UPDATE jobs SET status = 'saved' WHERE id = ?`).run(a.job_id);
  res.json({ ok: true });
});

// ---------- emails ----------
app.get('/api/emails', (req, res) => {
  const { category = '' } = req.query;
  const rows = db.prepare(`SELECT e.*, a.company AS app_company, a.title AS app_title
    FROM emails e LEFT JOIN applications a ON a.id = e.application_id
    ${category ? 'WHERE e.category = ?' : `WHERE e.category != 'other'`}
    ORDER BY e.received_at DESC LIMIT 300`).all(...(category ? [category] : []));
  res.json(rows);
});

app.patch('/api/emails/:id', (req, res) => {
  const { category, application_id, needs_date } = req.body;
  if (category !== undefined) {
    if (!CATEGORIES.includes(category)) return res.status(400).json({ error: 'Bad category' });
    db.prepare('UPDATE emails SET category = ? WHERE id = ?').run(category, req.params.id);
  }
  if (application_id !== undefined) db.prepare('UPDATE emails SET application_id = ? WHERE id = ?').run(application_id || null, req.params.id);
  if (needs_date !== undefined) db.prepare('UPDATE emails SET needs_date = ? WHERE id = ?').run(needs_date ? 1 : 0, req.params.id);
  res.json({ ok: true });
});

// ---------- gmail ----------
app.get('/auth/google', (req, res) => {
  if (!gmail.gmailConfigured()) return res.status(400).send('Add GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET to your .env file first (see SETUP.md), then restart the app.');
  res.redirect(gmail.authUrl());
});

app.get('/auth/google/callback', wrap(async (req, res) => {
  if (req.query.error) return res.redirect('/#settings?gmail=denied');
  await gmail.handleCallback(String(req.query.code), String(req.query.state));
  res.redirect('/#inbox?gmail=connected');
  gmail.syncGmail().catch((e) => console.error('[gmail] first sync failed:', e.message));
}));

app.post('/api/gmail/sync', wrap(async (req, res) => res.json(await gmail.syncGmail())));
app.post('/api/gmail/disconnect', (req, res) => { gmail.disconnect(); res.json({ ok: true }); });

// ---------- calendar ----------
app.get('/api/events', (req, res) => {
  const { from = '0000', to = '9999' } = req.query;
  res.json(db.prepare(`SELECT v.*, a.company, a.title AS app_title FROM events v
    LEFT JOIN applications a ON a.id = v.application_id
    WHERE v.start_at >= ? AND v.start_at < ? ORDER BY v.start_at`).all(String(from), String(to)));
});

app.post('/api/events', (req, res) => {
  const { title, start_at, end_at, location = '', notes = '', application_id = null, email_id = null } = req.body;
  const start = new Date(start_at);
  if (!title?.trim() || Number.isNaN(start.getTime())) return res.status(400).json({ error: 'Title and a valid start time are required' });
  const end = end_at && !Number.isNaN(new Date(end_at).getTime()) ? new Date(end_at) : new Date(start.getTime() + 3600_000);
  const r = db.prepare(`INSERT INTO events (application_id, email_id, title, start_at, end_at, location, notes, source)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'manual')`).run(application_id || null, email_id, title.trim(), start.toISOString(), end.toISOString(), location, notes);
  if (email_id) db.prepare('UPDATE emails SET needs_date = 0 WHERE id = ?').run(email_id);
  if (application_id) {
    db.prepare(`UPDATE applications SET status = 'interview', last_activity = ? WHERE id = ? AND status IN ('applied','replied')`).run(nowIso(), application_id);
  }
  res.json({ id: Number(r.lastInsertRowid) });
});

app.delete('/api/events/:id', (req, res) => {
  db.prepare('DELETE FROM events WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

app.get('/api/calendar.ics', (req, res) => {
  const rows = req.query.id
    ? db.prepare('SELECT * FROM events WHERE id = ?').all(String(req.query.id))
    : db.prepare('SELECT * FROM events ORDER BY start_at').all();
  res.set('Content-Type', 'text/calendar; charset=utf-8');
  res.set('Content-Disposition', `attachment; filename="${req.query.id ? 'interview' : 'interviews'}.ics"`);
  res.send(toIcs(rows));
});

// ---------- profile & auto-fill ----------
app.get('/api/profile', (req, res) => res.json(profileMod.getProfile()));
app.put('/api/profile', (req, res) => res.json(profileMod.saveProfile(req.body || {})));
app.post('/api/profile/resume', express.raw({ type: 'application/pdf', limit: '10mb' }), wrap(async (req, res) => {
  if (!Buffer.isBuffer(req.body) || !req.body.length) return res.status(400).json({ error: 'No file received.' });
  try { res.json(await profileMod.saveResume(req.body)); } catch (e) { res.status(400).json({ error: e.message }); }
}));
app.get('/api/profile/resume', (req, res) => {
  if (!fs.existsSync(profileMod.RESUME_FILE)) return res.status(404).end();
  res.type('application/pdf').sendFile(profileMod.RESUME_FILE);
});

app.post('/api/apply/:id', async (req, res) => {
  try { res.json(await applyMod.autoFill(req.params.id)); } catch (e) { res.status(400).json({ error: e.message, url: e.url || null }); }
});
app.post('/api/apply/:id/done', wrap(async (req, res) => {
  const session = await applyMod.closeSession(req.params.id);
  if (req.body?.submitted) {
    const job = db.prepare('SELECT * FROM jobs WHERE id = ?').get(req.params.id);
    if (job && !db.prepare('SELECT 1 FROM applications WHERE job_id = ?').get(job.id)) {
      const note = session?.coverLetter ? `Applied with Job Hunt HQ auto-fill.\n\nCover letter:\n${session.coverLetter}` : 'Applied with Job Hunt HQ auto-fill.';
      db.prepare(`INSERT INTO applications (job_id, company, title, url, status, applied_at, last_activity, notes, source)
        VALUES (?, ?, ?, ?, 'applied', ?, ?, ?, 'auto-fill')`).run(job.id, job.company || 'Unknown', job.title, job.url, nowIso(), nowIso(), note);
    }
    if (job) db.prepare(`UPDATE jobs SET status = 'applied' WHERE id = ?`).run(job.id);
  }
  res.json({ ok: true });
}));

// ---------- logos ----------
app.get('/api/logo', wrap(async (req, res) => {
  const logo = await getLogo({ company: req.query.company, domain: req.query.domain });
  res.set('Cache-Control', 'private, max-age=86400');
  if (!logo) return res.status(404).end();
  res.type(logo.type).send(logo.buf);
}));

// ---------- settings ----------
app.get('/api/settings', (req, res) => res.json(getSettings()));
app.put('/api/settings', (req, res) => {
  const b = req.body;
  const list = (v) => (Array.isArray(v) ? v : String(v || '').split(/[,\n]/)).map((s) => s.trim()).filter(Boolean);
  const clean = {};
  if ('keywords' in b) clean.keywords = list(b.keywords);
  if ('excludeKeywords' in b) clean.excludeKeywords = list(b.excludeKeywords);
  if ('greenhouseCompanies' in b) clean.greenhouseCompanies = list(b.greenhouseCompanies).map((s) => s.toLowerCase());
  if ('leverCompanies' in b) clean.leverCompanies = list(b.leverCompanies).map((s) => s.toLowerCase());
  if ('ashbyCompanies' in b) clean.ashbyCompanies = list(b.ashbyCompanies).map((s) => s.toLowerCase());
  if ('anywhereOnly' in b) clean.anywhereOnly = Boolean(b.anywhereOnly);
  if ('location' in b) clean.location = String(b.location || '').trim();
  if ('remoteOnly' in b) clean.remoteOnly = Boolean(b.remoteOnly);
  if ('sources' in b && typeof b.sources === 'object') clean.sources = b.sources;
  for (const k of ['fetchIntervalHours', 'gmailIntervalMinutes', 'gmailLookbackDays']) {
    if (k in b) clean[k] = Math.max(1, Number(b[k]) || 1);
  }
  const saved = saveSettings(clean);
  scheduleTimers();
  res.json(saved);
});

// ---------- background schedule ----------
let jobTimer, gmailTimer;
function scheduleTimers() {
  const s = getSettings();
  clearInterval(jobTimer);
  clearInterval(gmailTimer);
  jobTimer = setInterval(() => fetchAllJobs().catch((e) => console.error('[jobs]', e.message)), s.fetchIntervalHours * 3600_000);
  gmailTimer = setInterval(() => {
    if (gmail.gmailStatus().connected) gmail.syncGmail().catch((e) => console.error('[gmail]', e.message));
  }, s.gmailIntervalMinutes * 60_000);
}

for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => applyMod.shutdown().finally(() => process.exit(0)));

app.listen(PORT, '127.0.0.1', () => {
  console.log(`\n  Job Hunt HQ is running at http://localhost:${PORT}\n`);
  console.log(`  Claude AI:  ${claudeEnabled() ? 'on' : 'off (add ANTHROPIC_API_KEY to .env for smarter email sorting)'}`);
  console.log(`  Gmail:      ${gmail.gmailStatus().connected ? 'connected' : gmail.gmailConfigured() ? 'ready to connect in Settings' : 'not set up (see SETUP.md)'}\n`);
  scheduleTimers();
  const last = getMeta('lastJobFetch');
  const stale = !last || Date.now() - new Date(last.finishedAt).getTime() > getSettings().fetchIntervalHours * 3600_000;
  if (stale) fetchAllJobs().catch((e) => console.error('[jobs]', e.message));
  if (gmail.gmailStatus().connected) gmail.syncGmail().catch((e) => console.error('[gmail]', e.message));
});
