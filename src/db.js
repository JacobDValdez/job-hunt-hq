import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const DATA_DIR = process.env.JOBHUNT_DATA_DIR || path.join(here, '..', 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

export const db = new DatabaseSync(path.join(DATA_DIR, 'jobhunt.db'));
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');

db.exec(`
CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,            -- "<source>:<external id>"
  source TEXT NOT NULL,
  title TEXT NOT NULL,
  company TEXT,
  location TEXT,
  remote INTEGER DEFAULT 0,
  url TEXT,
  description TEXT,
  salary TEXT,
  tags TEXT,
  posted_at TEXT,
  fetched_at TEXT NOT NULL,
  score INTEGER DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'new'   -- new | saved | applied | dismissed
);
CREATE INDEX IF NOT EXISTS jobs_status ON jobs(status);

CREATE TABLE IF NOT EXISTS applications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id TEXT,
  company TEXT NOT NULL,
  title TEXT,
  url TEXT,
  status TEXT NOT NULL DEFAULT 'applied', -- applied | replied | interview | offer | rejected | ghosted
  applied_at TEXT NOT NULL,
  last_activity TEXT,
  notes TEXT DEFAULT '',
  source TEXT DEFAULT 'manual'            -- manual | job-board | gmail
);

CREATE TABLE IF NOT EXISTS emails (
  id TEXT PRIMARY KEY,           -- Gmail message id
  thread_id TEXT,
  from_name TEXT,
  from_addr TEXT,
  subject TEXT,
  snippet TEXT,
  received_at TEXT,
  category TEXT,                 -- interview | rejection | offer | recruiter | application_confirmation | job_alert | other
  company TEXT,
  summary TEXT,
  application_id INTEGER REFERENCES applications(id) ON DELETE SET NULL,
  classified_by TEXT,            -- claude | keywords
  needs_date INTEGER DEFAULT 0   -- interview email with no detected time
);
CREATE INDEX IF NOT EXISTS emails_received ON emails(received_at);

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  application_id INTEGER REFERENCES applications(id) ON DELETE SET NULL,
  email_id TEXT,
  title TEXT NOT NULL,
  start_at TEXT NOT NULL,        -- ISO 8601
  end_at TEXT,
  location TEXT,
  notes TEXT,
  source TEXT DEFAULT 'manual'
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`);

// Columns added after the first release.
const jobCols = db.prepare('PRAGMA table_info(jobs)').all().map((c) => c.name);
if (!jobCols.includes('logo')) db.exec('ALTER TABLE jobs ADD COLUMN logo TEXT');
if (!jobCols.includes('anywhere')) db.exec('ALTER TABLE jobs ADD COLUMN anywhere INTEGER DEFAULT 0');

export const DEFAULT_SETTINGS = {
  keywords: ['software engineer'],
  excludeKeywords: ['senior staff', 'principal'],
  location: '',
  remoteOnly: false,
  anywhereOnly: false,
  sources: { weworkremotely: true, himalayas: true, remotive: true, remoteok: true, arbeitnow: true, greenhouse: true, lever: true, ashby: true, adzuna: true },
  greenhouseCompanies: ['gitlab', 'airbnb', 'discord', 'stripe'],
  leverCompanies: ['plaid', 'spotify'],
  ashbyCompanies: ['zapier', 'buffer'],
  fetchIntervalHours: 6,
  gmailIntervalMinutes: 15,
  gmailLookbackDays: 30,
};

export function getSettings() {
  const rows = db.prepare('SELECT key, value FROM settings').all();
  const s = structuredClone(DEFAULT_SETTINGS);
  for (const r of rows) {
    if (!(r.key in DEFAULT_SETTINGS)) continue;
    try { s[r.key] = JSON.parse(r.value); } catch { /* ignore bad row */ }
  }
  s.sources = { ...DEFAULT_SETTINGS.sources, ...(s.sources || {}) };
  return s;
}

// One-time upgrade for existing users: add the work-from-anywhere employers to saved company lists.
{
  const done = db.prepare(`SELECT 1 FROM settings WHERE key = 'meta:boardsV2'`).get();
  if (!done) {
    const gh = db.prepare(`SELECT value FROM settings WHERE key = 'greenhouseCompanies'`).get();
    if (gh) {
      const list = JSON.parse(gh.value);
      if (!list.includes('gitlab')) db.prepare(`UPDATE settings SET value = ? WHERE key = 'greenhouseCompanies'`).run(JSON.stringify(['gitlab', ...list]));
    }
    db.prepare(`INSERT OR REPLACE INTO settings(key, value) VALUES ('meta:boardsV2', 'true')`).run();
  }
}

export function saveSettings(partial) {
  const stmt = db.prepare('INSERT INTO settings(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
  for (const [k, v] of Object.entries(partial)) {
    if (!(k in DEFAULT_SETTINGS)) continue;
    stmt.run(k, JSON.stringify(v));
  }
  return getSettings();
}

export function getMeta(key) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get('meta:' + key);
  return row ? JSON.parse(row.value) : null;
}
export function setMeta(key, value) {
  db.prepare('INSERT INTO settings(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run('meta:' + key, JSON.stringify(value));
}

export const nowIso = () => new Date().toISOString();
