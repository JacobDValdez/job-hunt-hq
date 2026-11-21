# Job Hunt HQ

**I ran my job search like a sales pipeline, and built the CRM for it.**

Job Hunt HQ is a personal job-search assistant that runs on my own computer. It finds job leads, tracks every application from "applied" to "offer", reads company replies in Gmail, and puts interviews on a calendar, so nothing falls through the cracks.

I built it with **Claude Code** (AI-assisted development) while job hunting for remote inbound sales and customer success roles. I directed the build step by step, tested it on real job boards, emails and application forms, and used it every day.

---

## What it does

| | |
|---|---|
| **Finds leads** | Pulls openings from 8+ sources: We Work Remotely, Himalayas, RemoteOK, Remotive, Arbeitnow, Adzuna, and company hiring pages on Greenhouse, Lever and Ashby. Filters by keywords, location and "work from anywhere". |
| **Tracks the pipeline** | Every job moves through clear stages (new lead → saved → applied → interview → offer or rejected), like deals in a CRM. |
| **Reads replies for me** | Connects to Gmail (read-only) and sorts job emails into Interview, Rejection, Offer, Recruiter, Confirmation and Job alert, then updates the matching application automatically. |
| **Books interviews** | Pulls interview times out of emails onto a calendar, with one-click export to Google Calendar, Outlook or Apple Calendar. |
| **Pre-fills applications** | Opens the real application form, fills in my details, uploads my resume and drafts a cover letter for that job. **It never clicks Submit.** I review every answer and submit myself. |
| **Scores the fit** | Compares my resume to each job description and shows a match percentage and the missing skills, with a plain-English explanation of how applicant tracking systems (ATS) work. |

## Results from my own search

- **1,000+** job leads collected across job boards and company hiring pages
- **400+** job emails sorted automatically, for about **$0.33 total** in AI costs (under $1/month going forward)
- **50** applications tracked with no manual data entry
- **390+** leads scored against my resume. Rewording my real experience in employers' language raised my skill match from about 30% to 60%.

## Decisions I'm proud of

- **Privacy first.** Everything is stored on my own computer. Gmail access is read-only. Keys and personal data never leave the machine and aren't part of this repository.
- **A human approves before anything ships.** Auto-fill stops before Submit, and never ticks "I agree" boxes or fills in passwords, Social Security numbers or dates of birth. Sites that forbid automation (LinkedIn, Indeed, Glassdoor, ZipRecruiter) only get an "Open posting" link.
- **Costs near zero.** Free keyword rules screen emails first, so only real job emails reach the AI. Skill matching uses no AI at all.
- **Explains the "why".** Wherever the app suggests a change, it says why in plain English, so a non-technical job seeker can trust it.

## How it's built

- **Node.js + Express** for the local web app, **SQLite** (built into Node) for storage
- **Gmail API** with Google OAuth 2.0, read-only
- **Claude API** (Anthropic) for sorting emails, reading interview times and job-alert emails, and drafting cover letters
- **Playwright** for filling in application forms in a real browser window
- Plain **HTML, CSS and JavaScript** for the interface, with no framework

Built with Claude Code: I planned the features, made the product and design decisions, tested every flow, and directed the fixes. Claude wrote most of the code.

## Run it yourself

You need Node.js 22.5 or newer.

```powershell
npm install
npm start
```

Then open http://localhost:3000. Job leads work right away. Gmail, Claude and Adzuna are optional and need your own keys: copy `.env.example` to `.env` and follow [SETUP.md](SETUP.md).

---

**Jacob Valdez**: inbound sales and customer success professional (5 years at Best Buy, 4 fully remote) who builds websites and AI automations.
[LinkedIn](https://www.linkedin.com/in/jacobdv323) · [GitHub](https://github.com/JacobDValdez) · [Another project: a retro game store demo](https://jacobdvaldez.github.io/1up-photo-to-listing-demo/)
