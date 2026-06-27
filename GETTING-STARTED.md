# Getting started with Job Scout

A private job-search dashboard that runs on **your own computer**. It searches job boards and LinkedIn for roles that fit you, scores each one 1–10, and keeps a job-search activity log you can use when filing for unemployment. **Nothing is uploaded anywhere** — all your data stays in a single file on your machine.

This same guide is built into the app under the **ℹ️ Setup & Help** tab.

---

## 1. Start it

You need **Node 24 or newer** installed (one-time — get it at [nodejs.org](https://nodejs.org)). Then, in a terminal:

```
job-scout serve
```

It prints a link — open it in your browser (usually **http://127.0.0.1:7777**). That's the only command you run day to day.

> First time, from the source folder, the command is `node bin/job-scout.js serve`.

---

## 2. Set up your profile

Open the **⚙ Settings** tab and fill in:

- Your name and location
- A short skills summary (used by the scorer)
- Work arrangement (remote / hybrid / on-site) and salary floor
- The job titles you're searching for

Click **Save Settings**.

---

## 3. Turn on your job sources

In **⚙ Settings → Job Sources**:

### JSearch (on by default) — Indeed, ZipRecruiter, Glassdoor & more
It needs a **free** key:

1. Make a free account at **[rapidapi.com](https://rapidapi.com)**
2. Open the **JSearch** API page (search "JSearch")
3. Click **Subscribe** → pick the free **Basic** plan (**200 searches/month, no credit card**)
4. Copy your key (labeled `x-rapidapi-key`) and paste it into the JSearch field in Settings

Don't want to bother? **Turn JSearch off** — you'll still get LinkedIn jobs.

### LinkedIn
LinkedIn works two ways. Use either or both:

- **LinkedIn (public)** — on by default, no login, nothing to set up. Pulls public job listings.
- **LinkedIn (your account)** — sign in once for richer, more complete results from your own logged-in session. Run this in your terminal, sign in when the window opens (including 2FA), then close it:

  ```
  job-scout linkedin login
  ```

  Then switch **LinkedIn (your account)** on in Settings. It rides *your* session on *your own machine* — nothing leaves your computer, and it searches with the same job titles you set in your profile. (Your LinkedIn session expires every few days; if the app says it's disconnected, just run that command again.)

### Email job alerts (optional, off by default)
If you already get job-alert emails from LinkedIn, Indeed, and the like, Job Scout can read those straight from *your own* mailbox and fold them into your matches. It's a bonus net — LinkedIn and JSearch already cover most jobs — so leave it off if your alert emails are noisy. Two ways, both off until you turn them on:

- **Apple Mail** (Mac only) — tick the box in Settings. The first run, macOS asks you to give your terminal **Full Disk Access** (System Settings → Privacy & Security → Full Disk Access → add **Terminal**). It only reads your Mail locally; nothing is sent anywhere.
- **Gmail / iCloud / Outlook / Yahoo** — pick your provider, enter your email, and paste an **app password** (not your normal login password). In Gmail that's **Account → Security → App passwords**; iCloud/Outlook/Yahoo have the same feature. The app password is stored only on your computer.

---

## 4. Use it day to day

- **Matches** — your scored jobs. **Mark Applied** logs it to your activity log, **Tailor** prepares a tailored resume, **×** dismisses it (you can undo a dismissal).
- **Job Search Log** — your weekly activity tracker (default **5/week** for Colorado unemployment; change it in Settings if your state differs), with **Export CSV** for your records. Keep records for 2 years in case of an audit.
- **Resumes** — your resume library, base and tailored.

---

## 5. Scoring (optional upgrade)

The default is **free keyword scoring** — no setup, works for everyone. For smarter AI scoring, pick a provider in Settings:

- **Claude Haiku** — uses your own Anthropic API key
- **Ollama** — your own local AI machine

---

## Your data & privacy

Everything — matches, activity log, resumes, settings — lives in one file on your computer at `~/.job-scout/job-scout.db`. To back it up, copy that file. Nothing is sent to any server we run.

---

## Trouble?

- **No jobs showing?** Add your JSearch key (step 3) or connect LinkedIn, set your search terms in Settings, then click **Refresh** on the Matches tab.
- **LinkedIn says it's disconnected?** Run `job-scout linkedin login` again.
- **Stuck?** This guide is also in the app under **ℹ️ Setup & Help**.
