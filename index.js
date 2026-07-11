// report-mailer v2 — Dropbox → team email, per-report recipients + send schedules.
// Implements the approved dashboard-mockup semantics:
//   * Email registry by permanent ID # (config.registry) — per-report recipient mapping
//   * Email schedule per report, independent of run times:
//       instant  — email the moment a new report lands in Dropbox
//       fixed    — email only at listed ET times, attaching the LATEST filed edition
//       digest   — one email per listed time containing ALL of the day's not-yet-sent editions
//       hold     — file silently; nothing emails until an admin flips the mode
//   * Source check — only files matching the report's locked filename pattern in its folder;
//       optional manifest gate (run_manifest.json content-hash match) so team uploads are never emailed
//   * Detection — Dropbox webhook (instant) + polling fallback; sent-state stored IN DROPBOX
//       so Railway restarts/redeploys never re-send
// Secrets come from Railway env vars only. Nothing sensitive lives in this repo.

const nodemailer = require('nodemailer');
const { summarize } = require('./summarize.js');
const { captureAll } = require('./capture.js');
const crypto = require('crypto');
const http = require('http');
const fs = require('fs');
const path = require('path');
const CFG = require('./config.json');

const {
  DROPBOX_APP_KEY, DROPBOX_APP_SECRET, DROPBOX_REFRESH_TOKEN,
  GMAIL_USER, GMAIL_APP_PASSWORD,
} = process.env;
for (const [k, v] of Object.entries({ DROPBOX_APP_KEY, DROPBOX_APP_SECRET, DROPBOX_REFRESH_TOKEN, GMAIL_USER, GMAIL_APP_PASSWORD })) {
  if (!v) { console.error(`FATAL: missing env var ${k}`); process.exit(1); }
}
const PORT = Number(process.env.PORT || 8080);
const STATE_PATH = `${CFG.basePath}/agent.skill/email_runner_state.json`;

// ---------- time helpers (ET) ----------
function nowET() { return new Date(new Date().toLocaleString('en-US', { timeZone: CFG.timezone })); }
function todayET() {
  const d = nowET();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function hhmmET() { const d = nowET(); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; }
function dowET() { return ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][nowET().getDay()]; }

// ---------- Dropbox ----------
let tok = null, tokExp = 0;
async function accessToken() {
  if (tok && Date.now() < tokExp - 60_000) return tok;
  const r = await fetch('https://api.dropboxapi.com/oauth2/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: DROPBOX_REFRESH_TOKEN, client_id: DROPBOX_APP_KEY, client_secret: DROPBOX_APP_SECRET }),
  });
  if (!r.ok) throw new Error(`token: ${r.status} ${await r.text()}`);
  const j = await r.json(); tok = j.access_token; tokExp = Date.now() + (j.expires_in || 14400) * 1000; return tok;
}
const HDRS = async () => ({
  Authorization: `Bearer ${await accessToken()}`,
  'Dropbox-API-Path-Root': JSON.stringify({ '.tag': 'root', root: CFG.rootNamespace }),
});
async function listFolder(path) {
  const out = [];
  let r = await fetch('https://api.dropboxapi.com/2/files/list_folder', {
    method: 'POST', headers: { ...(await HDRS()), 'Content-Type': 'application/json' },
    body: JSON.stringify({ path, recursive: false }),
  });
  if (r.status === 409) return out; // folder not created yet today
  if (!r.ok) throw new Error(`list ${path}: ${r.status} ${await r.text()}`);
  let j = await r.json(); out.push(...j.entries);
  while (j.has_more) {
    r = await fetch('https://api.dropboxapi.com/2/files/list_folder/continue', {
      method: 'POST', headers: { ...(await HDRS()), 'Content-Type': 'application/json' },
      body: JSON.stringify({ cursor: j.cursor }),
    });
    j = await r.json(); out.push(...j.entries);
  }
  return out.filter(e => e['.tag'] === 'file');
}
async function download(path) {
  const r = await fetch('https://content.dropboxapi.com/2/files/download', {
    method: 'POST', headers: { ...(await HDRS()), 'Dropbox-API-Arg': JSON.stringify({ path }) },
  });
  if (!r.ok) throw new Error(`download ${path}: ${r.status}`);
  return Buffer.from(await r.arrayBuffer());
}
async function upload(path, buf) {
  const r = await fetch('https://content.dropboxapi.com/2/files/upload', {
    method: 'POST',
    headers: { ...(await HDRS()), 'Dropbox-API-Arg': JSON.stringify({ path, mode: 'overwrite', mute: true }), 'Content-Type': 'application/octet-stream' },
    body: buf,
  });
  if (!r.ok) throw new Error(`upload ${path}: ${r.status} ${await r.text()}`);
}

