// Free, instant skill matching between your resume and job descriptions (no AI calls, no cost).
// Each skill has a display name and the phrases that count as mentioning it.
const SKILLS = [
  // sales
  ['Prospecting', ['prospect(ing|s)?\\b']],
  ['Cold calling', ['cold[- ]call(ing|s)?', 'outbound call(s|ing)?']],
  ['Lead generation', ['lead gen(eration)?', 'generat(e|ing) leads', 'pipeline generation']],
  ['Lead qualification', ['qualif(y|ying|ication|ied) (leads|prospects|callers|opportunities)', 'lead qualification', '\\bBANT\\b', 'qualified (leads|meetings|opportunities)']],
  ['Appointment setting', ['appointment[- ]setting', 'book(ing|ed)? (meetings|appointments|demos)', 'set(ting)? (meetings|appointments)', 'schedul(e|ing) (meetings|demos)']],
  ['Pipeline management', ['pipeline (management|hygiene)', 'manag(e|ing) (a |your )?pipeline', 'follow[- ]up pipeline', 'sales pipeline']],
  ['Quota attainment', ['\\bquotas?\\b', 'sales targets?', 'revenue targets?']],
  ['Objection handling', ['objection(s| handling)']],
  ['Consultative selling', ['consultative (selling|sales|approach)', 'needs (assessment|analysis|discovery)', 'discovery calls?']],
  ['Upselling & cross-selling', ['upsell(ing|s)?', 'cross[- ]sell(ing|s)?', 'expansion revenue']],
  ['Closing deals', ['clos(e|ing) (deals|sales|business)', '\\bclosing\\b']],
  ['Negotiation', ['negotiat(e|ion|ing)']],
  ['B2B sales', ['\\bB2B\\b', 'business[- ]to[- ]business']],
  ['SaaS sales', ['\\bSaaS\\b']],
  ['Inbound sales', ['inbound (sales|calls|leads)']],
  ['Account management', ['account management', 'manag(e|ing) (a book of|client|customer) accounts', 'book of business']],
  ['Product demos', ['product demo(s|nstrations?)?', '(run|running|deliver|delivering|give|giving|conduct|conducting) (product )?demos', 'product presentations?']],
  // tools
  ['CRM', ['\\bCRMs?\\b']],
  ['Salesforce', ['salesforce']],
  ['HubSpot', ['hubspot']],
  ['Zendesk', ['zendesk']],
  ['Gong / Outreach / Salesloft', ['\\bgong\\b', 'outreach\\.io', 'salesloft', 'apollo\\.io', '\\bapollo\\b']],
  ['LinkedIn Sales Navigator', ['sales navigator']],
  ['Microsoft Excel', ['\\bexcel\\b', 'spreadsheets?']],
  ['Microsoft Office / Google Workspace', ['microsoft office', '\\bMS office\\b', 'office 365', 'google (workspace|suite|docs|sheets)', '\\bG ?Suite\\b']],
  ['Phone systems', ['phone system', 'telephone system', '\\bVoIP\\b', '\\bcisco\\b', 'dialer', 'call center software']],
  ['POS / payments', ['point[- ]of[- ]sale', '\\bPOS\\b', 'payment links?', 'process(ing)? payments']],
  // customer service / success
  ['Customer service', ['customer service', 'customer support', 'client support', 'support calls', 'customer[- ]facing', 'advis(e|ed|ing) customers', 'assist(ed|ing)? customers']],
  ['Customer success', ['customer success', 'client success']],
  ['Customer onboarding', ['onboard(ing)? (customers|clients|new)', 'customer onboarding', '\\bonboarding\\b']],
  ['Retention & renewals', ['retention', 'renewals?', 'churn']],
  ['Troubleshooting', ['troubleshoot(ing)?']],
  ['Ticketing / live chat', ['ticket(s|ing)?\\b', 'live chat', 'chat support', 'help ?desk']],
  ['CSAT / NPS', ['\\bCSAT\\b', '\\bNPS\\b', 'customer satisfaction']],
  ['Repeat customers / relationships', ['repeat (business|customers)', 'relationship[- ]building', 'build(ing)? (strong )?relationships']],
  // soft skills & ways of working
  ['Communication', ['communication skills', 'communicat(e|or|ion)', 'written and verbal', 'verbal and written']],
  ['Time management', ['time management', 'manag(e|ing) (your|their|my) time', 'prioriti[sz](e|ing|ation)']],
  ['Organization', ['organi[sz]ed', 'organi[sz]ation(al)? skills', 'detail[- ]oriented', 'attention to detail']],
  ['Adaptability', ['adaptab(le|ility)', 'fast[- ]paced', 'flexib(le|ility)']],
  ['Cross-functional collaboration', ['cross[- ]functional', 'collaborat(e|ion|ive)', 'teamwork', 'team player']],
  ['Self-motivated / remote work', ['self[- ](motivated|starter|directed)', 'work(ing)? independently', 'remote (work|environment|experience)', 'fully remote']],
  ['Problem solving', ['problem[- ]solv(ing|er)', 'solve problems']],
  ['Leadership', ['leadership', '\\blead (a|the) team', 'team lead']],
  ['Coaching & mentoring', ['coach(ing)?\\b', 'mentor(ing|ship)?', 'train(ing)? (new hires|others|team)']],
  ['Stakeholder management', ['stakeholders?']],
  ['KPIs & metrics', ['\\bKPIs?\\b', 'metrics', 'data[- ]driven', 'reporting']],
  ['Bilingual (Spanish)', ['bilingual', 'spanish']],
  // web, content & AI
  ['Website design', ['web(site)? design', 'landing pages?', 'website builders?', 'build(ing)? websites']],
  ['HTML / CSS', ['\\bHTML\\b', '\\bCSS\\b']],
  ['JavaScript', ['javascript', '\\bJS\\b', 'react\\b', 'node\\.?js']],
  ['WordPress / Webflow / Shopify', ['wordpress', 'webflow', 'shopify', 'wix\\b', 'squarespace']],
  ['SEO', ['\\bSEO\\b', 'search engine optimi[sz]ation']],
  ['Copywriting', ['copywriting', 'copy ?writer', 'writing (emails|copy)']],
  ['Social media', ['social media', 'instagram', 'tiktok', 'linkedin posts?', 'live[- ]?(selling|stream)']],
  ['Content creation', ['content creation', 'create content', 'video editing', 'content creator']],
  ['AI tools & prompting', ['AI tools', 'AI[- ](assisted|powered) (tools|development|workflows)', 'generative AI', 'chatgpt', '\\bLLMs?\\b', 'prompt(ing| engineering| writing)', '\\bclaude\\b', 'gemini', 'copilot', 'using AI', 'AI prompting']],
  ['Workflow automation', ['workflow automation', 'automat(e|ing) (workflows|tasks|processes)', 'zapier', '\\bmake\\.com\\b', '\\bn8n\\b', 'no[- ]code', 'automation tools']],
  ['Python', ['python']],
  ['APIs & integrations', ['\\bAPIs?\\b', 'integrations?']],
  ['GitHub / Git', ['github', '\\bgit\\b']],
].map(([name, pats]) => ({ name, re: new RegExp(`(?:${pats.join('|')})`, 'i') }));

