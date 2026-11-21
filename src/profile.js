// Your applicant profile and resume, stored only on this PC (data/ folder).
import fs from 'node:fs';
import path from 'node:path';
import Anthropic from '@anthropic-ai/sdk';
import { DATA_DIR, getMeta, setMeta } from './db.js';

export const RESUME_FILE = path.join(DATA_DIR, 'resume.pdf');

export const PROFILE_FIELDS = {
  firstName: '', lastName: '', email: '', phone: '',
  city: '', state: '', country: 'United States', zip: '',
  linkedin: '', website: '',
  workAuthorization: 'Authorized to work in the US for any employer',
  needsSponsorship: 'No',
  willingToRelocate: 'No',
  desiredSalary: '',
  startDate: 'Two weeks after offer',
  yearsExperience: '',
  currentTitle: '',
  education: '',
  eeo: 'Decline to self-identify', // used for voluntary gender/race/veteran/disability questions
  extraInfo: '',                   // anything else Claude should know when answering questions
  resumeText: '',
};

export function getProfile() {
  return { ...PROFILE_FIELDS, ...(getMeta('profile') || {}), hasResume: fs.existsSync(RESUME_FILE) };
}

export function saveProfile(input) {
  const clean = {};
  for (const k of Object.keys(PROFILE_FIELDS)) {
    if (k in input) clean[k] = String(input[k] ?? '').slice(0, k === 'resumeText' || k === 'extraInfo' ? 20000 : 300).trim();
  }
  setMeta('profile', { ...(getMeta('profile') || {}), ...clean });
  return getProfile();
}

/** Saves the uploaded PDF and, if Claude is on, turns it into plain text once (reused for every application). */
export async function saveResume(buf) {
  if (buf.subarray(0, 5).toString() !== '%PDF-') throw new Error('Please upload your resume as a PDF file.');
  fs.writeFileSync(RESUME_FILE, buf);
  if (!process.env.ANTHROPIC_API_KEY) return { profile: getProfile(), extracted: false };

  const client = new Anthropic();
  const model = process.env.CLAUDE_MODEL || 'claude-opus-5-5';
  const response = await client.messages.create({
    model,
    max_tokens: 8000,
    ...(/haiku/.test(model) ? { thinking: { type: 'disabled' } } : {}),
    output_config: { effort: 'low' },
    messages: [{
      role: 'user',
      content: [
        { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: buf.toString('base64') } },
        { type: 'text', text: 'Copy the full text of this resume as plain text, keeping its sections and bullet points. Output only the resume text.' },
      ],
    }],
  });
  const text = response.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
  return { profile: saveProfile({ resumeText: text }), extracted: Boolean(text) };
}