// ---------- state & manifest (both live in Dropbox) ----------
async function loadJson(path, fallback) { try { return JSON.parse((await download(path)).toString('utf8')); } catch { return fallback; } }
const saveState = s => upload(STATE_PATH, Buffer.from(JSON.stringify(s, null, 1)));
const fkey = e => `${e.path_lower}@${e.content_hash}`;

// ---------- recipients (config.json defaults + live overrides edited from the dashboard) ----------
// Overrides live IN DROPBOX (agent.skill/mailer_overrides.json) so dashboard edits apply
// immediately, survive redeploys, and need no git push. config.json stays the seed defaults.
const OVR_PATH = `${CFG.basePath}/agent.skill/mailer_overrides.json`;
let ovrCache = null, ovrAt = 0;
async function loadOverrides(force) {
  if (!force && ovrCache && Date.now() - ovrAt < 60_000) return ovrCache;
  ovrCache = await loadJson(OVR_PATH, { registry: {}, reports: {} });
  ovrCache.registry ||= {}; ovrCache.reports ||= {};
  ovrAt = Date.now(); return ovrCache;
}
async function saveOverrides(o) { await upload(OVR_PATH, Buffer.from(JSON.stringify(o, null, 1))); ovrCache = o; ovrAt = Date.now(); }

// ---------- machine token (v3.0) ----------
// Lives in Dropbox at agent.skill/machine_token.txt — the report builder writes it, this app reads
// it. No env-var paste, no redeploy on rotation. CAPTURE_TOKEN env still honored as an override.
const TOK_PATH = `${CFG.basePath}/agent.skill/machine_token.txt`;
let tokCache = null, tokAt = 0;
async function machineToken(force) {
  if (!force && tokCache !== null && Date.now() - tokAt < 300_000) return tokCache;
  try { tokCache = (await download(TOK_PATH)).toString('utf8').trim(); } catch { tokCache = ''; }
  tokAt = Date.now(); return tokCache;
}
async function machineAuthed(req) {
  const hdr = String(req.headers['x-capture-token'] || '').trim();
  if (!hdr) return false;
  if (process.env.CAPTURE_TOKEN && safeEq(hdr, String(process.env.CAPTURE_TOKEN).trim())) return true;
  let t = await machineToken(); if (t && safeEq(hdr, t)) return true;
  t = await machineToken(true); // cache may be stale right after a rotation — re-read once
  return !!(t && safeEq(hdr, t));
}
const effRegistry = o => { const r = {}; for (const [k, v] of Object.entries(CFG.registry)) r[k] = { ...v, ...(o.registry[k] || {}) }; for (const [k, v] of Object.entries(o.registry)) if (!r[k]) r[k] = v; return r; };
const effRecipients = (o, rep) => (o.reports[rep.key]?.recipients) ?? rep.recipients;
const effSchedule = (o, r) => (o.reports?.[r.key]?.schedule) ?? r.schedule;
const effCaptures = o => ({ ...(CFG.captures || {}), ...(o.captures || {}),
  dailyTimes: (o.captures && o.captures.dailyTimes) || (CFG.captures || {}).dailyTimes || [],
  urls: (o.captures && o.captures.urls) || (CFG.captures || {}).urls || [] });

async function recipientsFor(report) {
  const o = await loadOverrides().catch(() => ({ registry: {}, reports: {} }));
  const reg = effRegistry(o);
  return effRecipients(o, report)
    .map(id => reg[id])
    .filter(p => p && !p.disabled)
    .map(p => p.email);
}

// ---------- source check ----------
function classify(entry) {
  const name = entry.name;
  const p = entry.path_display || '';
  if (CFG.excludes.some(x => new RegExp(x, 'i').test(name) || new RegExp(x, 'i').test(p))) return null;
  if ((entry.size || 0) > CFG.maxAttachmentMB * 1024 * 1024) return null;
  for (const rep of CFG.reports) {
    if (rep.enabled === false) continue;
    const folder = `${CFG.basePath}/${rep.folder.replace('{today}', todayET())}`.toLowerCase();
    if (!entry.path_lower.startsWith(folder + '/')) continue;
    if (new RegExp(rep.pattern).test(name)) return rep;
  }
  return null; // not a recognized report => never emailed (team upload, stray file)
}
async function manifestAllows(entry) {
  const m = await loadJson(`${CFG.basePath}/${CFG.manifest.path}`, null);
  if (!m) return { ok: !CFG.manifest.require, verified: false };
  const listed = (m.files || []).some(f => f.content_hash === entry.content_hash || f.name === entry.name);
  if (listed) return { ok: true, verified: true };
  return { ok: !CFG.manifest.require, verified: false };
}

