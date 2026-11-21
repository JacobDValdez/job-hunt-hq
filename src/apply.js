// Auto-fill: opens a job's application form in a real browser window, fills it in from your profile,
// resume and a tailored cover letter, then STOPS so you can review and click Submit yourself.
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright-core';
import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { db, DATA_DIR } from './db.js';
import { getProfile, RESUME_FILE } from './profile.js';
import { usage } from './classify.js';

// Sites whose rules forbid automated applications. The app never fills forms there.
// RemoteOK is listed too: every application there requires a RemoteOK account first.
const BLOCKED_HOSTS = /(^|\.)(linkedin\.com|indeed\.com|glassdoor\.com|ziprecruiter\.com|monster\.com|remoteok\.com)$/i;
const LETTER_DIR = path.join(DATA_DIR, 'cover-letters');
fs.mkdirSync(LETTER_DIR, { recursive: true });

export const canAutoFill = (url) => {
  try { return /^https?:$/.test(new URL(url).protocol) && !BLOCKED_HOSTS.test(new URL(url).hostname); } catch { return false; }
};

const sessions = new Map(); // jobId -> { context, coverLetter }
let browser = null;

async function getBrowser() {
  if (browser?.isConnected()) return browser;
  const opts = { headless: process.env.JOBHUNT_HEADLESS === '1', args: ['--start-maximized'] };
  try { browser = await chromium.launch({ ...opts, channel: 'msedge' }); }
  catch { browser = await chromium.launch({ ...opts, channel: 'chrome' }); }
  return browser;
}

export async function closeSession(jobId) {
  const s = sessions.get(jobId);
  sessions.delete(jobId);
  await s?.context.close().catch(() => {});
  return s;
}

class FriendlyError extends Error {
  constructor(message, { keepOpen = false } = {}) { super(message); this.keepOpen = keepOpen; }
}

// ---------- finding the form ----------
// Job listing sites only link to the employer's application; their own forms are searches and newsletter signups.
const LISTING_HOSTS = /(^|\.)(remoteok\.com|remotive\.com|arbeitnow\.com|adzuna\.[a-z.]+|weworkremotely\.com|himalayas\.app|wellfound\.com|builtin\.com|dice\.com|simplyhired\.com|jobicy\.com|workingnomads\.com)$/i;

/** How much a frame's form looks like a job application (name/email/phone/resume fields), and how many fields it has. */
const scoreFrame = (frame) => frame.evaluate(() => {
  const vis = (el) => { const r = el.getBoundingClientRect(); return (r.width > 0 && r.height > 0) || el.type === 'file'; };
  const fields = [...document.querySelectorAll('input:not([type=hidden]):not([type=submit]):not([type=button]):not([type=search]), textarea, select')].filter(vis);
  const describe = (el) => [el.name, el.id, el.placeholder, el.getAttribute('autocomplete'), el.getAttribute('aria-label'),
    el.id && document.querySelector(`label[for="${CSS.escape(el.id)}"]`)?.innerText].join(' ').toLowerCase();
  const signals = [/first.?name|given.?name|full.?name|^name$|\bname\b/, /e-?mail/, /phone|mobile/, /resume|cv\b|curriculum/, /cover.?letter/, /linkedin/];
  const hits = new Set();
  for (const el of fields) {
    const d = describe(el);
    signals.forEach((re, i) => { if (re.test(d)) hits.add(i); });
    if (el.type === 'file') hits.add(3);
  }
  return { count: fields.length, signals: hits.size };
}).catch(() => ({ count: 0, signals: 0 }));

async function bestFrame(page) {
  if (LISTING_HOSTS.test(new URL(page.url()).hostname)) return null; // never fill a listing site's own forms
  let best = null, bestScore = -1;
  for (const f of page.frames()) {
    const { count, signals } = await scoreFrame(f);
    // A real application asks for at least two of: name, email, phone, resume, cover letter, LinkedIn.
    if (count >= 3 && signals >= 2 && signals * 100 + count > bestScore) { best = f; bestScore = signals * 100 + count; }
  }
  return best;
}

