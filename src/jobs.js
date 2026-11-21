import { db, getSettings, getMeta, setMeta, nowIso } from './db.js';
import { SOURCES, scoreJob } from './sources.js';

let running = null;

export function fetchAllJobs() {
  if (!running) running = doFetch().finally(() => { running = null; });
  return running;
}

async function doFetch() {
  const settings = getSettings();
  settings.homeCountry = getMeta('profile')?.country || 'United States';
  const report = { startedAt: nowIso(), sources: {}, added: 0 };

  const insert = db.prepare(`
    INSERT INTO jobs (id, source, title, company, location, remote, url, description, salary, tags, posted_at, fetched_at, score, logo, anywhere)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET title = excluded.title, description = excluded.description,
      salary = excluded.salary, location = excluded.location, score = excluded.score, logo = excluded.logo, anywhere = excluded.anywhere`);
  const exists = db.prepare('SELECT 1 FROM jobs WHERE id = ?');

  await Promise.all(Object.entries(SOURCES).map(async ([name, fn]) => {
    if (!settings.sources[name]) { report.sources[name] = { status: 'off' }; return; }
    try {
      const jobs = await fn(settings);
      if (jobs === null) { report.sources[name] = { status: 'not configured' }; return; }
      let kept = 0, added = 0;
      for (const j of jobs) {
        if (!j.title || !j.url) continue;
        const score = scoreJob(j, settings);
        if (score <= 0) continue;
        kept++;
        if (!exists.get(j.id)) added++;
        insert.run(j.id, j.source, j.title, j.company || '', j.location || '', j.remote ? 1 : 0, j.url,
          j.description || '', j.salary || '', j.tags || '', j.posted_at, nowIso(), score,
          /^https:\/\//.test(j.logo || '') ? j.logo : null, j.anywhere ? 1 : 0);
      }
      report.added += added;
      report.sources[name] = { status: 'ok', fetched: jobs.length, matched: kept, added };
    } catch (e) {
      report.sources[name] = { status: 'error', error: e.message };
    }
  }));

  // Re-score unseen leads against the current search, and drop ones that no longer match
  // (e.g. after changing keywords). Saved, applied and dismissed jobs are never touched.
  if (Object.values(report.sources).some((s) => s.status === 'ok')) {
    const update = db.prepare('UPDATE jobs SET score = ? WHERE id = ?');
    const drop = db.prepare('DELETE FROM jobs WHERE id = ?');
    let removed = 0;
    for (const j of db.prepare(`SELECT * FROM jobs WHERE status = 'new' AND source != 'Email alert'`).all()) {
      const s = scoreJob(j, settings);
      if (s > 0) update.run(s, j.id); else { drop.run(j.id); removed++; }
    }
    report.removedStale = removed;
  }

  report.finishedAt = nowIso();
  setMeta('lastJobFetch', report);
  console.log(`[jobs] fetched: ${report.added} new matching jobs`);
  return report;
}

/** Store jobs that Claude pulled out of job-alert emails (LinkedIn, Indeed, ...). */
export function addAlertJobs(jobs, emailId, receivedAt) {
  const settings = getSettings();
  const insert = db.prepare(`
    INSERT OR IGNORE INTO jobs (id, source, title, company, location, remote, url, description, salary, tags, posted_at, fetched_at, score)
    VALUES (?, 'Email alert', ?, ?, ?, ?, ?, '', '', '', ?, ?, ?)`);
  let added = 0;
  jobs.forEach((j, i) => {
    if (!j.title || !j.url) return;
    const job = { ...j, remote: /remote/i.test(j.location || '') };
    const score = Math.max(scoreJob(job, settings), 1); // the alert already targeted you
    const r = insert.run(`alert:${emailId}:${i}`, j.title, j.company || '', j.location || '', job.remote ? 1 : 0,
      j.url, receivedAt, nowIso(), score);
    added += Number(r.changes);
  });
  return added;
}
