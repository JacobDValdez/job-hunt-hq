// Job Hunt HQ — front end (no framework).
const $ = (sel, el = document) => el.querySelector(sel);
const view = $('#view');
const modal = $('#modal');

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const safeUrl = (u) => (/^https?:\/\//i.test(u || '') ? esc(u) : '#');

async function api(path, opts = {}) {
  const res = await fetch(path, {
    ...opts,
    headers: { 'Content-Type': 'application/json', 'X-JobHunt': '1', ...(opts.headers || {}) },
    body: opts.body && typeof opts.body !== 'string' ? JSON.stringify(opts.body) : opts.body,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || `Request failed (${res.status})`), { data });
  return data;
}

function toast(msg, kind = '') {
  const t = document.createElement('div');
  t.className = `toast ${kind}`;
  t.textContent = msg;
  $('#toasts').append(t);
  setTimeout(() => t.remove(), kind === 'error' ? 7000 : 3500);
}

async function busy(btn, fn) {
  const label = btn.innerHTML;
  btn.disabled = true;
  if (!btn.classList.contains('icon-btn')) btn.textContent = 'Working…'; // icon-only buttons just dim
  try { return await fn(); } catch (e) { toast(e.message, 'error'); } finally { btn.disabled = false; btn.innerHTML = label; }
}

// ---------- formatting ----------
const fmtDate = (iso) => (iso ? new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: new Date(iso).getFullYear() !== new Date().getFullYear() ? 'numeric' : undefined }) : '');
const fmtDateTime = (iso) => (iso ? new Date(iso).toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '');
const fmtTime = (iso) => new Date(iso).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
function ago(iso) {
  if (!iso) return '';
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  if (s < 86400 * 30) return `${Math.round(s / 86400)}d ago`;
  return fmtDate(iso);
}
const toLocalInput = (d) => new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
const CAT_LABEL = { interview: 'Interview', rejection: 'Rejection', offer: 'Offer', recruiter: 'Recruiter', application_confirmation: 'Applied (confirmation)', job_alert: 'Job alert', other: 'Other' };
const STATUSES = ['applied', 'replied', 'interview', 'offer', 'rejected', 'ghosted'];
// Company logo with a letter fallback underneath (shown when no logo is found).
function logo(company, { domain = '', size = '' } = {}) {
  const name = String(company || domain || '').trim();
  const letter = (name.match(/[A-Za-z0-9]/) || ['?'])[0].toUpperCase();
  const hue = [...name].reduce((h, ch) => (h * 31 + ch.charCodeAt(0)) % 360, 7);
  const q = new URLSearchParams(domain ? { domain } : { company: name });
  return `<span class="logo ${size}" style="--hue:${hue}" data-l="${esc(letter)}">${name ? `<img src="/api/logo?${esc(q)}" alt="" loading="lazy" onerror="this.remove()">` : ''}</span>`;
}
const fromDomain = (addr = '') => (addr.split('@')[1] || '').split('.').slice(-2).join('.');
const badge = (key, label = key) => `<span class="badge" style="--c:var(--c-${esc(key)})">${esc(label)}</span>`;
const placeTag = (j) => (j.anywhere ? '<span class="tag solid">Work from anywhere</span>' : j.remote ? '<span class="tag">Remote</span>' : '');

// ---------- router ----------
const views = { dashboard, jobs, skills, boards, applications, inbox, calendar, profile, settings };
const NO_AUTOFILL = /(^|\.)(linkedin\.com|indeed\.com|glassdoor\.com|ziprecruiter\.com|monster\.com|remoteok\.com)$/i;
const canAutoFill = (url) => { try { return !NO_AUTOFILL.test(new URL(url).hostname); } catch { return false; } };
let status = null;

async function refreshStatus() {
  status = await api('/api/status');
  $('#nav-jobs').textContent = status.counts.newJobs || '';
  $('#nav-inbox').textContent = status.counts.needsDate || '';
  $('#conn-status').innerHTML = `
    <div><span class="dot ${status.gmail.connected ? 'on' : ''}"></span>Gmail ${status.gmail.connected ? 'connected' : 'not connected'}</div>
    <div><span class="dot ${status.claude ? 'on' : ''}"></span>Claude AI ${status.claude ? 'on' : 'off'}</div>`;
}

async function route() {
  const [name, query = ''] = location.hash.slice(1).split('?');
  const v = views[name] ? name : 'dashboard';
  document.querySelectorAll('nav a').forEach((a) => a.classList.toggle('active', a.dataset.view === v));
  view.onclick = null;
  view.onchange = null;
  const params = new URLSearchParams(query);
  if (params.get('gmail') === 'connected') toast('Gmail connected. Pulling in your job emails…');
  if (params.get('gmail') === 'denied') toast('Gmail access was not granted.', 'error');
  try {
    await refreshStatus();
    await views[v]();
  } catch (e) {
    view.innerHTML = `<div class="card empty">Something went wrong: ${esc(e.message)}</div>`;
  }
}
window.addEventListener('hashchange', route);
route();

// ---------- dashboard ----------
async function dashboard() {
  const now = new Date();
  const [events, emails, prof, settingsData, top] = await Promise.all([
    api(`/api/events?from=${now.toISOString()}&to=9999`),
    api('/api/emails'),
    api('/api/profile'),
    api('/api/settings'),
    api('/api/jobs?status=new'),
  ]);
  const c = status.counts;
  const lf = status.lastJobFetch;
  const setup = [];
  if (!status.gmail.configured) setup.push('Gmail isn’t set up yet. Follow <b>step 2 in SETUP.md</b> to add your Google keys, then restart the app.');
  else if (!status.gmail.connected) setup.push('Gmail is ready to connect. <a href="/auth/google">Connect Gmail</a>');
  if (!status.claude) setup.push('Add an <b>ANTHROPIC_API_KEY</b> to <code>.env</code> so the app can sort emails accurately, find interview times, and read job-alert emails. Without it the app uses simple keyword rules.');
  const name = [prof.firstName, prof.lastName].filter(Boolean).join(' ');

  view.innerHTML = `
    <section class="hero">
      <div class="eyebrow" style="color:#7fe0d6">${esc(now.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' }))}</div>
      <h1>Your Job Hunt<br>Headquarters</h1>
      <div class="lead">Every lead from the boards you trust, every reply from your inbox, and every interview on one calendar.</div>
      <button class="primary cta" id="hero-refresh">Check job boards now</button>
      <hr>
      ${name ? `<div class="who">${esc(name)}</div><div style="color:rgba(255,255,255,.65)">${esc([prof.yearsExperience && `${prof.yearsExperience} years experience`, [prof.city, prof.state].filter(Boolean).join(', ')].filter(Boolean).join(' · ') || 'Job seeker')}</div>`
        : '<div class="who">Welcome!</div><div style="color:rgba(255,255,255,.65)">Fill in <a href="#profile" style="color:#7fe0d6">My profile</a> to personalize this page and turn on auto-fill.</div>'}
      ${prof.currentTitle ? `<div class="headline">${esc(prof.currentTitle)}</div>` : ''}
      <div class="label">Searching for</div>
      <div class="tags">${settingsData.keywords.slice(0, 10).map((k) => `<span>${esc(k)}</span>`).join('')}${settingsData.keywords.length > 10 ? `<span>+${settingsData.keywords.length - 10} more</span>` : ''}</div>
    </section>
    ${setup.map((s) => `<div class="notice warn">${s}</div>`).join('')}
    <div class="grid cols-4" style="margin-bottom:18px">
      <a class="card stat" href="#jobs"><div class="num">${c.newJobs}</div><div class="label">New job leads</div></a>
      <a class="card stat" href="#applications"><div class="num">${c.active}</div><div class="label">Active applications</div></a>
      <a class="card stat" href="#calendar"><div class="num" style="color:var(--teal)">${c.upcoming}</div><div class="label">Upcoming interviews</div></a>
      <a class="card stat" href="#applications"><div class="num" style="color:var(--purple)">${c.offers}</div><div class="label">Offers</div></a>
    </div>
    ${top.jobs.length ? `
    <div class="eyebrow" style="margin-top:26px">Best matches right now</div>
    <h2 style="font-size:24px">Your top job leads</h2>
    <div class="list" style="margin-bottom:24px">${top.jobs.slice(0, 5).map((j, i) => `
      <a class="card with-logo" href="${safeUrl(j.url)}" target="_blank" rel="noopener noreferrer" style="text-decoration:none;color:inherit;align-items:center">
        <span class="rank">${i + 1}</span>${logo(j.company)}
        <div class="grow"><b style="font-size:15.5px">${esc(j.title)}</b> ${placeTag(j)}
          <div class="muted small">${esc(j.company)} · ${esc(j.location || 'Location not listed')}${j.salary ? ` · <b style="color:var(--ink)">${esc(j.salary)}</b>` : ''}</div></div>
        <span class="tag gray">${esc(j.source)}</span>
      </a>`).join('')}</div>` : ''}
    <div class="grid cols-2">
      <div class="card"><div class="eyebrow">Calendar</div><h2>Upcoming interviews</h2>
        ${events.length ? `<div class="list">${events.slice(0, 6).map((e) => `
          <div><b>${esc(fmtDateTime(e.start_at))}</b><br>${esc(e.title)}${e.location ? `<div class="muted small">${esc(e.location)}</div>` : ''}</div>`).join('')}</div>`
          : '<div class="muted">No interviews scheduled yet.</div>'}
        ${c.needsDate ? `<p><a href="#inbox?f=interview">${c.needsDate} interview email(s) need a time set →</a></p>` : ''}
      </div>
      <div class="card"><div class="eyebrow">Inbox</div><h2>Recent replies</h2>
        ${emails.filter((e) => e.category !== 'job_alert').slice(0, 7).map((e) => `
          <div class="with-logo" style="margin-bottom:12px">${e.company ? logo(e.company) : logo(e.from_name, { domain: fromDomain(e.from_addr) })}<div class="grow">${badge(e.category, CAT_LABEL[e.category])} <b>${esc(e.company || e.from_name)}</b> <span class="muted small">${esc(ago(e.received_at))}</span>
          <div class="muted small">${esc(e.summary || e.subject)}</div></div></div>`).join('') || `<div class="muted">${status.gmail.connected ? 'No job-related emails yet.' : 'Connect Gmail to see replies here.'}</div>`}
      </div>
    </div>
    <p class="muted small">${lf ? `Job boards last checked ${esc(ago(lf.finishedAt))} — ${lf.added} new matching jobs.` : 'Job boards haven’t been checked yet.'}</p>`;

  $('#hero-refresh').onclick = (ev) => busy(ev.target, async () => {
    const r = await api('/api/jobs/refresh', { method: 'POST' });
    toast(`${r.added} new matching jobs found.`);
    route();
  });
}