/** Finds the page's real "Apply" control, preferring links that leave a listing site for the employer's form. */
async function findApplyTarget(page) {
  return page.evaluate((onListing) => {
    const here = new URL(location.href);
    const els = [...document.querySelectorAll('a, button, [role="button"], input[type="button"], input[type="submit"]')];
    const cands = [];
    els.forEach((el, i) => {
      const r = el.getBoundingClientRect();
      if (!(r.width > 0 && r.height > 0)) return;
      const text = (el.innerText || el.value || el.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim();
      const rawHref = el.tagName === 'A' ? el.getAttribute('href') || '' : '';
      const applyText = /\bapply\b|start (your )?application|i'?m interested|company (portal|website|site)/i.test(text) && text.length <= 60;
      const applyLink = /\/apply(\/|\?|$)/i.test(rawHref); // e.g. "company portal" links to …/apply
      if (!applyText && !applyLink) return;
      if (/applications?\b(?! form)|how to apply|apply filter|post a job/i.test(text) && !/^apply/i.test(text)) return;
      const href = el.tagName === 'A' ? el.getAttribute('href') : null;
      let score = /^\s*apply\b/i.test(text) ? 2 : 1;
      if (href) {
        if (/^(#|javascript:|mailto:)/i.test(href)) return;
        const u = new URL(href, location.href);
        if (u.href === here.href || (u.host === here.host && (u.pathname === '/' || u.pathname === ''))) return; // home page / same page
        if (u.host !== here.host) score += 3;                     // goes to the employer's own site
        if (/\/(apply|application|l|redirect|out|go)\b/i.test(u.pathname)) score += 2;
      } else if (onListing) score -= 1;
      el.setAttribute('data-jhapply', String(i));
      cands.push({ i, score, href: href ? new URL(href, location.href).href : null });
    });
    cands.sort((a, b) => b.score - a.score);
    return cands[0] || null;
  }, LISTING_HOSTS.test(new URL(page.url()).hostname)).catch(() => null);
}

// Sign-in pages (Google, Microsoft, …) refuse automated browsers, so send those to the user's normal browser.
const SIGN_IN_HOSTS = /(^|\.)(accounts\.google\.com|login\.microsoftonline\.com|login\.live\.com|appleid\.apple\.com|auth0\.com|okta\.com)$/i;

async function checkHost(page) {
  const host = new URL(page.url()).hostname;
  if (BLOCKED_HOSTS.test(host)) {
    throw new FriendlyError(`This job sends you to ${host}, which doesn't allow automated applications. Open it in your normal browser and apply there.`, { keepOpen: true });
  }
  const { pathname } = new URL(page.url());
  if (SIGN_IN_HOSTS.test(host) || /\/(sign-?up|sign-?in|log-?in|register|authentication|auth|account\/(new|create))(\/|$|\?)/i.test(pathname)
      || (/myworkdayjobs\.com|icims\.com|taleo\.net|successfactors/i.test(host) && /login|signin|sign-in|account/i.test(page.url()))) {
    throw new FriendlyError('This application needs you to sign in or create an account first. Sign-in pages block automated windows, so open it in your normal browser and apply there.', { keepOpen: true });
  }
}

async function locateForm(page) {
  const tried = new Set();
  for (let hop = 0; hop < 4; hop++) {
    await page.waitForLoadState('domcontentloaded').catch(() => {});
    await page.waitForTimeout(2000);
    await checkHost(page);
    const frame = await bestFrame(page);
    if (frame) return frame;

    // No application form yet: follow the page's real "Apply" link or button (it may open a new tab).
    const target = await findApplyTarget(page);
    if (process.env.JOBHUNT_DEBUG) console.log(`[auto-fill] hop ${hop}: ${page.url().slice(0, 90)} → apply target: ${target ? JSON.stringify(target) : 'none'}`);
    if (!target) break;
    const key = target.href || `${page.url()}#${target.i}`;
    if (tried.has(key)) break;
    tried.add(key);

    // Click it like a person would (some sites only redirect real clicks), catching a new tab if one opens.
    const before = page.url();
    const popup = page.context().waitForEvent('page', { timeout: 8000 }).catch(() => null);
    await page.locator(`[data-jhapply="${target.i}"]`).first().click({ timeout: 5000 }).catch(() => {});
    const newPage = await Promise.race([popup, page.waitForTimeout(4000).then(() => null)]);
    if (newPage) {
      await newPage.waitForLoadState('domcontentloaded').catch(() => {});
      await page.close().catch(() => {});
      page = newPage;
    } else if (page.url() === before && target.href) {
      await page.goto(target.href, { waitUntil: 'domcontentloaded', timeout: 45000 }); // the click did nothing: open the link directly
    }
  }
  return { page, frame: null };
}

// ---------- reading the form ----------
function collectFieldsInPage() {
  const vis = (el) => {
    if (el.type === 'file') return true;
    const r = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    // Skip invisible helper inputs (e.g. the hidden "required" input behind each Greenhouse dropdown).
    if (s.opacity === '0' || s.pointerEvents === 'none' || el.getAttribute('aria-hidden') === 'true' || (el.tabIndex === -1 && el.getAttribute('role') !== 'combobox')) return false;
    return r.width > 0 && r.height > 0 && s.visibility !== 'hidden';
  };
  const questionOf = (el) => {
    const box = el.closest('fieldset, .application-question, [class*="question"], .field');
    const q = box?.querySelector('legend, .application-label, label:not(:has(input))');
    return q ? text(q.innerText) : '';
  };
  const text = (s) => (s || '').replace(/\s+/g, ' ').trim().slice(0, 250);
  // A label's own words, without the dropdown options or inputs nested inside it.
  const ownText = (node) => {
    const c = node.cloneNode(true);
    c.querySelectorAll('select, option, input, textarea, [role="listbox"], [role="option"]').forEach((x) => x.remove());
    return text(c.textContent);
  };
  const labelOf = (el) => {
    if (el.id) { const l = document.querySelector(`label[for="${CSS.escape(el.id)}"]`); if (l && text(l.innerText)) return text(l.innerText); }
    const al = el.getAttribute('aria-label'); if (al) return text(al);
    const lb = el.getAttribute('aria-labelledby');
    if (lb) { const t = lb.split(/\s+/).map((id) => document.getElementById(id)?.innerText || '').join(' '); if (text(t)) return text(t); }
    const pl = el.closest('label'); if (pl && ownText(pl)) return ownText(pl);
    const box = el.closest('fieldset, .field, .application-question, [class*="field"], [class*="question"], li');
    const l2 = box?.querySelector('label, legend, .application-label, [class*="label"]');
    if (l2 && ownText(l2)) return ownText(l2);
    return text(el.placeholder || el.name || el.id || '');
  };

  const out = [];
  let n = 0;
  const radioGroups = new Set();
  for (const el of document.querySelectorAll('input, textarea, select')) {
    const type = (el.type || '').toLowerCase();
    if (['hidden', 'submit', 'button', 'image', 'reset', 'search'].includes(type) || el.disabled || !vis(el)) continue;
    if (type === 'password') { out.push({ kind: 'password' }); continue; }
    if (type === 'radio') {
      const key = el.name || el.id;
      if (radioGroups.has(key)) continue;
      radioGroups.add(key);
      const opts = el.name ? [...document.querySelectorAll(`input[type=radio][name="${CSS.escape(el.name)}"]`)] : [el];
      const id = `jh${n++}`;
      opts.forEach((o, i) => o.setAttribute('data-jh', `${id}_${i}`));
      const box = el.closest('fieldset') || el.closest('[class*="question"], .field, li, div');
      const q = box?.querySelector('legend, label:not(:has(input)), [class*="label"]')?.innerText || key;
      out.push({ id, kind: 'radio', label: text(q), options: opts.map((o) => labelOf(o)), required: opts.some((o) => o.required) });
      continue;
    }
    const id = `jh${n++}`;
    el.setAttribute('data-jh', id);
    const kind = el.tagName === 'SELECT' ? 'select' : el.tagName === 'TEXTAREA' ? 'textarea' : type === 'file' ? 'file'
      : type === 'checkbox' ? 'checkbox'
      : el.getAttribute('role') === 'combobox' || el.getAttribute('aria-autocomplete') === 'list' ? 'combobox' : 'text';
    let label = labelOf(el);
    if (kind === 'checkbox') { const q = questionOf(el); if (q && !label.includes(q)) label = `${q} → ${label}`; }
    const f = { id, kind, label, required: el.required || el.getAttribute('aria-required') === 'true' };
    if (kind === 'select') f.options = [...el.options].map((o) => text(o.text)).filter((t) => t && !/^select\b/i.test(t));
    if (kind === 'text' && type && type !== 'text') f.inputType = type;
    if (kind === 'file') f.accept = el.accept || '';
    if (el.value && !['file', 'checkbox'].includes(kind)) f.current = text(el.value);
    out.push(f);
  }
  return out;
}

// Searchable dropdowns only show their choices when opened. Open each one briefly (no typing, no selection)
// so Claude can pick from the real list instead of guessing the wording.
const OPTION_SEL = '[role="option"], [id*="-option-"], .select__option';
async function visibleOptions(frame) {
  return frame.locator(OPTION_SEL).evaluateAll((els) => els
    .filter((e) => e.getBoundingClientRect().height > 0)
    .map((e) => (e.innerText || '').replace(/\s+/g, ' ').trim())
    .filter((t) => t && !/^(no options|no results|loading|searching|type to search)/i.test(t)));
}
async function readDropdownOptions(frame, fields) {
  for (const f of fields.filter((x) => x.kind === 'combobox').slice(0, 40)) {
    const loc = frame.locator(`[data-jh="${f.id}"]`);
    try {
      await loc.scrollIntoViewIfNeeded();
      await loc.click({ force: true });
      await frame.waitForTimeout(300);
      let opts = await visibleOptions(frame);
      if (!opts.length) { await loc.focus(); await frame.page().keyboard.press('ArrowDown'); await frame.waitForTimeout(300); opts = await visibleOptions(frame); }
      if (opts.length) f.options = opts.slice(0, 250); // empty = a search box (cities, schools): Claude answers in free text
    } catch { /* leave as free text */ }
    await frame.page().keyboard.press('Escape').catch(() => {});
  }
}

// ---------- asking Claude what to put where ----------
const FillPlan = z.object({
  fills: z.array(z.object({ id: z.string(), value: z.string() })),
  cover_letter: z.string(),
  unsure: z.array(z.string()).describe('ids of fields you could not answer from the profile/resume'),
  notes: z.string().describe('One or two short sentences for the applicant about anything they should check'),
});

const SYSTEM = `You fill out job application forms on behalf of the applicant, using ONLY facts from their profile and resume.
Rules:
- Never invent employers, dates, degrees, numbers or skills. If the answer is not in the profile or resume, use "" and add the field id to "unsure".
- select, radio and combobox fields that list "options": the value must be exactly one of the listed options. A combobox without options is a search box: give the plain answer (e.g. "Austin, Texas").
- checkbox fields: "true" to tick, "" to leave alone. NEVER tick boxes that agree to terms, privacy policies, certifications, attestations, background checks or marketing; leave those for the applicant.
- Voluntary demographic questions (gender, race, ethnicity, veteran status, disability, sexual orientation): pick the option matching the applicant's EEO preference; by default the "decline / prefer not to answer" option.
- Never fill passwords, Social Security numbers, date of birth, or bank details: use "".
- file fields: "resume" for a resume/CV upload, "cover_letter" for a cover letter upload, otherwise "".
- Cover letter: 150–220 words, plain text, specific to this job and company, based on the resume, no placeholders like [Company]. Sign with the applicant's name. For a cover-letter text box use the value "{{cover_letter}}".
- Open questions ("Why do you want to work here?", "Tell us about yourself"): 2–4 honest sentences in first person, grounded in the resume and the job description.
- "How did you hear about this job": the job board the job came from.
- Skip fields that already have a correct value in "current".`;

async function planFill(job, profile, fields) {
  const client = new Anthropic();
  const model = process.env.CLAUDE_MODEL || 'claude-opus-5-5';
  const { resumeText, hasResume, ...facts } = profile;
  const response = await client.messages.parse({
    model,
    max_tokens: 8000,
    ...(/haiku/.test(model) ? { thinking: { type: 'disabled' } } : {}),
    output_config: { effort: 'low', format: zodOutputFormat(FillPlan) },
    system: SYSTEM,
    messages: [{
      role: 'user',
      content: `APPLICANT PROFILE
${JSON.stringify({ ...facts, resumeUploaded: hasResume }, null, 1)}

RESUME
${resumeText || '(no resume text provided)'}

JOB
Title: ${job.title}
Company: ${job.company}
Location: ${job.location}
Found on: ${job.source}
Description:
${(job.description || '(not available)').slice(0, 6000)}

FORM FIELDS
${JSON.stringify(fields.map((f) => (f.options?.length > 40
    ? { ...f, options: [...f.options.slice(0, 12), `…${f.options.length} options in total (e.g. countries); answer with the exact option text`] }
    : f)))}`,
    }],
  });
  usage.calls++;
  usage.input += response.usage?.input_tokens || 0;
  usage.output += response.usage?.output_tokens || 0;
  if (response.stop_reason === 'refusal' || !response.parsed_output) throw new FriendlyError('Claude could not plan this form. The page is open so you can fill it in yourself.', { keepOpen: true });
  return response.parsed_output;
}

// ---------- filling ----------
const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/** 0..1 — how well an option's text matches the answer ("Decline To Self Identify" vs "Decline to self-identify" = 1). */
function similarity(option, answer) {
  const a = norm(option), b = norm(answer);
  if (!a || !b) return 0;
  if (a === b) return 1;
  // Whole-word matches only, so "No" doesn't match "None" or "Nothing".
  if (a.startsWith(`${b} `) || b.startsWith(`${a} `)) return 0.9;
  if (` ${a} `.includes(` ${b} `) || ` ${b} `.includes(` ${a} `)) return 0.8;
  const wa = new Set(a.split(' ')), wb = b.split(' ');
  const overlap = wb.filter((w) => wa.has(w)).length;
  return overlap / Math.max(wa.size, wb.length);
}

async function mark(loc, color) {
  await loc.evaluate((el, c) => { (el.closest('label') && el.type === 'radio' ? el.closest('label') : el).style.outline = `3px solid ${c}`; el.style.outlineOffset = '2px'; }, color).catch(() => {});
}

async function fillField(frame, f, value, files) {
  const loc = frame.locator(`[data-jh="${f.id}"]`);
  switch (f.kind) {
    case 'text':
    case 'textarea':
      await loc.fill(value);
      return mark(loc, '#2f9e44');
    case 'select': {
      const scored = f.options.map((o, i) => ({ o, i, s: similarity(o, value) })).sort((x, y) => y.s - x.s);
      if (!scored.length || scored[0].s < 0.5) throw new Error('no matching option');
      await loc.selectOption({ label: scored[0].o });
      return mark(loc, '#2f9e44');
    }
    case 'radio': {
      const ranked = f.options.map((o, idx) => ({ idx, s: similarity(o, value) })).sort((x, y) => y.s - x.s);
      if (!ranked.length || ranked[0].s < 0.5) throw new Error('no matching option');
      const i = ranked[0].idx;
      const opt = frame.locator(`[data-jh="${f.id}_${i}"]`);
      await opt.check({ force: true });
      return mark(opt, '#2f9e44');
    }
    case 'checkbox':
      if (!/^(true|yes|checked)$/i.test(value)) return;
      await loc.check({ force: true });
      return mark(loc, '#2f9e44');
    case 'combobox': {
      // Searchable dropdowns: type, then click the best matching suggestion. Never press Enter (it could submit).
      // Tags the visible options and returns the best match for `value` (or null).
      const findBest = async (minScore) => {
        const opts = await frame.locator(OPTION_SEL).evaluateAll((els) => els
          .filter((e) => e.getBoundingClientRect().height > 0)
          .map((e, i) => { e.setAttribute('data-jhopt', String(i)); return { i, text: (e.innerText || '').replace(/\s+/g, ' ').trim() }; })
          .filter((o) => o.text && !/^(no options|no results|loading|searching)/i.test(o.text)));
        let best = null;
        for (const o of opts) {
          const s = similarity(o.text, value);
          if (s >= minScore && (!best || s > best.s)) best = { ...o, s };
        }
        return { best, count: opts.length, sample: opts.slice(0, 6).map((o) => o.text) };
      };
      const pick = async (minScore, tries) => {
        for (let t = 0; t < tries; t++) { // suggestions may load from the internet
          await frame.waitForTimeout(300);
          const { best } = await findBest(minScore);
          if (best) { await frame.locator(`[data-jhopt="${best.i}"]`).first().click(); return true; }
        }
        return false;
      };
      await loc.scrollIntoViewIfNeeded().catch(() => {});
      await loc.click({ force: true });
      await frame.waitForTimeout(250);
      if (!(await findBest(0)).count) { await loc.focus(); await frame.page().keyboard.press('ArrowDown'); } // ArrowDown opens the list (never Enter)
      let ok = await pick(0.6, 2);                                   // 1) open the list and choose directly
      if (!ok) { await loc.fill(value); ok = await pick(0.5, 10); }  // 2) search by the full answer
      if (!ok) { await loc.fill(value.split(/[,(-]/)[0].trim()); ok = await pick(0.4, 10); } // 3) search by its first part
      if (!ok) {
        const { sample } = await findBest(0);
        await loc.fill('').catch(() => {});
        await frame.page().keyboard.press('Escape').catch(() => {});
        throw new Error(`no suggestion matched (saw: ${sample.join(' | ') || 'nothing'})`);
      }
      return mark(loc.locator('xpath=ancestor::*[contains(@class,"control") or contains(@class,"container")][1]').or(loc).first(), '#2f9e44');
    }
    case 'file':
      if (value === 'resume' && files.resume) await loc.setInputFiles(files.resume);
      else if (value === 'cover_letter' && files.coverLetter) await loc.setInputFiles(files.coverLetter);
      else return;
      return mark(loc, '#2f9e44');
  }
}

const BANNER = (filled, unsure) => `
  <div id="jobhunt-banner" style="position:sticky;top:0;z-index:2147483647;background:#1d2330;color:#fff;padding:12px 18px;font:14px system-ui;display:flex;gap:16px;align-items:center;box-shadow:0 2px 10px rgba(0,0,0,.3)">
    <b>Job Hunt HQ filled in ${filled} field(s).</b>
    <span><span style="outline:3px solid #2f9e44;padding:0 4px">green</span> = filled &nbsp; <span style="outline:3px solid #f08c00;padding:0 4px">orange</span> = needs you${unsure ? ` (${unsure})` : ''}</span>
    <span style="margin-left:auto">Review everything, then click <b>Submit</b> yourself.</span>
    <button onclick="this.parentNode.remove()" style="background:none;border:1px solid #fff;color:#fff;border-radius:6px;padding:2px 8px;cursor:pointer">✕</button>
  </div>`;

export async function autoFill(jobId) {
  const job = db.prepare('SELECT * FROM jobs WHERE id = ?').get(jobId);
  if (!job) throw new FriendlyError('Job not found.');
  if (!canAutoFill(job.url)) throw new FriendlyError('This job is on a site that doesn\'t allow automated applications (LinkedIn, Indeed, …). Use "Open posting" and apply there yourself.');
  const profile = getProfile();
  if (!profile.firstName || !profile.lastName || !profile.email) throw new FriendlyError('Fill in your Profile first: at least your name and email.');
  if (!process.env.ANTHROPIC_API_KEY) throw new FriendlyError('Auto-fill needs Claude. Add ANTHROPIC_API_KEY to your .env file and restart.');

  await closeSession(jobId);
  const b = await getBrowser();
  const context = await b.newContext({ viewport: null });
  sessions.set(jobId, { context, coverLetter: '' });
  context.on('close', () => sessions.get(jobId)?.context === context && sessions.delete(jobId));

  try {
    let page = await context.newPage();
    await page.goto(job.url, { waitUntil: 'domcontentloaded', timeout: 45000 });
    let frame = await locateForm(page);
    if (!(frame && typeof frame.evaluate === 'function')) {
      throw new FriendlyError('No application form found on this page. It may need you to sign in, or the employer uses a site the app can\'t fill. Open it in your normal browser and apply there.', { keepOpen: true });
    }
    page = frame.page();

    const fields = await frame.evaluate(collectFieldsInPage);
    if (fields.some((f) => f.kind === 'password')) {
      throw new FriendlyError('This site wants you to sign in or create an account first (common on Workday). Sign-in pages block automated windows, so open it in your normal browser and apply there.', { keepOpen: true });
    }

    await readDropdownOptions(frame, fields);
    const plan = await planFill(job, profile, fields);
    const session = sessions.get(jobId);
    if (session) session.coverLetter = plan.cover_letter;

    const letterFile = path.join(LETTER_DIR, `${job.company || 'company'}-${job.id}`.replace(/[^a-z0-9-]+/gi, '_').slice(0, 80) + '.txt');
    fs.writeFileSync(letterFile, plan.cover_letter);
    const files = { resume: profile.hasResume ? RESUME_FILE : null, coverLetter: letterFile };

    const byId = Object.fromEntries(fields.filter((f) => f.id).map((f) => [f.id, f]));
    const filledIds = new Set();
    const failed = [];
    for (const { id, value } of plan.fills) {
      const f = byId[id];
      if (!f || !value) continue;
      const v = value === '{{cover_letter}}' ? plan.cover_letter : value;
      try { await fillField(frame, f, v, files); filledIds.add(id); } catch (e) {
        failed.push(f.label || id);
        if (process.env.JOBHUNT_DEBUG) console.log(`[auto-fill] ${f.kind} "${(f.label || id).slice(0, 60)}" = "${v.slice(0, 40)}": ${e.message.split('\n')[0]}`);
      }
    }

    // Orange outline on anything required that's still empty, plus anything Claude wasn't sure about.
    const needsYou = fields.filter((f) => f.id && !filledIds.has(f.id) && f.required && !f.current);
    for (const f of needsYou) {
      await mark(frame.locator(f.kind === 'radio' ? `[data-jh^="${f.id}_"]` : `[data-jh="${f.id}"]`).first(), '#f08c00');
    }
    await frame.evaluate((html) => {
      document.getElementById('jobhunt-banner')?.remove();
      document.body.insertAdjacentHTML('afterbegin', html);
      window.scrollTo(0, 0);
    }, BANNER(filledIds.size, needsYou.length ? `${needsYou.length} field(s)` : '')).catch(() => {});
    await page.bringToFront();

    return {
      ok: true,
      url: page.url(),
      filled: filledIds.size,
      total: fields.filter((f) => f.id).length,
      needsYou: needsYou.map((f) => f.label || f.id),
      failed,
      notes: plan.notes,
      coverLetter: plan.cover_letter,
      resumeAttached: Boolean(files.resume && plan.fills.some((x) => x.value === 'resume')),
    };
  } catch (e) {
    // Remember where the automated window got to, so the app can offer to open that page in the normal browser.
    const lastPage = context.pages().at(-1);
    let url = lastPage && /^https?:/.test(lastPage.url()) ? lastPage.url() : job.url;
    // A bare sign-in page is useless on its own: send the user to the job posting instead.
    if (SIGN_IN_HOSTS.test(new URL(url).hostname)) url = job.url;
    const err = e instanceof FriendlyError ? e : new FriendlyError(`Auto-fill stopped: ${e.message.split('\n')[0]}`);
    err.url = url;
    // The automated window is no use for signing in, so close it; the user continues in their own browser.
    await closeSession(jobId);
    throw err;
  }
}

export const _sessionsForTesting = sessions;

export async function shutdown() { await browser?.close().catch(() => {}); }
