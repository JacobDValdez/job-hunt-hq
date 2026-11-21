const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'" };

export function decodeEntities(s = '') {
  return s.replace(/&(#x?[0-9a-f]+|[a-z]+|#39);/gi, (m, code) => {
    if (code[0] === '#') {
      const n = code[1].toLowerCase() === 'x' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return Number.isFinite(n) ? String.fromCodePoint(n) : m;
    }
    return ENTITIES[code.toLowerCase()] ?? m;
  });
}

/** Turn HTML into readable plain text. */
export function htmlToText(html = '') {
  let s = decodeEntities(String(html)); // some APIs double-escape their HTML
  s = s
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h[1-6]|tr)>/gi, '\n')
    .replace(/<li[^>]*>/gi, '• ')
    .replace(/<[^>]+>/g, ' ');
  return decodeEntities(s).replace(/[ \t ]+/g, ' ').replace(/\n\s*\n\s*/g, '\n\n').trim();
}

export async function fetchJson(url, options = {}) {
  const res = await fetch(url, {
    ...options,
    headers: { 'User-Agent': 'JobHuntHQ/1.0 (personal job search tool)', Accept: 'application/json', ...(options.headers || {}) },
    signal: AbortSignal.timeout(options.timeoutMs ?? 20000),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`HTTP ${res.status} from ${new URL(url).host}: ${body.slice(0, 200)}`);
  }
  return res.json();
}

export async function fetchText(url, options = {}) {
  const res = await fetch(url, {
    headers: { 'User-Agent': 'JobHuntHQ/1.0 (personal job search tool)', ...(options.headers || {}) },
    signal: AbortSignal.timeout(options.timeoutMs ?? 30000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${new URL(url).host}`);
  return res.text();
}

/** Minimal RSS reader: returns each <item> as an object of its child tags (CDATA and entities decoded). */
export function parseRss(xml) {
  const items = [];
  for (const m of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
    const item = {};
    for (const t of m[1].matchAll(/<([a-zA-Z:]+)(?:\s[^>]*)?>([\s\S]*?)<\/\1>/g)) {
      const raw = t[2].trim().replace(/^<!\[CDATA\[([\s\S]*)\]\]>$/, '$1');
      item[t[1]] = decodeEntities(raw);
    }
    items.push(item);
  }
  return items;
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function toIso(value) {
  if (value == null || value === '') return null;
  const d = typeof value === 'number' ? new Date(value < 1e12 ? value * 1000 : value) : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}