// ---------- jobs ----------
const jobFilter = { status: 'new', q: '', source: '', place: '', sort: 'match' };
async function jobs() {
  const p = new URLSearchParams(jobFilter);
  const [data, s] = await Promise.all([api(`/api/jobs?${p}`), api('/api/settings')]);
  currentKeywords = s.keywords;
  const lf = status.lastJobFetch;
  view.innerHTML = `
    <div class="page-head">
      <div><div class="eyebrow">Job leads</div><h1>Roles that match you</h1><div class="muted">${lf ? `Last checked ${esc(ago(lf.finishedAt))}` : 'Not checked yet'} · matching: ${esc(s.keywords.slice(0, 6).join(', ') || 'everything')}${s.keywords.length > 6 ? '…' : ''} · <a href="#settings">change</a></div></div>
      <button class="primary" id="refresh"><svg class="ic"><use href="#i-refresh"/></svg>Check job boards now</button>
    </div>
    <div class="toolbar">
      <input id="q" placeholder="Filter by title, company, location" value="${esc(jobFilter.q)}" style="min-width:260px">
      <select id="sort" title="Sort order">${[['match', 'Best match to my resume'], ['', 'Most relevant to my keywords']].map(([v, l]) => `<option value="${v}" ${v === jobFilter.sort ? 'selected' : ''}>${l}</option>`).join('')}</select>
      <select id="place">${[['', 'Any location'], ['remote', 'Remote'], ['anywhere', 'Work from anywhere']].map(([v, l]) => `<option value="${v}" ${v === jobFilter.place ? 'selected' : ''}>${l}</option>`).join('')}</select>
      <select id="st">${['new', 'saved', 'applied', 'dismissed', 'all'].map((s) => `<option ${s === jobFilter.status ? 'selected' : ''} value="${s}">${s === 'new' ? 'New' : s[0].toUpperCase() + s.slice(1)}</option>`).join('')}</select>
      <select id="src"><option value="">All sources</option>${data.sources.map((s) => `<option value="${esc(s.source)}" ${s.source === jobFilter.source ? 'selected' : ''}>${esc(s.source)} (${s.n})</option>`).join('')}</select>
      <span class="muted">${data.jobs.length}${data.jobs.length === 300 ? '+' : ''} jobs</span>
    </div>
    ${lf ? sourceErrors(lf) : ''}
    <div class="list" id="joblist">${data.jobs.map(jobCard).join('') || `<div class="card empty">No jobs here. ${jobFilter.status === 'new' ? 'Click <b>Check job boards now</b>, or broaden your keywords in Settings.' : ''}</div>`}</div>`;

  $('#refresh').onclick = (ev) => busy(ev.target, async () => {
    const r = await api('/api/jobs/refresh', { method: 'POST' });
    toast(`${r.added} new matching jobs found.`);
    route();
  });
  let t;
  $('#q').oninput = (ev) => { clearTimeout(t); t = setTimeout(() => { jobFilter.q = ev.target.value; jobs().then(() => { const q = $('#q'); q.focus(); q.setSelectionRange(q.value.length, q.value.length); }); }, 300); };
  $('#st').onchange = (ev) => { jobFilter.status = ev.target.value; jobs(); };
  $('#src').onchange = (ev) => { jobFilter.source = ev.target.value; jobs(); };
  $('#place').onchange = (ev) => { jobFilter.place = ev.target.value; jobs(); };
  $('#sort').onchange = (ev) => { jobFilter.sort = ev.target.value; jobs(); };
  $('#joblist').onclick = async (ev) => {
    const b = ev.target.closest('button[data-act]');
    if (!b) return;
    const id = b.closest('[data-id]').dataset.id;
    if (b.dataset.act === 'autofill') return autoFillJob(b, id);
    await busy(b, async () => {
      if (b.dataset.act === 'applied') { await api(`/api/jobs/${encodeURIComponent(id)}/apply`, { method: 'POST' }); toast('Added to your applications.'); }
      else await api(`/api/jobs/${encodeURIComponent(id)}/status`, { method: 'POST', body: { status: b.dataset.act } });
      b.closest('[data-id]').remove();
      refreshStatus();
    });
  };
}

async function autoFillJob(btn, id) {
  const label = btn.innerHTML;
  btn.disabled = true;
  btn.textContent = 'Opening & filling… (about 20s)';
  let r;
  try {
    r = await api(`/api/apply/${encodeURIComponent(id)}`, { method: 'POST' });
  } catch (e) {
    btn.disabled = false; btn.innerHTML = label;
    if (/Profile first/.test(e.message)) { toast(e.message, 'error'); location.hash = 'profile'; return; }
    const url = e.data?.url;
    $('#modal-body').innerHTML = `<h2>Couldn’t auto-fill this one</h2><p>${esc(e.message)}</p>
      ${url ? `<p class="muted small">Your normal browser is where you’re already signed in to Google and other sites, so sign-in pages work there.</p>` : ''}
      <div class="actions">
        ${url ? `<a class="btn primary" id="open" href="${safeUrl(url)}" target="_blank" rel="noopener noreferrer">Open in my normal browser ↗</a>` : ''}
        <button class="${url ? '' : 'primary'}" id="ok">${url ? 'Close' : 'OK'}</button>
      </div>`;
    modal.showModal();
    $('#ok').onclick = () => modal.close();
    const open = $('#open');
    if (open) open.onclick = () => setTimeout(() => modal.close(), 100);
    return;
  }
  btn.disabled = false; btn.innerHTML = label;
  $('#modal-body').innerHTML = `
    <h2>Application filled — your turn</h2>
    <p>A browser window opened with the form. <b>${r.filled}</b> field(s) filled (outlined green)${r.resumeAttached ? ', resume attached' : ''}.</p>
    ${r.needsYou.length ? `<div class="notice warn small"><b>Needs you (outlined orange):</b><br>${r.needsYou.map(esc).join('<br>')}</div>` : ''}
    ${r.failed.length ? `<div class="notice warn small"><b>Couldn’t fill:</b> ${r.failed.map(esc).join(', ')}</div>` : ''}
    ${r.notes ? `<p class="muted small">${esc(r.notes)}</p>` : ''}
    <details><summary>Cover letter written for this job</summary><p>${esc(r.coverLetter)}</p></details>
    <p><b>Check every answer in that window, then click the site’s Submit button yourself.</b> Afterwards, tell the app what happened:</p>
    <p class="muted small">If the form asks you to sign in with Google (or another account), that won’t work in the automated window.
      <a href="${safeUrl(r.url)}" target="_blank" rel="noopener noreferrer">Open this form in your normal browser ↗</a> instead; the answers won’t carry over, but the cover letter above can be copied.</p>
    <div class="actions"><button class="primary" id="sub">I submitted it</button><button id="nosub">I didn’t submit</button></div>`;
  modal.showModal();
  const done = async (submitted) => {
    await api(`/api/apply/${encodeURIComponent(id)}/done`, { method: 'POST', body: { submitted } });
    modal.close();
    if (submitted) { toast('Marked as applied. Replies will be tracked from Gmail.'); btn.closest('[data-id]')?.remove(); refreshStatus(); }
  };
  $('#sub').onclick = () => done(true);
  $('#nosub').onclick = () => done(false);
}

