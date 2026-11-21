# Job Hunt HQ: setup guide

Job Hunt HQ runs on your own PC. Your data is stored in the `data` folder next to this file and isn't uploaded anywhere.

## 1. Start the app

Double-click **`Start Job Hunt HQ.bat`**. A black window opens; leave it open while you use the app. Your browser opens at http://localhost:3000.

You can also start it from a terminal in this folder:

```powershell
npm start
```

Job leads work right away with no setup. The app checks Remotive, Arbeitnow, RemoteOK, and a few company job boards on Greenhouse and Lever. Open **Settings** to set your keywords, location and companies, then click **Check job boards now** on the Job leads page.

To change keys later: copy `.env.example` to a new file named `.env` in this folder, fill in the values, and restart the app.

## 2. Connect Gmail (about 10 minutes, one time)

Google requires you to create your own free "app" before a program can read your Gmail. The app only asks for **read-only** access: it can't send, delete or change any email.

1. Go to https://console.cloud.google.com and sign in with the Gmail account you use for job hunting.
2. At the top, click the project picker → **New project** → name it `Job Hunt HQ` → **Create**. Make sure it's selected.
3. Search for **Gmail API** in the top search bar → open it → **Enable**.
4. Go to **APIs & Services → OAuth consent screen** (it may be called **Google Auth Platform**) → **Get started**.
   - App name: `Job Hunt HQ`, support email: your email.
   - Audience: **External**.
   - Contact email: your email → **Create**.
5. Under **Audience** (or "Test users"), click **Add users** and add your own Gmail address.
6. Go to **Clients** (or **Credentials → Create credentials → OAuth client ID**):
   - Application type: **Web application**
   - Authorized redirect URI: `http://localhost:3000/auth/google/callback`
   - Click **Create**.
7. Copy the **Client ID** and **Client secret** into your `.env` file:
   ```
   GOOGLE_CLIENT_ID=xxxxxxxx.apps.googleusercontent.com
   GOOGLE_CLIENT_SECRET=xxxxxxxx
   ```
8. Restart the app, open **Settings → Connect Gmail**, and approve. Google will warn that the app "hasn't been verified". That's expected, because it's your own app: click **Continue**.

> **Heads-up:** While your Google app is in "Testing" mode, Google makes you sign in again about **every 7 days**. If Gmail stops syncing, click **Connect Gmail** again in Settings.

After connecting, the app checks your inbox every 15 minutes. You can change that in Settings. Here's what it does with your email:
- Finds replies from companies and sorts them into Interview, Rejection, Offer, Recruiter, Application confirmation and Job alert.
- Updates the status of the matching application automatically.
- Adds an application by itself when it sees a "thanks for applying" email for a company you haven't tracked yet.
- Puts interviews on the **Calendar** when the email gives a time. When it doesn't, the email is flagged in the Inbox so you can set the time yourself.

## 3. Turn on Claude AI (recommended)

Without Claude, the app sorts emails with simple keyword rules and **cannot** read interview times or job-alert emails.

1. Create an API key at https://console.anthropic.com → **API Keys**.
2. Add it to `.env`:
   ```
   ANTHROPIC_API_KEY=sk-ant-...
   ```
3. Restart the app.

**Cost:** Claude reads each new job-related email once. With the default model (Claude Opus 5.5) a typical email costs about 1–3 cents. To spend much less, add `CLAUDE_MODEL=claude-haiku-5-5` to `.env`. That model is cheaper but slightly less accurate.

## 4. More job boards (optional)

These boards are connected and need no setup: **We Work Remotely, Himalayas, RemoteOK, Remotive**, plus company hiring boards on **Greenhouse** (e.g. GitLab), **Lever** and **Ashby** (e.g. Zapier, Buffer). The **Where to look** page shows each board, how many new leads it found, and lets you turn it on or off. FlexJobs (paid) and Remote.co (blocks automated access) appear there as links only. On Job leads, choose **Work from anywhere** to see only roles with no location requirement.

- **Adzuna** covers jobs of every kind, not just tech or remote, in many countries. Get a free key at https://developer.adzuna.com and fill in `ADZUNA_APP_ID`, `ADZUNA_APP_KEY` and `ADZUNA_COUNTRY` in `.env`.
- **Specific companies**: In Settings, add companies that post jobs on Greenhouse (`boards.greenhouse.io/<name>`) or Lever (`jobs.lever.co/<name>`).
- **LinkedIn / Indeed**: Turn on job alerts on those sites so they email you. With Claude turned on, the app pulls the jobs out of those alert emails and adds them to Job leads.

## 5. Auto-fill applications

1. Open **My profile**. Fill in your contact details and the common questions, upload your resume as a PDF, then click **Save profile**. Claude reads the resume once and keeps a text copy that you can edit.
2. On **Job leads**, click **✨ Auto-fill application** on a job. An Edge window opens on the application form, and the app fills it in:
   - **Green outline** = filled in by the app (contact info, resume upload, a cover letter written for that job, dropdown answers, short answers based on your resume).
   - **Orange outline** = a required field the app couldn't answer from your profile. You fill these in.
3. **Check every answer, then click the site's Submit button yourself.** The app never submits for you. It also never ticks "I agree / I certify" boxes, and it never fills in passwords, Social Security numbers or your date of birth.
4. Back in the app, click **I submitted it**. The job moves to Applications, with the cover letter saved in its notes, and replies are tracked from Gmail as usual.

Notes:
- Works best on **Greenhouse, Lever and Ashby** forms, which most tech and startup jobs use. Sites that need an account (like Workday) open for you to finish by hand.
- **LinkedIn, Indeed, Glassdoor and ZipRecruiter don't allow automated applications**, so those jobs only have "Open posting".
- Each auto-fill costs about $0.001 with the Haiku model. Cover letters are saved in `data/cover-letters/`.

## Adding interviews to your phone or Google Calendar

On the Calendar page, click an interview → **Add to my calendar app (.ics)**, or click **Export all (.ics)**. Open the downloaded file, or import it in Google Calendar (Settings → Import).

## Where things are stored

- `data/jobhunt.db`: all jobs, applications, emails and interviews
- `data/google-token.json`: your Gmail sign-in. Clicking **Disconnect Gmail** in Settings deletes it.
- Back up the `data` folder if you want to keep your history.