// ---------- email ----------
const mailer = nodemailer.createTransport({ host: 'smtp.gmail.com', port: 465, secure: true, auth: { user: GMAIL_USER, pass: GMAIL_APP_PASSWORD } });
async function sendMail(report, entries, buffers, note) {
  const to = await recipientsFor(report);
  if (to.length === 0) { console.warn(`${report.key}: no active recipients — skipped`); return; }
  const latest = entries[entries.length - 1];

  // v2.6: extract highlights from the attached report so the email body carries a summary
  let sum = null;
  try { sum = summarize(buffers[buffers.length - 1], report.label); } catch (e) { console.warn('summary extract failed:', e.message); }
  const esc = t => String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;');

  const textBody =
`${report.label} — ${entries.length > 1 ? `today's ${entries.length} editions attached` : 'new edition attached'}.
${sum && sum.headline ? '\n' + sum.headline + '\n' : ''}${sum && sum.summary ? '\n' + sum.summary + '\n' : ''}${sum && sum.bullets.length ? '\nKEY POINTS:\n' + sum.bullets.map(b => '  • ' + b).join('\n') + '\n' : ''}
Attached:
${entries.map(e => `  • ${e.name}  (filed ${e.server_modified} UTC)`).join('\n')}
${note ? '\n' + note + '\n' : ''}
To reply with comments, use the shaded cells / comment-log rows in the doc and drop your copy in the
matching "Team Replies" Dropbox folder — it will fold into the next build automatically.

— automated mailer`;

  const verdictColor = sum && /GREEN/i.test(sum.headline || '') ? '#1D9E75' : sum && /RED/i.test(sum.headline || '') ? '#C41E3A' : '#B45309';
  const htmlBody = `<div style="font:14px/1.5 Segoe UI,Arial,sans-serif;color:#1a2030;max-width:720px">
<p style="margin:0 0 6px"><b>${esc(report.label)}</b> — ${entries.length > 1 ? `today's ${entries.length} editions attached` : 'new edition attached'}.</p>
${sum && sum.headline ? `<p style="margin:10px 0 4px;font-weight:700;color:${verdictColor}">${esc(sum.headline)}</p>` : ''}
${sum && sum.summary ? `<p style="margin:4px 0 10px">${esc(sum.summary)}</p>` : ''}
${sum && sum.bullets.length ? `<p style="margin:8px 0 2px"><b>Key points</b></p><ul style="margin:2px 0 12px;padding-left:20px">${sum.bullets.map(b => `<li style="margin:3px 0">${esc(b)}</li>`).join('')}</ul>` : ''}
<p style="margin:10px 0 2px;color:#64748b;font-size:12px">Attached: ${entries.map(e => esc(e.name)).join(' · ')}</p>
${note ? `<p style="color:#B45309;font-size:12px">${esc(note)}</p>` : ''}
<p style="color:#64748b;font-size:12px">To reply with comments, use the shaded cells / comment-log rows in the doc and drop your copy in the matching "Team Replies" Dropbox folder — it folds into the next build automatically.</p>
</div>`;

  await mailer.sendMail({
    from: `"${CFG.fromName}" <${GMAIL_USER}>`,
    to: to.join(', '),
    subject: `[${report.label}] ${sum && sum.headline ? sum.headline.replace(/^TODAY AT A GLANCE\s*/i, '') : latest.name.replace(/\.docx$/i, '')}${entries.length > 1 ? ` (+${entries.length - 1} earlier)` : ''}`,
    text: textBody,
    html: htmlBody,
    attachments: entries.map((e, i) => ({ filename: e.name, content: buffers[i] })),
  });
  console.log(`sent ✓ ${report.key}: ${entries.map(e => e.name).join(', ')} -> ${to.length} recipients${sum ? ' (with summary)' : ' (no summary extracted)'}`);
}

// ---------- core: scan folders, route by schedule mode ----------
let scanning = false;
async function scan(trigger) {
  if (scanning) return; scanning = true;
  try {
    const state = await loadJson(STATE_PATH, null) ?? { sent: {}, seen: {}, baselined: false };
    const ovr = await loadOverrides().catch(() => ({ registry: {}, reports: {} }));
    const folders = [...new Set(CFG.reports.filter(r => r.enabled !== false).map(r => `${CFG.basePath}/${r.folder.replace('{today}', todayET())}`))];
    const hhmm = hhmmET(), today = todayET(), dow = dowET();

    for (const folder of folders) {
      let files; try { files = await listFolder(folder); } catch (e) { console.error(e.message); continue; }
      for (const f of files) {
        const rep = classify(f); if (!rep) continue;
        const key = fkey(f);
        const sched = effSchedule(ovr, rep);
        if (state.sent[key] || (state.seen[key] && sched.mode !== 'instant')) continue;

        if (!state.baselined) { state.seen[key] = { name: f.name, baseline: true }; continue; }

        const src = await manifestAllows(f);
        if (!src.ok) { console.warn(`BLOCKED (not in manifest): ${f.name}`); state.seen[key] = { name: f.name, blocked: true }; continue; }
        const note = src.verified ? null : '⚠ SOURCE-UNVERIFIED: file matched the naming pattern but no manifest entry was found.';

        if (sched.mode === 'instant') {
          try {
            await sendMail(rep, [f], [await download(f.path_lower)], note);
            state.sent[key] = { name: f.name, at: new Date().toISOString(), mode: 'instant' };
            await saveState(state); // save per send — a crash can never double-send
          } catch (e) { console.error(`send failed ${f.name}: ${e.message} (retry next scan)`); }
        } else {
          // fixed / digest / hold: just record as pending; time-based dispatcher sends
          state.seen[key] = { name: f.name, path: f.path_lower, report: rep.key, day: today, filed: f.server_modified, pending: sched.mode !== 'hold', note };
        }
      }
    }

    // scheduled page captures (v2.7; v2.8: dashboard-editable via overrides)
    const capCfg = effCaptures(await loadOverrides().catch(() => ({})));
    for (const t of (capCfg.dailyTimes || [])) {
      if (t !== hhmm) continue;
      const capKey = `capture@${today}@${hhmm}`;
      if (state.sent[capKey]) continue;
      state.sent[capKey] = { at: new Date().toISOString() };
      await saveState(state);
      captureAll({ ...CFG, captures: capCfg }, upload, todayET, hhmmET).then(r => console.log('daily capture:', JSON.stringify(r))).catch(e => console.error('capture failed:', e.message));
    }

    // time-based dispatch (fixed & digest) — fires when current ET minute matches a listed time
    for (const rep of CFG.reports) {
      const dsched = effSchedule(ovr, rep);
      if (rep.enabled === false || !['fixed', 'digest'].includes(dsched.mode)) continue;
      if (dsched.days && !dsched.days.includes(dow)) continue;
      if (!(dsched.times || []).includes(hhmm)) continue;
      const slotKey = `${rep.key}@${today}@${hhmm}`;
      if (state.sent[slotKey]) continue;

      const pend = Object.entries(state.seen).filter(([, v]) => v.report === rep.key && v.day === today && v.pending);
      if (pend.length === 0) { console.log(`${rep.key} ${hhmm}: nothing new to send`); state.sent[slotKey] = { empty: true }; await saveState(state); continue; }

      pend.sort((a, b) => (a[1].filed < b[1].filed ? -1 : 1));
      const chosen = dsched.mode === 'fixed' ? [pend[pend.length - 1]] : pend; // fixed = LATEST edition only; digest = all
      try {
        const entries = chosen.map(([, v]) => ({ name: v.name, path_lower: v.path, server_modified: v.filed }));
        const bufs = []; for (const e of entries) bufs.push(await download(e.path_lower));
        await sendMail(rep, entries, bufs, chosen.map(([, v]) => v.note).find(Boolean));
        for (const [k] of (dsched.mode === 'fixed' ? pend : chosen)) { state.seen[k].pending = false; state.sent[k] = { at: new Date().toISOString(), mode: dsched.mode, slot: hhmm }; }
        state.sent[slotKey] = { at: new Date().toISOString(), count: chosen.length };
        await saveState(state);
      } catch (e) { console.error(`${rep.key} ${hhmm} dispatch failed: ${e.message}`); }
    }

    if (!state.baselined) { state.baselined = true; await saveState(state); console.log(`baseline recorded (${Object.keys(state.seen).length} existing files) — only files filed from now on are emailed`); }
  } finally { scanning = false; }
}

// ---------- auth: dashboard password + separate admin password (Settings) ----------
// DASHBOARD_PASSWORD — required to open the dashboard at all.
// ADMIN_PASSWORD     — additionally required (server-verified) to unlock the Settings tab.
// Sessions are HMAC-signed cookies; secret derives from env so restarts keep sessions valid.
const DASH_PW = process.env.DASHBOARD_PASSWORD || '';
const ADMIN_PW = process.env.ADMIN_PASSWORD || '';
const SECRET = process.env.SESSION_SECRET || crypto.createHash('sha256').update(`${DROPBOX_APP_SECRET}|${DASH_PW}|${ADMIN_PW}`).digest('hex');
const sign = v => `${v}.${crypto.createHmac('sha256', SECRET).update(v).digest('hex').slice(0, 32)}`;
const verify = c => { if (!c) return false; const i = c.lastIndexOf('.'); if (i < 0) return false; return sign(c.slice(0, i)) === c; };
const safeEq = (a, b) => { const A = Buffer.from(String(a)), B = Buffer.from(String(b)); return A.length === B.length && crypto.timingSafeEqual(A, B); };
const getCookie = (req, name) => ((req.headers.cookie || '').split(/;\s*/).find(c => c.startsWith(name + '=')) || '').split('=').slice(1).join('=');
const readBody = req => new Promise(r => { let b = ''; req.on('data', c => b += c); req.on('end', () => r(b)); });

const LOGIN_HTML = `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Ashley Stewart · Daily Ops Portal</title><style>body{font:14px 'Segoe UI',system-ui,sans-serif;background:#1D3557;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}
.c{background:#fff;border-radius:14px;padding:38px 42px;text-align:center;max-width:340px}h1{font-size:15px;letter-spacing:.12em;color:#1D3557;margin:0 0 4px}
p{color:#8a93a3;font-size:12.5px;margin:0 0 18px}input{width:100%;box-sizing:border-box;padding:10px 12px;border:1px solid #e4e7ee;border-radius:8px;font:inherit;margin-bottom:10px}
button{width:100%;padding:10px;border:0;border-radius:8px;background:#1D3557;color:#fff;font:inherit;font-weight:700;cursor:pointer}.e{color:#C41E3A;font-size:12px;margin-top:10px;display:none}</style></head>
<body><form class="c" method="POST" action="/login"><h1>ASHLEY STEWART</h1><p>Daily Ops Portal — team access</p>
<input type="password" name="password" placeholder="Portal password" autofocus><button>Enter</button>
<div class="e" id="e">Wrong password.</div><script>if(location.search.includes('bad'))document.getElementById('e').style.display='block'</script></form></body></html>`;

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');

  // --- unauthenticated endpoints: Dropbox webhook + health ---
  if (url.pathname === '/webhook' && req.method === 'GET') {           // verification handshake
    res.setHeader('Content-Type', 'text/plain'); res.setHeader('X-Content-Type-Options', 'nosniff');
    return res.end(url.searchParams.get('challenge') || '');
  }
  if (url.pathname === '/webhook' && req.method === 'POST') {          // change notification
    const body = await readBody(req);
    const sig = req.headers['x-dropbox-signature'] || '';
    const expect = crypto.createHmac('sha256', DROPBOX_APP_SECRET).update(body).digest('hex');
    if (!safeEq(sig, expect)) { res.statusCode = 403; return res.end(); }
    res.end('ok');
    console.log('webhook: change notification — scanning');
    scan('webhook').catch(e => console.error(e.message));
    return;
  }
  if (url.pathname === '/health') { res.setHeader('Content-Type', 'application/json'); return res.end(JSON.stringify({ ok: true, version: require('./package.json').version, now_et: nowET().toISOString() })); }

  // --- dashboard login ---
  if (url.pathname === '/login' && req.method === 'POST') {
    const body = await readBody(req);
    const pw = new URLSearchParams(body).get('password') || '';
    if (DASH_PW && safeEq(pw, DASH_PW)) {
      res.setHeader('Set-Cookie', `dash=${sign('team')}; HttpOnly; Path=/; Max-Age=43200; SameSite=Lax; Secure`);
      res.writeHead(302, { Location: '/' }); return res.end();
    }
    res.writeHead(302, { Location: '/?bad=1' }); return res.end();
  }

  // everything below requires the dashboard session
  const authed = verify(getCookie(req, 'dash'));
  if (url.pathname === '/' || url.pathname === '/dashboard') {
    if (!DASH_PW) { res.statusCode = 503; return res.end('DASHBOARD_PASSWORD not set — dashboard disabled'); }
    if (!authed) { res.setHeader('Content-Type', 'text/html'); return res.end(LOGIN_HTML); }
    res.setHeader('Content-Type', 'text/html');
    return res.end(fs.readFileSync(path.join(__dirname, 'dashboard.html')));
  }

  // --- real report list + downloads (dashboard session required) ---
  if (url.pathname === '/api/reports' && req.method === 'GET') {
    if (!authed) { res.statusCode = 401; return res.end(); }
    try {
      const folders = [
        `${CFG.basePath}/Daily/${todayET()}`,
        `${CFG.basePath}/Creative/Claude Daily Report for Creative`,
      ];
      const out = [];
      for (const folder of folders) {
        for (const f of await listFolder(folder)) {
          if (CFG.excludes.some(x => new RegExp(x, 'i').test(f.name) || new RegExp(x, 'i').test(f.path_display || ''))) continue;
          if (!/\.(docx|pdf|xlsx)$/i.test(f.name)) continue;
          const stream = /^R1_Executive_/i.test(f.name) ? 'exec'
                       : /^R1_ECommerce_|^R1_WeekPlan_/i.test(f.name) ? 'full'
                       : /DailyCreativeQA/i.test(f.name) ? 'r8' : 'other';
          out.push({ name: f.name, path: f.path_lower, display: f.path_display, modified: f.server_modified, size: f.size, stream });
        }
      }
      out.sort((a, b) => (a.modified < b.modified ? 1 : -1)); // newest first
      res.setHeader('Content-Type', 'application/json');
      return res.end(JSON.stringify({ date: todayET(), reports: out }));
    } catch (e) { res.statusCode = 500; return res.end(JSON.stringify({ error: e.message })); }
  }
  // "open" = view in Dropbox's web preview (new tab); "download" = direct file stream
  if (url.pathname === '/open' && req.method === 'GET') {
    if (!authed) { res.statusCode = 401; return res.end(); }
    const p = url.searchParams.get('path') || '';
    const okPath = p.toLowerCase().startsWith(CFG.basePath.toLowerCase() + '/')
      && /\.(docx|pdf|xlsx)$/i.test(p)
      && !/team replies|_to_delete|\.\./i.test(p);
    if (!okPath) { res.statusCode = 403; return res.end('invalid path'); }
    const preview = 'https://www.dropbox.com/preview' + p.split('/').map(encodeURIComponent).join('/') + '?context=browse';
    res.writeHead(302, { Location: preview }); return res.end();
  }
  if (url.pathname === '/download' && req.method === 'GET') {
    if (!authed) { res.statusCode = 401; return res.end(); }
    const p = url.searchParams.get('path') || '';
    // strict validation: inside the reports tree, report file types only, no reply/trash paths
    const okPath = p.toLowerCase().startsWith(CFG.basePath.toLowerCase() + '/')
      && /\.(docx|pdf|xlsx)$/i.test(p)
      && !/team replies|_to_delete|\.\./i.test(p);
    if (!okPath) { res.statusCode = 403; return res.end('invalid path'); }
    try {
      const buf = await download(p);
      const fname = p.split('/').pop();
      res.setHeader('Content-Type', 'application/octet-stream');
      res.setHeader('Content-Disposition', `attachment; filename="${fname.replace(/[^\w.\- ]/g, '_')}"`);
      return res.end(buf);
    } catch (e) { res.statusCode = 502; return res.end('download failed: ' + e.message); }
  }

  // --- live settings: registry + per-report recipient mapping (view = portal; edit = ADMIN) ---
  const isAdmin = verify(getCookie(req, 'admin'));
  if (url.pathname === '/api/config' && req.method === 'GET') {
    if (!authed) { res.statusCode = 401; return res.end(); }
    try {
      const o = await loadOverrides(true);
      const reg = effRegistry(o);
      res.setHeader('Content-Type', 'application/json');
      return res.end(JSON.stringify({
        registry: reg,
        reports: CFG.reports.map(r => ({ key: r.key, label: r.label, enabled: r.enabled !== false, schedule: effSchedule(o, r), recipients: effRecipients(o, r) })),
        admin: isAdmin,
      }));
    } catch (e) { res.statusCode = 502; return res.end(JSON.stringify({ error: e.message })); }
  }
  if (url.pathname === '/api/report-recipients' && req.method === 'POST') {
    if (!authed) { res.statusCode = 401; return res.end(); }
    if (!isAdmin) { res.statusCode = 403; return res.end('admin required'); }
    try {
      const b = JSON.parse(await readBody(req) || '{}');
      const rep = CFG.reports.find(r => r.key === b.reportKey);
      if (!rep) { res.statusCode = 400; return res.end('unknown report'); }
      const o = await loadOverrides(true);
      const reg = effRegistry(o);
      let list = [...effRecipients(o, rep)];
      for (const id of (b.remove || [])) list = list.filter(x => String(x) !== String(id));
      for (const id of (b.add || [])) { if (!reg[id]) { res.statusCode = 400; return res.end(`unknown id ${id}`); } if (!list.includes(String(id))) list.push(String(id)); }
      o.reports[rep.key] = { ...(o.reports[rep.key] || {}), recipients: list };
      await saveOverrides(o);
      console.log(`ADMIN edit: ${rep.key} recipients -> [${list.join(',')}]`);
      res.setHeader('Content-Type', 'application/json'); return res.end(JSON.stringify({ ok: true, recipients: list }));
    } catch (e) { res.statusCode = 502; return res.end('save failed: ' + e.message); }
  }
  if (url.pathname === '/api/registry' && req.method === 'POST') {
    if (!authed) { res.statusCode = 401; return res.end(); }
    if (!isAdmin) { res.statusCode = 403; return res.end('admin required'); }
    try {
      const b = JSON.parse(await readBody(req) || '{}');
      const o = await loadOverrides(true);
      const reg = effRegistry(o);
      if (b.action === 'add') {
        const email = String(b.email || '').trim();
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.replace('&', 'a'))) { res.statusCode = 400; return res.end('invalid email'); }
        if (Object.values(reg).some(p => p.email.toLowerCase() === email.toLowerCase())) { res.statusCode = 400; return res.end('email already registered'); }
        const nextId = String(Math.max(...Object.keys(reg).map(Number)) + 1); // IDs never reused
        o.registry[nextId] = { email, name: String(b.name || '').trim() || email };
        await saveOverrides(o);
        console.log(`ADMIN edit: registry +#${nextId} ${email}`);
        res.setHeader('Content-Type', 'application/json'); return res.end(JSON.stringify({ ok: true, id: nextId }));
      }
      if (b.action === 'disable' || b.action === 'enable') {
        if (!reg[b.id]) { res.statusCode = 400; return res.end('unknown id'); }
        o.registry[b.id] = { ...reg[b.id], disabled: b.action === 'disable' };
        await saveOverrides(o);
        console.log(`ADMIN edit: registry #${b.id} ${b.action}d`);
        res.setHeader('Content-Type', 'application/json'); return res.end(JSON.stringify({ ok: true }));
      }
      res.statusCode = 400; return res.end('unknown action');
    } catch (e) { res.statusCode = 502; return res.end('save failed: ' + e.message); }
  }

  // --- v3.0: report upload (machine token) — the builder files reports to Dropbox directly ---
  // POST /upload-report  { folder: "Daily/2026-07-11", filename: "R1_...docx", content_b64: "..." }
  // Folder is whitelisted to the reports tree; filename strictly validated; 30 MB cap.
  if (url.pathname === '/upload-report' && req.method === 'POST') {
    if (!(await machineAuthed(req))) { res.statusCode = 401; return res.end(); }
    try {
      const b = JSON.parse(await readBody(req) || '{}');
      const folder = String(b.folder || '');
      const filename = String(b.filename || '');
      const okFolder = /^(Daily\/\d{4}-\d{2}-\d{2}|Creative\/[\w .()&-]+|Screenshots\/\d{4}-\d{2}-\d{2}|agent\.skill(\/[\w .()-]+)?)$/.test(folder);
      const okName = /^[\w .()&-]+\.(docx|xlsx|pdf|md|txt|json|js|cjs|py|png|jpg|jpeg)$/.test(filename);
      if (!okFolder || !okName) { res.statusCode = 400; return res.end('folder or filename rejected'); }
      const buf = Buffer.from(String(b.content_b64 || ''), 'base64');
      if (!buf.length || buf.length > 30 * 1024 * 1024) { res.statusCode = 400; return res.end('empty or >30MB'); }
      const path = `${CFG.basePath}/${folder}/${filename}`;
      await upload(path, buf);
      log(`upload-report: filed ${folder}/${filename} (${buf.length} bytes) via machine token`);
      res.setHeader('Content-Type', 'application/json');
      return res.end(JSON.stringify({ ok: true, path: `${folder}/${filename}`, bytes: buf.length }));
    } catch (e) { res.statusCode = 500; return res.end(JSON.stringify({ ok: false, error: e.message })); }
  }

  // --- on-demand capture: POST /capture — admin session OR machine token (X-Capture-Token) ---
  // CAPTURE_TOKEN env var lets automated report builds trigger captures without the human login.
  if (url.pathname === '/capture' && req.method === 'POST') {
    const tokenOk = await machineAuthed(req);
    if (!tokenOk) {
      if (!authed) { res.statusCode = 401; return res.end(); }
      if (!isAdmin) { res.statusCode = 403; return res.end('admin required'); }
    }
    const capNow = effCaptures(await loadOverrides(true).catch(() => ({})));
    const r = await captureAll({ ...CFG, captures: capNow }, upload, todayET, hhmmET).catch(e => ({ ok: false, note: e.message }));
    res.setHeader('Content-Type', 'application/json'); return res.end(JSON.stringify(r));
  }

  // --- report email-schedule edit (admin): mode + times + days, live via overrides ---
  if (url.pathname === '/api/report-schedule' && req.method === 'POST') {
    if (!authed) { res.statusCode = 401; return res.end(); }
    if (!isAdmin) { res.statusCode = 403; return res.end('admin required'); }
    try {
      const b = JSON.parse(await readBody(req) || '{}');
      const target = CFG.reports.find(r => r.key === b.reportKey);
      if (!target) { res.statusCode = 400; return res.end('unknown report'); }
      const mode = String(b.mode || '');
      if (!['instant', 'fixed', 'digest', 'hold'].includes(mode)) { res.statusCode = 400; return res.end('mode must be instant|fixed|digest|hold'); }
      const schedule = { mode };
      if (mode === 'fixed' || mode === 'digest') {
        const times = (b.times || []).map(String).filter(t => /^([01]\d|2[0-3]):[0-5]\d$/.test(t));
        if (!times.length) { res.statusCode = 400; return res.end('fixed/digest need at least one HH:MM time'); }
        schedule.times = times;
      }
      if (Array.isArray(b.days) && b.days.length) schedule.days = b.days.filter(d => ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'].includes(d));
      const o = await loadOverrides(true);
      o.reports[target.key] = { ...(o.reports[target.key] || {}), schedule };
      await saveOverrides(o);
      console.log(`ADMIN edit: ${target.key} schedule -> ${JSON.stringify(schedule)}`);
      res.setHeader('Content-Type', 'application/json'); return res.end(JSON.stringify({ ok: true, schedule }));
    } catch (e) { res.statusCode = 502; return res.end('save failed: ' + e.message); }
  }

  // --- capture schedule: view (portal) + edit (admin) — R13 draft phase needs frequent changes ---
  if (url.pathname === '/api/captures' && req.method === 'GET') {
    if (!authed) { res.statusCode = 401; return res.end(); }
    const o = await loadOverrides(true).catch(() => ({ captures: null }));
    res.setHeader('Content-Type', 'application/json');
    return res.end(JSON.stringify({ captures: effCaptures(o), admin: isAdmin }));
  }
  if (url.pathname === '/api/captures' && req.method === 'POST') {
    if (!authed) { res.statusCode = 401; return res.end(); }
    if (!isAdmin) { res.statusCode = 403; return res.end('admin required'); }
    try {
      const b = JSON.parse(await readBody(req) || '{}');
      const o = await loadOverrides(true);
      const cur = effCaptures(o);
      if (b.action === 'set-times') {
        const times = (b.times || []).map(String).filter(t => /^([01]\d|2[0-3]):[0-5]\d$/.test(t));
        if (!times.length && (b.times || []).length) { res.statusCode = 400; return res.end('times must be HH:MM (24h ET)'); }
        o.captures = { ...(o.captures || {}), dailyTimes: times, urls: cur.urls };
      } else if (b.action === 'add-url') {
        const slug = String(b.slug || '').replace(/[^a-z0-9-]/gi, '').toLowerCase();
        if (!slug || !/^https:\/\//.test(b.url || '')) { res.statusCode = 400; return res.end('need slug + https url'); }
        if (cur.urls.some(u => u.slug === slug)) { res.statusCode = 400; return res.end('slug exists'); }
        o.captures = { ...(o.captures || {}), dailyTimes: cur.dailyTimes, urls: [...cur.urls, { slug, url: b.url, fullPage: !!b.fullPage }] };
      } else if (b.action === 'remove-url') {
        o.captures = { ...(o.captures || {}), dailyTimes: cur.dailyTimes, urls: cur.urls.filter(u => u.slug !== b.slug) };
      } else { res.statusCode = 400; return res.end('unknown action'); }
      await saveOverrides(o);
      console.log(`ADMIN edit: captures ${b.action}`);
      res.setHeader('Content-Type', 'application/json'); return res.end(JSON.stringify({ ok: true, captures: effCaptures(o) }));
    } catch (e) { res.statusCode = 502; return res.end('save failed: ' + e.message); }
  }

  // --- settings admin check (second password, server-verified) ---
  if (url.pathname === '/admin-login' && req.method === 'POST') {
    if (!authed) { res.statusCode = 401; return res.end(); }
    const body = await readBody(req);
    let pw = ''; try { pw = JSON.parse(body).password || ''; } catch {}
    if (ADMIN_PW && safeEq(pw, ADMIN_PW)) {
      res.setHeader('Set-Cookie', `admin=${sign('admin')}; HttpOnly; Path=/; Max-Age=3600; SameSite=Lax; Secure`);
      res.statusCode = 200; return res.end('ok');
    }
    res.statusCode = 403; return res.end();
  }

  res.statusCode = 404; res.end();
}).listen(PORT, () => console.log(`http on :${PORT} — / dashboard (password) · /admin-login (settings) · /webhook · /health`));

// ---------- schedulers ----------
setInterval(() => scan('minute').catch(e => console.error(e.message)), 60 * 1000);                       // minute tick: fixed/digest dispatch
setInterval(() => scan('poll').catch(e => console.error(e.message)), CFG.pollMinutes * 60 * 1000);       // poll fallback if a webhook is missed
scan('startup').catch(e => console.error(e.message));
console.log(`report-mailer v2 up — ${CFG.reports.filter(r => r.enabled !== false).length} active reports · registry ${Object.keys(CFG.registry).length} IDs · manifest.require=${CFG.manifest.require}`);