function sourceErrors(lf) {
  const bad = Object.entries(lf.sources || {}).filter(([, v]) => v.status === 'error');
  return bad.length ? `<div class="notice warn small">Some sources failed last time: ${bad.map(([k, v]) => `<b>${esc(k)}</b> (${esc(v.error.slice(0, 120))})`).join('; ')}</div>` : '';
}

// Resume match ring: green 70%+, teal 45%+, amber below.
function matchBadge(m) {
  if (!m) return '';
  const color = m.pct >= 70 ? 'var(--green)' : m.pct >= 45 ? 'var(--teal)' : 'var(--amber)';
  return `<span class="match-badge" style="--m:${m.pct};--mc:${color}" title="Your resume shows ${m.have.length} of the ${m.total} skills this job mentions"><b>${m.pct}%</b> match</span>`;
}

// Which of your search keywords this job mentions (shown like the report's "You bring" chips).
let currentKeywords = [];
function matchedKeywords(j) {
  const title = (j.title || '').toLowerCase();
  const text = `${title} ${(j.tags || '').toLowerCase()} ${(j.description || '').toLowerCase()}`;
  const hits = currentKeywords.filter((k) => k && (title.includes(k.toLowerCase())));
  const more = currentKeywords.filter((k) => k && !hits.includes(k) && new RegExp(`\\b${k.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(text));
  return [...hits, ...more].slice(0, 4);
}

function jobCard(j) {
  return `<div class="card job with-logo" data-id="${esc(j.id)}">
    ${logo(j.company, { size: 'lg' })}
    <div class="grow">
    <div style="display:flex;justify-content:space-between;gap:10px;align-items:flex-start">
      <div><h3><a href="${safeUrl(j.url)}" target="_blank" rel="noopener noreferrer">${esc(j.title)}</a></h3>
      <div class="meta"><b>${esc(j.company)}</b> ${placeTag(j)}</div></div>
      <div style="display:flex;gap:8px;align-items:center">${matchBadge(j.match)}<span class="tag gray">${esc(j.source)}</span></div>
    </div>
    <div class="facts">
      <div><span>Location</span><b>${esc(j.location || (j.remote ? 'Remote' : 'Not listed'))}</b></div>
      <div><span>Pay</span><b>${esc(j.salary || 'Not listed')}</b></div>
      <div><span>Posted</span><b>${esc(ago(j.posted_at || j.fetched_at))}</b></div>
    </div>
    ${(() => { const m = matchedKeywords(j); return m.length ? `<div class="match"><span class="lbl">You match</span>${m.map((k) => `<span class="tag">${esc(k)}</span>`).join('')}</div>` : ''; })()}
    ${j.match?.gaps.length ? `<div class="match"><span class="lbl">Not on your resume</span>${j.match.gaps.slice(0, 4).map((g) => `<span class="tag build">+ ${esc(g)}</span>`).join('')}${j.match.gaps.length > 4 ? `<span class="small muted">+${j.match.gaps.length - 4} more</span>` : ''}</div>` : ''}
    ${j.description ? `<details><summary>Job description</summary><p>${esc(j.description)}</p></details>` : ''}
    <div class="actions">
      ${j.status !== 'applied' && canAutoFill(j.url) ? `<button class="primary" data-act="autofill" title="Opens the application in a browser window and fills it in for you to review"><svg class="ic"><use href="#i-spark"/></svg>Auto-fill application</button>` : ''}
      <a class="btn ${j.status !== 'applied' && canAutoFill(j.url) ? '' : 'primary'}" href="${safeUrl(j.url)}" target="_blank" rel="noopener noreferrer">Open posting <svg class="ic"><use href="#i-external"/></svg></a>
      <span class="spacer"></span>
      ${j.status !== 'applied' ? `<button class="icon-btn" data-act="applied" title="I applied: move to Applications" aria-label="I applied"><svg class="ic"><use href="#i-done"/></svg></button>` : '<span class="tag green">Applied</span>'}
      ${j.status === 'saved' ? `<button class="icon-btn on" data-act="new" title="Saved: click to unsave" aria-label="Unsave"><svg class="ic"><use href="#i-bookmark"/></svg></button>` : j.status !== 'applied' ? `<button class="icon-btn" data-act="saved" title="Save for later" aria-label="Save"><svg class="ic"><use href="#i-bookmark"/></svg></button>` : ''}
      ${j.status !== 'dismissed' && j.status !== 'applied' ? `<button class="icon-btn" data-act="dismissed" title="Not interested: hide this job" aria-label="Not interested"><svg class="ic"><use href="#i-x"/></svg></button>` : ''}
      ${j.status === 'dismissed' ? `<button data-act="new">Restore</button>` : ''}
    </div>
    </div>
  </div>`;
}

// ---------- skill match (resume vs. what your job leads ask for) ----------
async function skills() {
  const d = await api('/api/skills');
  if (!d.hasResume) {
    view.innerHTML = `<div class="eyebrow">Skill match</div><h1>What to add to your resume</h1>
      <div class="card empty">Upload your resume in <a href="#profile">My profile</a> first. Then this page compares it with every job lead you have.</div>`;
    return;
  }
  const build = d.rows.filter((r) => !r.have);
  const row = (r, i) => `<div class="skill-row"><span class="n">${i + 1}</span><b>${esc(r.name)}</b>
      <span class="pct">in ${r.pct}% of listings</span>${r.have ? '<span class="tag">✓ On resume</span>' : '<span class="tag build">+ Add</span>'}</div>`;
  view.innerHTML = `
    <div class="eyebrow">Skill match · your resume vs. ${d.jobsAnalyzed} job leads</div>
    <h1>What to add to your resume to stand out</h1>
    <div class="muted" style="font-size:15px;margin-bottom:18px">Your resume vs. what your current job leads actually ask for. Start with the top 5, then work down the list.</div>
    <div class="card" style="padding:24px 26px">
      <div class="card-head" style="align-items:center">
        <h2 style="font-size:22px">Your job leads</h2>
        <div class="skill-stats">
          <div><b style="color:var(--teal)">${d.alignment}%</b><span>Alignment</span></div>
          <div><b style="color:var(--teal)">${d.haveCount}/${d.total}</b><span>Skills</span></div>
          <div><b style="color:var(--orange)">${d.total - d.haveCount}</b><span>To add</span></div>
        </div>
      </div>
      <div class="eyebrow" style="color:var(--orange)">Add these 5 to your resume first</div>
      <div class="top5">${build.slice(0, 5).map((r, i) => `<div class="skill-row"><span class="n">${i + 1}</span><b>${esc(r.name)}</b><span class="pct">${r.pct}% of listings</span><span class="bar"><i style="width:${r.pct}%"></i></span></div>`).join('')}</div>
      <div class="small muted" style="margin:14px 0 18px;display:flex;gap:14px;flex-wrap:wrap">
        <span><span class="tag">✓ On resume</span> your resume already says it</span>
        <span><span class="tag build">+ Add</span> not on your resume yet: if you have this skill, add the words; if not, it’s one to build</span>
      </div>
      <div class="eyebrow">Most requested skills <span class="muted" style="text-transform:none;letter-spacing:0;font-weight:500">in demand order</span></div>
      ${d.rows.slice(0, 20).map(row).join('')}
      <div class="small muted" style="margin-top:12px">Scored against the ${d.total} skills your leads mention most. Updates automatically as new jobs come in or you edit your resume text in <a href="#profile">My profile</a>.</div>
    </div>
    <div class="callout">Tip: many “+ Add” items are skills you already use. Communication, adaptability and teamwork usually show up in past jobs without being named. Write them into your resume in the job posting’s words, then re-check this page.</div>

    <div class="eyebrow" style="margin-top:30px">Why this matters</div>
    <h2 style="font-size:24px">What’s an ATS, and why do the words on your resume matter?</h2>
    <div class="grid explain" style="margin-top:6px">
      <div class="card">
        <h4 class="eyebrow" style="margin:0 0 8px">What an ATS is</h4>
        <p style="margin:0 0 10px">An <b>Applicant Tracking System (ATS)</b> is the software companies use to collect and manage job applications. Greenhouse, Lever, Workday, iCIMS and Ashby are common ones. Most of the applications you send, including through this app, land in one.</p>
        <p style="margin:0">The ATS reads your resume and turns it into searchable text, then stores it alongside hundreds or thousands of other applicants for the same role.</p>
      </div>
      <div class="card">
        <h4 class="eyebrow" style="margin:0 0 8px">Why companies use one</h4>
        <ul style="margin:0;padding-left:18px;line-height:1.7">
          <li><b>Volume:</b> a single remote job can get hundreds of applicants. Nobody can read them all one by one.</li>
          <li><b>Search and filters:</b> recruiters search the pile for the skills in the job post, like “customer success” or “CRM”.</li>
          <li><b>Screening questions:</b> forms ask about things like work authorization, which can filter applicants out automatically.</li>
          <li><b>Organization and compliance:</b> tracking every candidate, interview and decision in one place.</li>
        </ul>
      </div>
      <div class="card" style="grid-column:1/-1">
        <h4 class="eyebrow" style="margin:0 0 8px">Why the suggested wording changes help</h4>
        <ul style="margin:0;padding-left:18px;line-height:1.7">
          <li><b>Recruiters search for exact words.</b> If a job asks for “communication” and your resume only says “handled 50 calls a day”, a keyword search may not find you, even though you clearly have the skill.</li>
          <li><b>Some systems rank or highlight matches.</b> Resumes that use the job’s own terms often show up higher or get flagged as a closer fit.</li>
          <li><b>Humans skim in seconds.</b> When a recruiter does open your resume, familiar words make the match obvious at a glance.</li>
          <li><b>Honesty first:</b> only add words for skills you really have. The goal is to describe your real experience in the employer’s language, not to stuff in keywords. That gets noticed in interviews.</li>
        </ul>
        <p class="small muted" style="margin:10px 0 0">The match % here is a guide: it measures how many of a job’s listed skills your resume <i>names</i>, not whether you’d be good at the job.</p>
      </div>
    </div>`;
}

// ---------- where to look (boards) ----------
// key = source id in Settings (connected boards); link-only boards have no key.
const BOARDS = {
  anywhere: [
    { key: 'weworkremotely', source: 'We Work Remotely', name: 'We Work Remotely', domain: 'weworkremotely.com', url: 'https://weworkremotely.com/remote-jobs', price: 'Free', desc: 'The biggest remote job community. Jobs tagged “Anywhere in the World” are marked here.' },
    { key: 'himalayas', source: 'Himalayas', name: 'Himalayas', domain: 'himalayas.app', url: 'https://himalayas.app/jobs', price: 'Free', desc: 'Clean worldwide filter, with time zones and salary on listings. Jobs closed to your country are skipped.' },
    { key: 'remoteok', source: 'RemoteOK', name: 'RemoteOK', domain: 'remoteok.com', url: 'https://remoteok.com', price: 'Free', desc: 'Huge volume, tech and startup heavy. Applying there needs a RemoteOK account.' },
  ],
  best: [
    { name: 'FlexJobs', domain: 'flexjobs.com', url: 'https://www.flexjobs.com/', price: 'Paid', desc: 'Every listing hand-screened. Paid membership and login, so it can’t be pulled in automatically.' },
    { name: 'Remote.co', domain: 'remote.co', url: 'https://remote.co/remote-jobs/', price: 'Free', desc: 'Curated remote-first companies, strong for non-tech roles. Blocks automated access, so open it directly.' },
    { key: 'remotive', source: 'Remotive', name: 'Remotive', domain: 'remotive.com', url: 'https://remotive.com/remote-jobs', price: 'Free', desc: 'Remote jobs since 2014, tech-leaning, active community.' },
  ],
  companies: [
    { key: 'greenhouse', source: 'Greenhouse', name: 'Greenhouse company boards', domain: 'greenhouse.io', setting: 'greenhouseCompanies', price: 'Free', desc: 'Pulled straight from employers (e.g. GitLab, Stripe). Auto-fill works best here.' },
    { key: 'lever', source: 'Lever', name: 'Lever company boards', domain: 'lever.co', setting: 'leverCompanies', price: 'Free', desc: 'Pulled straight from employers. Auto-fill works here.' },
    { key: 'ashby', source: 'Ashby', name: 'Ashby company boards', domain: 'ashbyhq.com', setting: 'ashbyCompanies', price: 'Free', desc: 'Work-from-anywhere employers like Zapier and Buffer. Auto-fill works here.' },
    { key: 'arbeitnow', source: 'Arbeitnow', name: 'Arbeitnow', domain: 'arbeitnow.com', url: 'https://www.arbeitnow.com/', price: 'Free', desc: 'Europe-focused plus remote. Many applications need a join.com account.' },
    { key: 'adzuna', source: 'Adzuna', name: 'Adzuna', domain: 'adzuna.com', url: 'https://www.adzuna.com/', price: 'Free key', desc: 'Huge search engine across all job types, great for sales and support. Needs a free key in .env.' },
  ],
};

async function boards() {
  const [s, counts] = await Promise.all([api('/api/settings'), api('/api/jobs?status=new&q=&source=')]);
  const n = Object.fromEntries(counts.sources.map((x) => [x.source, x.n]));
  const lf = status.lastJobFetch?.sources || {};
  const card = (b) => {
    const on = b.key && s.sources[b.key];
    const err = b.key && lf[b.key]?.status === 'error';
    const notCfg = b.key && lf[b.key]?.status === 'not configured';
    const state = !b.key ? '<span class="tag gray">Link only</span>'
      : err ? '<span class="tag amber">Error last check</span>'
      : notCfg ? '<span class="tag amber">Needs key</span>'
      : on ? `<span class="tag">Connected · ${n[b.source] || 0} new</span>` : '<span class="tag gray">Off</span>';
    return `<div class="card board">
      ${logo(b.name, { domain: b.domain })}
      <div class="grow"><div class="name">${esc(b.name)}</div><div class="desc">${esc(b.desc)}</div>
        ${b.setting ? `<div class="small muted" style="margin-top:4px">Companies: ${esc((s[b.setting] || []).join(', ') || 'none')} · <a href="#settings">edit</a></div>` : ''}</div>
      <div class="right">${state}<span class="tag ${b.price === 'Paid' ? 'amber' : 'green'}">${esc(b.price)}</span>
        ${b.key ? `<label class="small" style="margin:0;display:flex;gap:6px;align-items:center;font-weight:600"><input type="checkbox" data-src="${b.key}" ${on ? 'checked' : ''}> Use</label>` : ''}
        ${b.url ? `<a class="btn" href="${safeUrl(b.url)}" target="_blank" rel="noopener noreferrer">Open ↗</a>` : ''}
        ${b.key ? `<button class="link small" data-only="${esc(b.source)}">View jobs</button>` : ''}</div>
    </div>`;
  };
  view.innerHTML = `
    <div class="eyebrow">Where to look</div>
    <h1>Where to find these jobs</h1>
    <div class="muted" style="font-size:15px;margin-bottom:18px">Not all “remote” is the same. Know which kind you’re applying for, then use the boards built for it.</div>
    <div class="explain">
      <div class="card"><h4>Remote job</h4><div>Work from home, but usually tied to one country or state for payroll and tax. “Remote (US)” means US only. The most common kind, and the biggest job pool.</div></div>
      <div class="card highlight"><h4>Work from anywhere</h4><div>No location requirement at all. Any country, any time zone. Rarer. Filter for these on Job leads with <b>Work from anywhere</b>.</div></div>
    </div>
    <div class="section-label"><span class="tagdark">Work-from-anywhere filtering</span><span class="muted small">boards where you can filter to true anywhere-in-the-world roles</span></div>
    <div class="list">${BOARDS.anywhere.map(card).join('')}</div>
    <div class="section-label"><span class="taglight">Best remote job boards</span><span class="muted small">the strongest boards for remote roles overall</span></div>
    <div class="list">${BOARDS.best.map(card).join('')}</div>
    <div class="section-label"><span class="tagdark">Straight from employers</span><span class="muted small">company hiring systems — the best place to use auto-fill</span></div>
    <div class="list">${BOARDS.companies.map(card).join('')}</div>
    <div class="callout">Connected boards are checked automatically every ${s.fetchIntervalHours} hour(s). <b>Link only</b> boards can’t be pulled in (paid, or they block automated access) — open them to browse.</div>`;

  view.onclick = (ev) => {
    const only = ev.target.closest('[data-only]');
    if (only) { jobFilter.source = only.dataset.only; jobFilter.status = 'new'; location.hash = 'jobs'; }
  };
  view.onchange = async (ev) => {
    const key = ev.target.dataset?.src;
    if (!key) return;
    try {
      await api('/api/settings', { method: 'PUT', body: { sources: { ...s.sources, [key]: ev.target.checked } } });
      s.sources[key] = ev.target.checked;
      toast(ev.target.checked ? 'Board turned on. It will be included in the next check.' : 'Board turned off.');
    } catch (e) { toast(e.message, 'error'); }
  };
}

// ---------- applications ----------
let appFilter = '';
async function applications() {
  const apps = await api('/api/applications');
  const counts = Object.fromEntries(STATUSES.map((s) => [s, apps.filter((a) => a.status === s).length]));
  const shown = appFilter ? apps.filter((a) => a.status === appFilter) : apps;
  const SOURCE_LABEL = { gmail: 'Found in Gmail', 'auto-fill': 'Auto-filled', 'job-board': 'From job leads', manual: 'Added by you' };
  view.innerHTML = `
    <div class="page-head"><div><div class="eyebrow">Your pipeline</div><h1>Applications</h1><div class="muted">${apps.length} tracked · statuses update automatically from Gmail</div></div>
      <button class="primary" id="add">+ Add application</button></div>
    ${apps.length ? `<div class="pipeline" title="Your pipeline">${STATUSES.filter((s) => counts[s]).map((s) => `<span style="width:${(counts[s] / apps.length) * 100}%;background:var(--c-${s})" title="${s}: ${counts[s]}"></span>`).join('')}</div>` : ''}
    <div class="chips" style="margin-bottom:18px" id="appchips">
      <button class="chip ${appFilter === '' ? 'active' : ''}" data-st="">All · ${apps.length}</button>
      ${STATUSES.map((s) => `<button class="chip ${appFilter === s ? 'active' : ''}" data-st="${s}" style="text-transform:capitalize">${s} · ${counts[s]}</button>`).join('')}
    </div>
    <div class="list" id="apps">
      ${shown.map((a) => `<div class="card app-card" data-id="${a.id}">
        ${logo(a.company, { size: 'lg' })}
        <div class="title"><b>${esc(a.company)}</b>
          <div class="muted">${a.url ? `<a href="${safeUrl(a.url)}" target="_blank" rel="noopener noreferrer">${esc(a.title || 'View posting')}</a>` : esc(a.title || 'Role not recorded')}</div>
          <div class="small" style="margin-top:4px"><span class="tag gray">${esc(SOURCE_LABEL[a.source] || a.source)}</span>${a.email_count ? ` <a href="#inbox?app=${a.id}" class="small">${a.email_count} email${a.email_count > 1 ? 's' : ''}</a>` : ''}</div></div>
        <select data-f="status" class="status-select" style="--c:var(--c-${a.status})">${STATUSES.map((s) => `<option value="${s}" ${s === a.status ? 'selected' : ''}>${s}</option>`).join('')}</select>
        <div class="facts">
          <div><span>Applied</span><b>${esc(fmtDate(a.applied_at))}</b></div>
          <div><span>Next interview</span>${a.next_event ? `<b>${esc(fmtDateTime(a.next_event))}</b>` : `<button class="link" data-act="event">+ Add</button>`}</div>
        </div>
        <button class="icon-btn ghost" data-act="del" title="Delete application" aria-label="Delete application"><svg class="ic"><use href="#i-x"/></svg></button>
        <div class="app-notes"><textarea data-f="notes" rows="1" placeholder="✎ Add a note…">${esc(a.notes === 'Added automatically from an email.' ? '' : a.notes)}</textarea></div>
      </div>`).join('') || `<div class="card empty">${apps.length ? 'No applications with this status.' : 'No applications yet. Click <b>I applied</b> on a job lead, add one here, or connect Gmail and the app will pick them up from confirmation emails.'}</div>`}
    </div>`;
  $('#appchips').onclick = (ev) => { const c = ev.target.closest('[data-st]'); if (c) { appFilter = c.dataset.st; applications(); } };

  $('#add').onclick = () => openForm('Add application', `
      <div class="field"><label>Company</label><input name="company" required style="width:100%"></div>
      <div class="field"><label>Job title</label><input name="title" style="width:100%"></div>
      <div class="field"><label>Posting link</label><input name="url" type="url" style="width:100%"></div>
      <div class="row"><div class="field"><label>Status</label><select name="status">${STATUSES.map((s) => `<option>${s}</option>`).join('')}</select></div>
      <div class="field"><label>Date applied</label><input name="applied_at" type="date" value="${new Date().toISOString().slice(0, 10)}"></div></div>
      <div class="field"><label>Notes</label><textarea name="notes" rows="2"></textarea></div>`,
    async (d) => { await api('/api/applications', { method: 'POST', body: { ...d, applied_at: d.applied_at ? `${d.applied_at}T12:00:00` : undefined } }); route(); });

  const tbody = $('#apps');
  if (!tbody) return;
  tbody.onchange = async (ev) => {
    const f = ev.target.dataset.f;
    if (!f) return;
    const id = ev.target.closest('[data-id]').dataset.id;
    if (f === 'status') ev.target.style.setProperty('--c', `var(--c-${ev.target.value})`);
    try { await api(`/api/applications/${id}`, { method: 'PATCH', body: { [f]: ev.target.value } }); toast('Saved.'); } catch (e) { toast(e.message, 'error'); }
  };
  tbody.onclick = async (ev) => {
    const b = ev.target.closest('[data-act]');
    if (!b) return;
    const tr = b.closest('[data-id]');
    const app = apps.find((a) => a.id == tr.dataset.id);
    if (b.dataset.act === 'del') {
      if (!confirm(`Delete the ${app.company} application? Its emails stay in the inbox.`)) return;
      await api(`/api/applications/${app.id}`, { method: 'DELETE' });
      tr.remove();
    } else if (b.dataset.act === 'event') {
      eventForm({ application_id: app.id, title: `Interview: ${app.company}${app.title ? ' — ' + app.title : ''}` });
    }
  };
}

// ---------- inbox ----------
let inboxCat = '';
async function inbox() {
  const params = new URLSearchParams(location.hash.split('?')[1] || '');
  if (params.get('f')) inboxCat = params.get('f');
  const [emails, apps] = await Promise.all([api(`/api/emails?category=${inboxCat}`), api('/api/applications')]);
  const appFilter = params.get('app');
  const list = appFilter ? emails.filter((e) => String(e.application_id) === appFilter) : emails;
  const g = status.gmail;

  view.innerHTML = `
    <div class="page-head"><div><div class="eyebrow">Replies from Gmail</div><h1>Inbox</h1><div class="muted">${g.connected ? `${esc(g.email)} · ${g.lastSync ? `synced ${esc(ago(g.lastSync.finishedAt))}` : 'first sync in progress…'}` : 'Gmail not connected'}</div></div>
      ${g.connected ? '<button class="primary" id="sync">Check Gmail now</button>' : g.configured ? '<a class="btn primary" href="/auth/google">Connect Gmail</a>' : ''}</div>
    ${!g.configured ? '<div class="notice warn">To read your Gmail, add your Google keys to <code>.env</code> (see <b>SETUP.md</b>, step 2) and restart the app.</div>' : ''}
    ${appFilter ? `<div class="notice">Showing emails for one application. <a href="#inbox">Show all</a></div>` : ''}
    <div class="chips" style="margin-bottom:14px">
      <button class="chip ${inboxCat === '' ? 'active' : ''}" data-cat="">All job emails</button>
      ${Object.entries(CAT_LABEL).map(([k, v]) => `<button class="chip ${inboxCat === k ? 'active' : ''}" data-cat="${k}">${esc(v)}</button>`).join('')}
    </div>
    <div class="list" id="emails">${list.map((e) => `
      <div class="card email" data-id="${esc(e.id)}">
        <div class="with-logo">
          ${e.company || e.app_company ? logo(e.company || e.app_company) : logo(e.from_name, { domain: fromDomain(e.from_addr) })}
          <div class="grow">
          <div>${badge(e.category, CAT_LABEL[e.category])} <span class="subject">${esc(e.subject)}</span></div>
          <div class="muted small" style="margin:4px 0">${esc(e.from_name)} &lt;${esc(e.from_addr)}&gt;</div>
          <div>${esc(e.summary && e.summary !== e.subject ? e.summary : e.snippet)}</div>
          ${e.needs_date ? `<div class="notice small" style="margin:10px 0 0">No interview time was found in this email. Set it here:
              <span class="row" style="margin-top:6px;max-width:380px"><input type="datetime-local" data-dt value="${toLocalInput(new Date(Date.now() + 86400000))}"><button class="primary" data-act="add-event">Add to calendar</button><button data-act="no-date">Dismiss</button></span></div>` : ''}
          </div>
        </div>
        <div class="side">
          <span class="small muted">${esc(fmtDateTime(e.received_at))}</span>
          <a class="small" href="https://mail.google.com/mail/u/0/#all/${esc(e.thread_id)}" target="_blank" rel="noopener noreferrer">Open in Gmail ↗</a>
          <select data-f="category" class="small">${Object.entries(CAT_LABEL).map(([k, v]) => `<option value="${k}" ${k === e.category ? 'selected' : ''}>${esc(v)}</option>`).join('')}</select>
          <select data-f="application_id" class="small" style="max-width:200px"><option value="">— no application —</option>${apps.map((a) => `<option value="${a.id}" ${a.id === e.application_id ? 'selected' : ''}>${esc(a.company)}${a.title ? ' · ' + esc(a.title.slice(0, 30)) : ''}</option>`).join('')}</select>
        </div>
      </div>`).join('') || `<div class="card empty">${g.connected ? 'No emails in this category yet.' : 'Once Gmail is connected, job emails show up here, sorted automatically.'}</div>`}
    </div>`;

  view.querySelectorAll('[data-cat]').forEach((b) => (b.onclick = () => { inboxCat = b.dataset.cat; location.hash = 'inbox'; inbox(); }));
  const sync = $('#sync');
  if (sync) sync.onclick = () => busy(sync, async () => {
    const r = await api('/api/gmail/sync', { method: 'POST' });
    toast(`${r.processed} new emails checked${r.interviews ? `, ${r.interviews} interview(s) added to the calendar` : ''}${r.alertJobs ? `, ${r.alertJobs} jobs from alerts` : ''}.`);
    route();
  });
  const box = $('#emails');
  box.onchange = async (ev) => {
    const f = ev.target.dataset.f;
    if (!f) return;
    const id = ev.target.closest('[data-id]').dataset.id;
    try { await api(`/api/emails/${encodeURIComponent(id)}`, { method: 'PATCH', body: { [f]: ev.target.value } }); toast('Updated.'); } catch (e) { toast(e.message, 'error'); }
  };
  box.onclick = async (ev) => {
    const b = ev.target.closest('[data-act]');
    if (!b) return;
    const card = b.closest('[data-id]');
    const e = list.find((x) => x.id === card.dataset.id);
    await busy(b, async () => {
      if (b.dataset.act === 'add-event') {
        const v = $('[data-dt]', card).value;
        if (!v) throw new Error('Pick a date and time first.');
        await api('/api/events', { method: 'POST', body: {
          title: `Interview: ${e.company || e.app_company || e.from_name}`, start_at: new Date(v).toISOString(),
          application_id: e.application_id, email_id: e.id, notes: e.summary || e.subject,
        } });
        toast('Added to your calendar.');
      } else {
        await api(`/api/emails/${encodeURIComponent(e.id)}`, { method: 'PATCH', body: { needs_date: false } });
      }
      route();
    });
  };
}

// ---------- calendar ----------
let calMonth = new Date(new Date().getFullYear(), new Date().getMonth(), 1);
async function calendar() {
  const first = new Date(calMonth);
  const gridStart = new Date(first); gridStart.setDate(1 - first.getDay());
  const gridEnd = new Date(gridStart); gridEnd.setDate(gridStart.getDate() + 42);
  const events = await api(`/api/events?from=${gridStart.toISOString()}&to=${gridEnd.toISOString()}`);
  const upcoming = await api(`/api/events?from=${new Date().toISOString()}&to=9999`);
  const byDay = {};
  for (const e of events) (byDay[new Date(e.start_at).toDateString()] ??= []).push(e);

  const days = [];
  for (let i = 0; i < 42; i++) {
    const d = new Date(gridStart); d.setDate(gridStart.getDate() + i);
    const evs = byDay[d.toDateString()] || [];
    days.push(`<div class="day ${d.getMonth() !== first.getMonth() ? 'other' : ''} ${d.toDateString() === new Date().toDateString() ? 'today' : ''}" data-date="${toLocalInput(new Date(d.getFullYear(), d.getMonth(), d.getDate(), 10))}">
      <span class="n">${d.getDate()}</span>
      ${evs.map((e) => `<button class="ev" data-ev="${e.id}" title="${esc(e.title)}">${esc(fmtTime(e.start_at))} ${esc(e.title.replace(/^Interview:\s*/, ''))}</button>`).join('')}
    </div>`);
  }

  view.innerHTML = `
    <div class="page-head"><div><div class="eyebrow">Interviews</div><h1>Calendar</h1><div class="muted">Interviews found in Gmail appear here automatically. Click a day to add one.</div></div>
      <div class="toolbar" style="margin:0"><a class="btn" href="/api/calendar.ics">Export all (.ics)</a><button class="primary" id="add">Add interview</button></div></div>
    <div class="cal-head"><button id="prev">‹</button><h2>${first.toLocaleDateString(undefined, { month: 'long', year: 'numeric' })}</h2><button id="next">›</button><button id="today">Today</button></div>
    <div class="cal" id="cal">${['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((d) => `<div class="dow">${d}</div>`).join('')}${days.join('')}</div>
    <div class="card" style="margin-top:14px"><h2>Upcoming</h2>${upcoming.map((e) => `<div style="margin-bottom:8px"><b>${esc(fmtDateTime(e.start_at))}</b> — <button class="link" data-ev="${e.id}">${esc(e.title)}</button></div>`).join('') || '<div class="muted">Nothing scheduled.</div>'}</div>`;

  $('#prev').onclick = () => { calMonth.setMonth(calMonth.getMonth() - 1); calendar(); };
  $('#next').onclick = () => { calMonth.setMonth(calMonth.getMonth() + 1); calendar(); };
  $('#today').onclick = () => { calMonth = new Date(new Date().getFullYear(), new Date().getMonth(), 1); calendar(); };
  $('#add').onclick = () => eventForm({});
  const all = [...events, ...upcoming];
  view.onclick = (ev) => {
    const evBtn = ev.target.closest('[data-ev]');
    if (evBtn) return showEvent(all.find((e) => String(e.id) === evBtn.dataset.ev));
    const day = ev.target.closest('.day');
    if (day) eventForm({ start: day.dataset.date });
  };
}

function showEvent(e) {
  modal.onclose = null;
  $('#modal-body').innerHTML = `
    <h2>${esc(e.title)}</h2>
    <p><b>${esc(fmtDateTime(e.start_at))}</b>${e.end_at ? ` – ${esc(fmtTime(e.end_at))}` : ''}</p>
    ${e.location ? `<p>${/^https?:\/\//.test(e.location) ? `<a href="${safeUrl(e.location)}" target="_blank" rel="noopener noreferrer">${esc(e.location)}</a>` : esc(e.location)}</p>` : ''}
    ${e.notes ? `<p class="muted">${esc(e.notes)}</p>` : ''}
    ${e.source === 'gmail' ? '<p class="muted small">Found automatically in your email — double-check the time.</p>' : ''}
    <div class="actions"><a class="btn" href="/api/calendar.ics?id=${e.id}">Add to my calendar app (.ics)</a><button class="danger" id="del">Delete</button><button id="close">Close</button></div>`;
  modal.showModal();
  $('#close').onclick = () => modal.close();
  $('#del').onclick = async () => { await api(`/api/events/${e.id}`, { method: 'DELETE' }); modal.close(); route(); };
}

async function eventForm({ application_id = '', title = '', start }) {
  const apps = await api('/api/applications');
  const s = start ? new Date(start) : new Date(Date.now() + 86400000);
  openForm('Add interview', `
    <div class="field"><label>Title</label><input name="title" required value="${esc(title || 'Interview')}" style="width:100%"></div>
    <div class="row"><div class="field"><label>Start</label><input name="start_at" type="datetime-local" required value="${toLocalInput(s)}"></div>
    <div class="field"><label>Length</label><select name="minutes"><option value="30">30 min</option><option value="45">45 min</option><option value="60" selected>1 hour</option><option value="90">1.5 hours</option><option value="120">2 hours</option></select></div></div>
    <div class="field"><label>Application</label><select name="application_id" style="width:100%"><option value="">— none —</option>${apps.map((a) => `<option value="${a.id}" ${a.id == application_id ? 'selected' : ''}>${esc(a.company)}${a.title ? ' · ' + esc(a.title) : ''}</option>`).join('')}</select></div>
    <div class="field"><label>Where / link</label><input name="location" placeholder="Zoom link, phone, or address" style="width:100%"></div>
    <div class="field"><label>Notes</label><textarea name="notes" rows="2"></textarea></div>`,
  async (d) => {
    const start_at = new Date(d.start_at);
    await api('/api/events', { method: 'POST', body: {
      ...d, start_at: start_at.toISOString(), end_at: new Date(start_at.getTime() + Number(d.minutes) * 60000).toISOString(),
      application_id: d.application_id ? Number(d.application_id) : null,
    } });
    toast('Interview added.');
    route();
  });
}

function openForm(heading, fieldsHtml, onSubmit) {
  $('#modal-body').innerHTML = `<form method="dialog"><h2>${esc(heading)}</h2>${fieldsHtml}
    <div class="actions"><button class="primary" type="submit">Save</button><button type="button" id="cancel">Cancel</button></div></form>`;
  modal.showModal();
  const form = $('#modal-body form');
  $('#cancel').onclick = () => modal.close();
  form.onsubmit = async (ev) => {
    ev.preventDefault();
    const btn = form.querySelector('[type=submit]');
    await busy(btn, async () => { await onSubmit(Object.fromEntries(new FormData(form))); modal.close(); });
  };
}

// ---------- chip editor (add/remove keyword chips; stores a comma list in a hidden input) ----------
function chipEditor(name, values, placeholder, { muted = false } = {}) {
  return `<div class="chip-editor ${muted ? 'muted-chips' : ''}">
    ${values.map((v) => `<span class="tag">${esc(v)}<button type="button" aria-label="Remove ${esc(v)}">×</button></span>`).join('')}
    <input type="text" placeholder="${esc(placeholder)}" aria-label="${esc(placeholder)}">
    <input type="hidden" name="${name}" value="${esc(values.join(', '))}">
  </div>`;
}
function initChipEditors(rootEl) {
  rootEl.querySelectorAll('.chip-editor').forEach((ed) => {
    const hidden = ed.querySelector('input[type=hidden]');
    const text = ed.querySelector('input[type=text]');
    const chips = () => [...ed.querySelectorAll('.tag')];
    const sync = () => { hidden.value = chips().map((t) => t.firstChild.textContent).join(', '); };
    const add = (raw) => {
      raw.split(',').map((x) => x.trim()).filter(Boolean).forEach((val) => {
        if (chips().some((t) => t.firstChild.textContent.toLowerCase() === val.toLowerCase())) return;
        const t = document.createElement('span');
        t.className = 'tag';
        t.append(val);
        const b = document.createElement('button');
        b.type = 'button'; b.textContent = '×'; b.setAttribute('aria-label', `Remove ${val}`);
        t.append(b);
        ed.insertBefore(t, text);
      });
      sync();
    };
    ed.onclick = (e) => { const b = e.target.closest('.tag button'); if (b) { b.parentElement.remove(); sync(); } else text.focus(); };
    text.onkeydown = (e) => {
      if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); add(text.value); text.value = ''; }
      else if (e.key === 'Backspace' && !text.value) { const last = chips().pop(); if (last) { last.remove(); sync(); } }
    };
    text.onblur = () => { if (text.value.trim()) { add(text.value); text.value = ''; } };
  });
}

// ---------- profile ----------
async function profile() {
  const p = await api('/api/profile');
  const input = (name, label, attrs = '', cls = '') => `<div class="field ${cls}"><label>${esc(label)}</label><input name="${name}" value="${esc(p[name])}" ${attrs}></div>`;
  const choice = (name, label, opts, cls = '') => `<div class="field ${cls}"><label>${esc(label)}</label><select name="${name}">${opts.map((o) => `<option ${o === p[name] ? 'selected' : ''}>${esc(o)}</option>`).join('')}${opts.includes(p[name]) || !p[name] ? '' : `<option selected>${esc(p[name])}</option>`}</select></div>`;
  view.innerHTML = `
    <div class="page-head"><div><div class="eyebrow">Used for auto-fill</div><h1>My profile</h1><div class="muted">Stored only on this PC. Sent to Claude only while filling in an application.</div></div>
      <button class="primary" type="submit" form="pform">Save profile</button></div>
    <form id="pform" class="stack">
      <div class="card">
        <div class="card-head"><div><div class="eyebrow">Step 1</div><h2>Contact details</h2></div></div>
        <div class="form-grid">
          ${input('firstName', 'First name', 'required')}${input('lastName', 'Last name', 'required')}${input('email', 'Email', 'type="email" required')}
          ${input('phone', 'Phone', 'type="tel"')}${input('city', 'City')}${input('state', 'State')}
          ${input('zip', 'ZIP code')}${input('country', 'Country')}<div></div>
          ${input('linkedin', 'LinkedIn URL', 'type="url" placeholder="https://linkedin.com/in/…"', 'span-2')}${input('website', 'Website / portfolio', 'type="url"')}
        </div>
      </div>
      <div class="card">
        <div class="card-head"><div><div class="eyebrow">Step 2</div><h2>Common application questions</h2></div><span class="muted small">Answers Claude uses when a form asks</span></div>
        <div class="form-grid">
          ${choice('workAuthorization', 'Work authorization', ['Authorized to work in the US for any employer', 'US citizen', 'Green card holder', 'Need visa sponsorship now or in the future'], 'span-2')}
          ${choice('needsSponsorship', 'Need visa sponsorship?', ['No', 'Yes'])}
          ${choice('willingToRelocate', 'Willing to relocate?', ['No', 'Yes', 'Depends on the role'])}
          ${input('desiredSalary', 'Desired pay', 'placeholder="e.g. $20/hr or $45,000"')}${input('startDate', 'Can start')}
          ${input('currentTitle', 'Current / latest job title')}${input('yearsExperience', 'Years of experience')}${input('education', 'Highest education')}
          ${choice('eeo', 'Voluntary demographic questions', ['Decline to self-identify', 'Answer from my notes below'], 'span-3')}
          <div class="field span-3"><label>Anything else Claude should know</label><textarea name="extraInfo" rows="3" placeholder="e.g. Prefer remote. Bilingual English/Spanish. Available evenings for interviews.">${esc(p.extraInfo)}</textarea></div>
        </div>
      </div>
      <div class="card">
        <div class="card-head"><div><div class="eyebrow">Step 3</div><h2>Resume</h2></div>${p.hasResume ? '<span class="tag green">✓ Resume on file</span>' : '<span class="tag amber">No resume yet</span>'}</div>
        <div class="dropzone">
          <svg class="ic"><use href="#i-upload"/></svg>
          <div class="grow" style="flex:1;min-width:200px"><b>Upload your resume (PDF)</b><div class="muted small">It’s attached to applications, and Claude uses its text for cover letters and answers.</div></div>
          <input type="file" id="resume" accept="application/pdf">
          <button type="button" id="upload">Upload</button>
          ${p.hasResume ? '<a class="btn ghost" href="/api/profile/resume" target="_blank">View current</a>' : ''}
        </div>
        <div class="field" style="margin-top:16px"><label>Resume text <span class="muted small" style="font-weight:400">(filled in from the PDF; you can edit it)</span></label>
          <textarea name="resumeText" rows="12">${esc(p.resumeText)}</textarea></div>
        <button class="primary" type="submit">Save profile</button>
      </div>
    </form>`;

  $('#pform').onsubmit = async (ev) => {
    ev.preventDefault();
    await busy(ev.submitter, async () => {
      await api('/api/profile', { method: 'PUT', body: Object.fromEntries(new FormData(ev.target)) });
      toast('Profile saved.');
    });
  };
  $('#upload').onclick = (ev) => busy(ev.target, async () => {
    const file = $('#resume').files[0];
    if (!file) throw new Error('Choose your resume PDF first.');
    await api('/api/profile', { method: 'PUT', body: Object.fromEntries(new FormData($('#pform'))) }); // keep unsaved edits
    const res = await fetch('/api/profile/resume', { method: 'POST', headers: { 'Content-Type': 'application/pdf', 'X-JobHunt': '1' }, body: file });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Upload failed');
    toast(data.extracted ? 'Resume uploaded and read.' : 'Resume uploaded. Paste its text below so Claude can use it.');
    profile();
  });
}

// ---------- settings ----------
async function settings() {
  const s = await api('/api/settings');
  const g = status.gmail;
  const SRC = {
    weworkremotely: ['We Work Remotely', 'Remote + anywhere jobs'], himalayas: ['Himalayas', 'Remote jobs, salary shown'], remotive: ['Remotive', 'Remote, tech-leaning'],
    remoteok: ['RemoteOK', 'Needs an account to apply'], arbeitnow: ['Arbeitnow', 'Europe + remote'], greenhouse: ['Greenhouse', 'Company boards · auto-fill'],
    lever: ['Lever', 'Company boards · auto-fill'], ashby: ['Ashby', 'Company boards · auto-fill'], adzuna: ['Adzuna', status.adzuna ? 'All job types' : 'Needs free key in .env'],
  };
  view.innerHTML = `
    <div class="page-head"><div><div class="eyebrow">Preferences</div><h1>Settings</h1><div class="muted">What to search for, where, and how often.</div></div>
      <button class="primary" type="submit" form="sform">Save settings</button></div>
    <div class="grid" style="grid-template-columns:minmax(0,2fr) minmax(260px,1fr);align-items:start">
      <form id="sform" class="stack">
        <div class="card">
          <div class="card-head"><div><div class="eyebrow">Search</div><h2>What jobs to look for</h2></div></div>
          <div class="field"><label>Keywords</label>${chipEditor('keywords', s.keywords, 'Add a job title or skill, then press Enter')}
            <div class="hint">Jobs rank highest when a keyword is in the job title.</div></div>
          <div class="field"><label>Skip jobs whose title contains</label>${chipEditor('excludeKeywords', s.excludeKeywords, 'e.g. senior, manager', { muted: true })}</div>
          <div class="form-grid" style="align-items:end">
            <div class="field"><label>Preferred location</label><input name="location" value="${esc(s.location)}" placeholder="e.g. Austin, TX"></div>
            <div class="field"><label class="switch"><input type="checkbox" name="remoteOnly" ${s.remoteOnly ? 'checked' : ''}> Remote only</label></div>
            <div class="field"><label class="switch"><input type="checkbox" name="anywhereOnly" ${s.anywhereOnly ? 'checked' : ''}> Work from anywhere only</label></div>
          </div>
        </div>
        <div class="card">
          <div class="card-head"><div><div class="eyebrow">Sources</div><h2>Job boards</h2></div><a href="#boards" class="small">See all boards →</a></div>
          <div class="switch-grid">${Object.entries(SRC).map(([k, [name, sub]]) => `<label class="switch"><input type="checkbox" name="src_${k}" ${s.sources[k] ? 'checked' : ''}><span>${esc(name)}<small>${esc(sub)}</small></span></label>`).join('')}</div>
        </div>
        <div class="card">
          <div class="card-head"><div><div class="eyebrow">Straight from employers</div><h2>Company boards</h2></div></div>
          <div class="field"><label>Greenhouse companies</label>${chipEditor('greenhouseCompanies', s.greenhouseCompanies, 'Add a company, e.g. gitlab')}<div class="hint">The name in the job page link: boards.greenhouse.io/<b>gitlab</b></div></div>
          <div class="field"><label>Lever companies</label>${chipEditor('leverCompanies', s.leverCompanies, 'Add a company')}<div class="hint">From jobs.lever.co/<b>company</b></div></div>
          <div class="field"><label>Ashby companies</label>${chipEditor('ashbyCompanies', s.ashbyCompanies || [], 'Add a company, e.g. zapier')}<div class="hint">From jobs.ashbyhq.com/<b>company</b></div></div>
        </div>
        <div class="card">
          <div class="card-head"><div><div class="eyebrow">Automation</div><h2>Schedule</h2></div></div>
          <div class="form-grid">
            <div class="field"><label>Check job boards every</label><select name="fetchIntervalHours">${[1, 3, 6, 12, 24].map((h) => `<option value="${h}" ${h === s.fetchIntervalHours ? 'selected' : ''}>${h} hour${h > 1 ? 's' : ''}</option>`).join('')}</select></div>
            <div class="field"><label>Check Gmail every</label><select name="gmailIntervalMinutes">${[5, 15, 30, 60].map((m) => `<option value="${m}" ${m === s.gmailIntervalMinutes ? 'selected' : ''}>${m} minutes</option>`).join('')}</select></div>
            <div class="field"><label>First Gmail sync looks back</label><select name="gmailLookbackDays">${[7, 14, 30, 60, 90].map((d) => `<option value="${d}" ${d === s.gmailLookbackDays ? 'selected' : ''}>${d} days</option>`).join('')}</select></div>
          </div>
          <button class="primary" type="submit">Save settings</button>
        </div>
      </form>
      <div class="stack">
        <div class="card"><div class="eyebrow">Connection</div><h2>Gmail</h2>
          ${g.connected ? `<p><span class="dot on"></span>Connected as <b>${esc(g.email)}</b> (read-only access).</p><button class="danger" id="disc">Disconnect Gmail</button>`
            : g.configured ? `<p>Ready to connect. Google will ask you to allow <b>read-only</b> access to your email.</p><a class="btn primary" href="/auth/google">Connect Gmail</a>`
            : `<p class="muted">Add <code>GOOGLE_CLIENT_ID</code> and <code>GOOGLE_CLIENT_SECRET</code> to your <code>.env</code> file (see SETUP.md, step 2), then restart the app.</p>`}
        </div>
        <div class="card"><div class="eyebrow">Connection</div><h2>Claude AI</h2>
          ${status.claude ? '<p><span class="dot on"></span>On. Emails are sorted by Claude, interview times are pulled out automatically, and job-alert emails become job leads.</p>'
            : '<p class="muted">Off. Add <code>ANTHROPIC_API_KEY</code> to <code>.env</code> and restart to turn on smarter email sorting, automatic interview times, and job-alert parsing.</p>'}
        </div>
      </div>
    </div>`;

  initChipEditors(view);
  $('#sform').onsubmit = async (ev) => {
    ev.preventDefault();
    view.querySelectorAll('.chip-editor input[type=text]').forEach((t) => t.blur()); // keep any half-typed chip
    const f = new FormData(ev.target);
    const body = {
      keywords: f.get('keywords'), excludeKeywords: f.get('excludeKeywords'), location: f.get('location'),
      remoteOnly: f.has('remoteOnly'), anywhereOnly: f.has('anywhereOnly'), greenhouseCompanies: f.get('greenhouseCompanies'), leverCompanies: f.get('leverCompanies'), ashbyCompanies: f.get('ashbyCompanies'),
      fetchIntervalHours: f.get('fetchIntervalHours'), gmailIntervalMinutes: f.get('gmailIntervalMinutes'), gmailLookbackDays: f.get('gmailLookbackDays'),
      sources: Object.fromEntries(Object.keys(SRC).map((k) => [k, f.has(`src_${k}`)])),
    };
    await busy(ev.submitter, async () => { await api('/api/settings', { method: 'PUT', body }); toast('Settings saved. Click "Check job boards now" on Job leads to search with them.'); });
  };
  const disc = $('#disc');
  if (disc) disc.onclick = async () => {
    if (!confirm('Disconnect Gmail? Emails already imported stay in the app.')) return;
    await api('/api/gmail/disconnect', { method: 'POST' });
    route();
  };
}
