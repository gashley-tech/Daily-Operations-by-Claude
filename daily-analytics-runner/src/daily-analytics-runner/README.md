# Ashley Daily Analytics Runner
GitHub -> Railway service: gathers morning sources, generates the 5 daily reports with Claude
(Haiku shapes raw data; Sonnet 4.6 generates with PROMPT CACHING on Daily_Operation.md), emails
each report per config/recipients.json, archives to Dropbox /Daily/YYYY-MM-DD/, and exposes a
basic-auth dashboard (schedule editor + run-now + logs).

## Deploy (Railway)
1. Push this repo to github.com/gashley-tech/daily-analytics-runner
2. Railway -> New Project -> Deploy from GitHub repo
3. Set every variable from .env.example in Railway Variables
4. Networking: generate a domain BUT dashboard is basic-auth protected (DASH_USER/DASH_PASS);
   for stricter privacy leave no public domain and use `railway run npm run run-now` / logs only
5. Health check path: /health

## Recipient mapping
Edit config/recipients.json — each report key lists its email recipients. digest_all reserved for a future combined digest.

## Cost design
- Haiku 4.5 ($1/$5 per MTok) shapes noisy raw text into compact JSON
- Sonnet 4.6 ($3/$15) generates reports; Daily_Operation.md + calendar sent as a cached system block
  (cache_control: ephemeral) -> ~90% off those input tokens on repeat runs
- Expected: roughly $0.50–$1.25/day; verify in console after 3 runs

## Not yet wired (TODOs)
- MS Graph mailbox feeds (Hourly Order Counts, KPI PDF, POS emails) — needs app registration (IT-6)
- Returns Excel generation (xlsx) — v2; current runner covers the 5 narrative reports
- Windsor paid pull — needs Windsor API key or export endpoint

## Adding a report WITHOUT redeploying
Drop a new .md file into Dropbox `/agent.skill/reports/` with a JSON frontmatter block
(key, title, enabled, recipients, optional schedule_days like ["Mon"]) followed by the
report's template instructions. The next scheduled run picks it up automatically.
Disable a report: set "enabled": false. Change recipients: edit the file. Zero deploys.
Seed definitions for the current five reports are in seed-reports/ — upload them to
/agent.skill/reports/ once and manage them there forever.

## Email
Uses Railway's Gmail integration: set GMAIL_USER and GMAIL_APP_PASSWORD. Every report is
emailed to its own recipients (from its definition file) AND saved to Dropbox /Daily/YYYY-MM-DD/
along with the run log. Reports are saved to Dropbox and attached to email as TRUE richly formatted .docx binaries (html-to-docx conversion) — no .doc workaround; the API pipeline has no text-only limitation.

## Versioning
Bump the VERSION file with every code change (semver: capability=minor, fix=patch).
The runner stamps VERSION + the Railway git SHA (RAILWAY_GIT_COMMIT_SHA, auto-provided)
into: the dashboard header, /health, every run log, and every confirmation email —
so each morning's reports declare exactly which code produced them.