export const SKILL_NAMES = SKILLS.map((s) => s.name);

/** Names of skills mentioned in a piece of text. */
export function extractSkills(text = '') {
  const t = String(text);
  return SKILLS.filter((s) => s.re.test(t)).map((s) => s.name);
}

/**
 * How well a job fits your resume: % of the skills the job mentions that your resume shows.
 * Returns null when the posting names too few skills to judge.
 */
export function matchJob(job, resumeSkills) {
  const need = extractSkills(`${job.title || ''}\n${job.tags || ''}\n${job.description || ''}`);
  if (need.length < 3) return null;
  const have = need.filter((s) => resumeSkills.has(s));
  const gaps = need.filter((s) => !resumeSkills.has(s));
  return { pct: Math.round((have.length / need.length) * 100), have, gaps, total: need.length };
}

/** Across many jobs: which skills come up most, and which of them your resume shows. */
export function skillDemand(jobs, resumeSkills) {
  const counts = new Map();
  let scored = 0;
  for (const j of jobs) {
    const need = new Set(extractSkills(`${j.title || ''}\n${j.tags || ''}\n${j.description || ''}`));
    if (need.size < 3) continue;
    scored++;
    for (const s of need) counts.set(s, (counts.get(s) || 0) + 1);
  }
  const rows = [...counts.entries()]
    .map(([name, n]) => ({ name, pct: Math.round((n / Math.max(scored, 1)) * 100), have: resumeSkills.has(name) }))
    .sort((a, b) => b.pct - a.pct);
  return { jobsAnalyzed: scored, rows };
}
