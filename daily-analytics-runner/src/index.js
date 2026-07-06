// Non-public dashboard (basic auth) + schedule editor + run-now + logs.
const express = require('express');
const auth = require('basic-auth');
const cron = require('node-cron');
const fs = require('fs');
const { runMorning } = require('./run');

const app = express(); app.use(express.json());
const VERSION = (fs.existsSync('VERSION') ? fs.readFileSync('VERSION','utf8').trim() : '0.0.0') + (process.env.RAILWAY_GIT_COMMIT_SHA ? ' @' + process.env.RAILWAY_GIT_COMMIT_SHA.slice(0,7) : '');
const SCHED = 'config/schedule.json';
let tasks = [];

const guard = (req, res, next) => {
  const c = auth(req);
  if (!c || c.name !== process.env.DASH_USER || c.pass !== process.env.DASH_PASS) {
    res.set('WWW-Authenticate', 'Basic realm="dashboard"'); return res.status(401).send('Auth required');
  } next();
};
const readSched = () => JSON.parse(fs.readFileSync(SCHED, 'utf8'));
function register() {
  tasks.forEach(t => t.stop()); tasks = [];
  const cfg = readSched();
  for (const s of cfg.schedules || []) {
    if (!s.enabled) continue;
    const only = s.reports === 'all' ? undefined : s.reports;
    tasks.push(cron.schedule(s.cron, () => runMorning(only), { timezone: s.timezone }));
  }
  console.log('registered', tasks.length, 'schedules');
}

app.get('/', guard, async (req, res) => {
  let ctxDefs=[]; try { const { loadAllDefinitions } = require('./reports'); ctxDefs = await loadAllDefinitions(); } catch(_){}
  const cfg = readSched();
  const models = JSON.parse(fs.readFileSync('config/models.json','utf8'));
  const KEYS = ['R1_Shopify','R2_Stores','R3_Returns','R4_Weather','R5_Messaging','R6_Reorders'];
  // schedules stored as {name, time:"06:00", days:"*"|"1", enabled, reports} in EDT; cron built on save
  const toTime = c => { const p=(c||'0 6 * * *').split(' '); return `${String(p[1]).padStart(2,'0')}:${String(p[0]).padStart(2,'0')}`; };
  const rows = (cfg.schedules||[]).map((sc,i)=>`
   <tr><td><input name="name_${i}" value="${sc.name||''}" style="width:105px"></td>
   <td><input type="time" name="time_${i}" value="${sc.time||toTime(sc.cron)}"></td>
   <td><select name="days_${i}"><option value="*" ${(sc.days||'*')==='*'?'selected':''}>Every day</option><option value="1-5" ${sc.days==='1-5'?'selected':''}>Weekdays</option><option value="1" ${sc.days==='1'?'selected':''}>Mondays</option><option value="0" ${sc.days==='0'?'selected':''}>Sundays</option></select></td>
   <td>${KEYS.map(k=>`<label style="font-size:10px;margin-right:5px"><input type="checkbox" name="rep_${i}_${k}" ${sc.reports==='all'||(Array.isArray(sc.reports)&&sc.reports.includes(k))?'checked':''}>${k.split('_')[0]}</label>`).join('')}</td>
   <td><input type="checkbox" name="en_${i}" ${sc.enabled?'checked':''}></td><td><input type="checkbox" name="del_${i}" title="delete on save"></td></tr>`).join('');
  // today's delivery summary from runs.log
  const today = new Date().toLocaleDateString('en-CA',{timeZone:'America/New_York'});
  let sumRows='', hasFail=false;
  if (fs.existsSync('cache/runs.log')) {
    for (const line of fs.readFileSync('cache/runs.log','utf8').trim().split('\n')) {
      try { const l = JSON.parse(line);
        if (!l.started || !l.started.startsWith(today)) continue;
        const t = new Date(l.started).toLocaleTimeString('en-US',{timeZone:'America/New_York',hour:'2-digit',minute:'2-digit'});
        for (const st of l.steps||[]) { if (st && st.key) {
          const ok = st.to && st.dropbox !== false; if (!ok) hasFail = true;
          sumRows += `<tr><td>${t}</td><td>${st.key}</td><td>${st.to? '\u2705 '+st.to.join(', ') : (st.skipped?'\u2013 no recipients':'\u274C not generated')}</td><td>${st.dropbox===false?'\u274C':'\u2705'}</td>
           <td>${ok?'':'<form method="POST" action="/run-one" style="margin:0"><input type="hidden" name="key" value="'+st.key+'"><button style="padding:3px 9px;font-size:10px;background:#C41E3A">Resend</button></form>'}</td></tr>`; } }
      } catch(_){}
    }
  }
  res.send(`<html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>
  body{font-family:Arial;background:#F1F5F9;margin:0;color:#1E293B}.top{background:#1D3557;color:#fff;padding:14px 24px}
  .top h1{font-size:17px;margin:0}.v{font-size:11px;color:#93C5FD}
  .wrap{max-width:920px;margin:22px auto;padding:0 14px}
  .card{background:#fff;border-radius:10px;box-shadow:0 1px 4px rgba(0,0,0,.08);padding:18px 22px;margin-bottom:16px}
  h2{font-size:13px;color:#1D3557;border-bottom:2px solid #2563EB;padding-bottom:5px;margin:0 0 10px}
  table{width:100%;border-collapse:collapse;font-size:12px}th{background:#1D3557;color:#fff;text-align:left;padding:6px}
  td{border-bottom:1px solid #E2E8F0;padding:5px;vertical-align:middle}
  input,select,button{padding:6px;border:1px solid #CBD5E1;border-radius:5px;font-size:12px}
  button{background:#2563EB;color:#fff;border:0;cursor:pointer;padding:8px 14px}.run{background:#1D9E75}
  pre{background:#0F172A;color:#E2E8F0;font-size:10px;padding:10px;border-radius:8px;overflow-x:auto}
  .hint{font-size:11px;color:#64748B}</style></head><body>
  <div class="top"><h1>\uD83C\uDF05 Ashley Daily Analytics Runner</h1><div class="v">version ${VERSION}</div></div><div class="wrap">
  <div class="card"><h2>TODAY'S DELIVERIES \u2014 ${today} (EDT, resets daily)</h2>
   <table><tr><th>Time</th><th>Report</th><th>Emailed</th><th>Dropbox</th><th></th></tr>${sumRows || '<tr><td colspan=5 class="hint">No runs yet today</td></tr>'}</table>
   ${hasFail?'<p class="hint" style="color:#C41E3A">Failures above have a Resend button \u2014 reruns just that report.</p>':''}</div>
  <div class="card"><h2>SCHEDULES \u2014 EDT times, reports baked in</h2>
   <form method="POST" action="/schedule-builder"><table id="st">
   <tr><th>Name</th><th>Time (EDT)</th><th>Days</th><th>Reports in this run</th><th>On</th><th>\u2715</th></tr>${rows}</table>
   <button type="button" onclick="addRow()" style="background:#1D9E75;margin-top:8px">\uFF0B Add schedule</button>
   <button style="margin-top:8px">Save all schedules</button></form>
   <p class="hint">Each schedule fires only its checked reports; each report emails its own recipients (Dropbox definitions).</p>
   <script>let n=0; function addRow(){ const K=['R1_Shopify','R2_Stores','R3_Returns','R4_Weather','R5_Messaging','R6_Reorders'];
    const r=document.getElementById('st').insertRow(-1); const i='new'+(n++);
    r.innerHTML='<td><input name="name_'+i+'" placeholder="name"></td><td><input type="time" name="time_'+i+'" value="14:00"></td>'+
    '<td><select name="days_'+i+'"><option value="*">Every day</option><option value="1-5">Weekdays</option><option value="1">Mondays</option><option value="0">Sundays</option></select></td>'+
    '<td>'+K.map(k=>'<label style="font-size:10px;margin-right:5px"><input type="checkbox" name="rep_'+i+'_'+k+'">'+k.split('_')[0]+'</label>').join('')+'</td>'+
    '<td><input type="checkbox" name="en_'+i+'" checked></td><td></td>'; }</script></div>
  <div class="card"><h2>RUN A REPORT NOW \u2014 independently</h2>
   <form method="POST" action="/run-one" style="display:flex;gap:8px">
   <select name="key"><option value="">ALL</option>${KEYS.map(k=>`<option>${k}</option>`).join('')}</select>
   <button class="run">\u25B6 Run</button></form></div>
  <div class="card"><h2>REPORTS \u2014 pause / resume (writes to Dropbox definition)</h2>
   <table><tr><th>Report</th><th>Status</th><th></th></tr>${(ctxDefs||[]).map(d=>`<tr><td>${d.key} \u2014 ${d.title||''}</td><td>${d.enabled!==false?'\u25B6 active':'\u23F8 paused'}</td><td><form method="POST" action="/report-toggle" style="margin:0"><input type="hidden" name="key" value="${d.key}"><input type="hidden" name="to" value="${d.enabled!==false?'off':'on'}"><button style="padding:4px 10px;font-size:11px;background:${d.enabled!==false?'#B45309':'#1D9E75'}">${d.enabled!==false?'Pause':'Resume'}</button></form></td></tr>`).join('')}</table>
   <p class="hint">Paused reports are skipped by every schedule until resumed.</p></div>
  <div class="card"><h2>MODELS</h2>
   <form method="POST" action="/models" style="display:flex;gap:8px;flex-wrap:wrap">
   <select name="generate"><option ${models.generate==='claude-sonnet-4-6'?'selected':''}>claude-sonnet-4-6</option><option ${models.generate==='claude-opus-4-8'?'selected':''}>claude-opus-4-8</option><option ${String(models.generate).startsWith('claude-haiku')?'selected':''}>claude-haiku-4-5-20251001</option></select>
   <select name="gather"><option ${String(models.gather).startsWith('claude-haiku')?'selected':''}>claude-haiku-4-5-20251001</option><option ${models.gather==='claude-sonnet-4-6'?'selected':''}>claude-sonnet-4-6</option></select>
   <label style="font-size:11px"><input type="checkbox" name="cache" ${models.cache?'checked':''}> prompt caching</label>
   <button>Save models</button></form></div>
  </div></body></html>`);
});
app.post('/report-toggle', guard, express.urlencoded({extended:true}), async (req,res)=>{
  await dbxDefRW(req.body.key, m => { m.enabled = req.body.to === 'on'; });
  res.redirect('/');
});
app.post('/run-one', guard, express.urlencoded({extended:true}), (req,res)=>{ runMorning(req.body.key?[req.body.key]:undefined); res.redirect('/'); });
app.post('/schedule-builder', guard, express.urlencoded({extended:true}), (req,res)=>{
  const KEYS = ['R1_Shopify','R2_Stores','R3_Returns','R4_Weather','R5_Messaging','R6_Reorders'];
  const out=[]; const ids = new Set();
  for (const k of Object.keys(req.body)) { const m = k.match(/^name_(.+)$/); if (m) ids.add(m[1]); }
  for (const i of ids) {
    const name = req.body[`name_${i}`]; if (!name || req.body[`del_${i}`]) continue;
    const [hh,mm] = String(req.body[`time_${i}`]||'06:00').split(':');
    const days = req.body[`days_${i}`] || '*';
    const reps = KEYS.filter(k=>req.body[`rep_${i}_${k}`]);
    out.push({ name, time:`${hh}:${mm}`, days, cron:`${+mm} ${+hh} * * ${days}`,
      timezone:'America/New_York', enabled: !!req.body[`en_${i}`],
      reports: reps.length===0||reps.length===KEYS.length ? 'all' : reps });
  }
  fs.writeFileSync(SCHED, JSON.stringify({ schedules: out }, null, 2)); register(); res.redirect('/');
});
app.use(express.urlencoded({ extended: true }));
app.post('/schedule', guard, (req, res) => {   // body: full schedules JSON from the dashboard editor
  fs.writeFileSync(SCHED, JSON.stringify({ schedules: JSON.parse(req.body.schedules) }, null, 2));
  register(); res.redirect('/');
});
app.post('/run-now', guard, async (req, res) => { runMorning(); res.redirect('/'); });
app.get('/health', (req, res) => res.json({ ok: true, version: VERSION }));

register();
app.listen(process.env.PORT || 3000, () => console.log('dashboard up'));

// ---- v2 endpoints: model switching + recipient management ----
const path = require('path');
app.post('/models', guard, (req, res) => {
  fs.writeFileSync('config/models.json', JSON.stringify({
    generate: req.body.generate, gather: req.body.gather, cache: req.body.cache === 'on' }, null, 2));
  res.redirect('/');
});
async function dbxDefRW(key, mutate) {  // read definition file, mutate recipients, write back
  const p = `${process.env.DROPBOX_BASE}/agent.skill/reports/${key}.md`;
  const dl = await fetch('https://content.dropboxapi.com/2/files/download', { method:'POST',
    headers:{Authorization:`Bearer ${process.env.DROPBOX_TOKEN}`,'Dropbox-API-Arg':JSON.stringify({path:p})}});
  let text = await dl.text();
  const m = text.match(/```json\s*([\s\S]*?)```/); const meta = JSON.parse(m[1]);
  mutate(meta);
  text = text.replace(m[0], '```json\n' + JSON.stringify(meta, null, 2) + '\n```');
  await fetch('https://content.dropboxapi.com/2/files/upload', { method:'POST',
    headers:{Authorization:`Bearer ${process.env.DROPBOX_TOKEN}`,'Content-Type':'application/octet-stream',
    'Dropbox-API-Arg':JSON.stringify({path:p,mode:'overwrite'})}, body:text });
}
app.post('/recipients/add', guard, async (req, res) => {
  const email = (req.body.email||'').trim();
  if (/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email))
    await dbxDefRW(req.body.key, m => { m.recipients=(m.recipients||[]); if(!m.recipients.includes(email)) m.recipients.push(email); });
  res.redirect('/');
});
app.post('/recipients/remove', guard, async (req, res) => {
  await dbxDefRW(req.body.key, m => { m.recipients=(m.recipients||[]).filter(x=>x!==req.body.email); });
  res.redirect('/');
});

// ---- credential test panel: /test (basic-auth protected) ----
app.get('/test', guard, async (req, res) => {
  const out = {};
  try {
    const Anthropic = require('@anthropic-ai/sdk');
    const a = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const t0 = Date.now();
    const m = await a.messages.create({ model: require('../config/models.json').gather,
      max_tokens: 5, messages: [{ role: 'user', content: 'Say ok' }] });
    out.anthropic = { ok: true, model: m.model, latency_ms: Date.now() - t0, usage: m.usage };
  } catch (e) { out.anthropic = { ok: false, error: e.message }; }
      try {
      const dbxPath = `${process.env.DROPBOX_BASE}/agent.skill/Daily_Operation.md`;
      const r = await fetch('https://content.dropboxapi.com/2/files/download', {
        method: 'POST', headers: { Authorization: `Bearer ${process.env.DROPBOX_TOKEN}`,
          'Dropbox-API-Arg': JSON.stringify({ path: dbxPath }) } });
      const dbxBody = r.ok ? null : await r.text();
      out.dropbox = { ok: r.ok, found_daily_operation_md: r.ok, path: dbxPath, status: r.status, error: dbxBody };
    } catch (e) { out.dropbox = { ok: false, error: e.message }; }
  try {
    const r = await fetch(`https://${process.env.SHOPIFY_STORE}/admin/api/2025-01/graphql.json`, {
      method: 'POST', headers: { 'X-Shopify-Access-Token': process.env.SHOPIFY_TOKEN,
        'Content-Type': 'application/json' }, body: JSON.stringify({ query: '{ shop { name } }' }) });
    const j = await r.json(); out.shopify = { ok: !!j.data, shop: j.data && j.data.shop && j.data.shop.name };
  } catch (e) { out.shopify = { ok: false, error: e.message }; }
  try {
    const nodemailer = require('nodemailer');
    await nodemailer.createTransport({ service: 'gmail',
      auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_APP_PASSWORD } }).verify();
    out.gmail = { ok: true, user: process.env.GMAIL_USER };
  } catch (e) { out.gmail = { ok: false, error: e.message }; }
  res.json(out);
});

// ---- TEAM UPLOAD PAGE (separate lighter credential: UPLOAD_PASS) ----
const multer = require('multer');
const uploadMw = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25*1024*1024 } });
const uploadGuard = (req, res, next) => {
  const c = auth(req);
  if (!c || c.pass !== process.env.UPLOAD_PASS) {
    res.set('WWW-Authenticate', 'Basic realm="upload"'); return res.status(401).send('Team passcode required');
  } next();
};
app.get('/upload', uploadGuard, (req, res) => res.send(`
  <div style="font-family:Arial;max-width:540px;margin:60px auto">
  <h2>📤 Ashley Data Upload</h2>
  <p style="color:#64748B;font-size:13px">Known files replace the CURRENT version (history kept in Dropbox).
  "Something new" goes to review and you'll get a confirmation of what it is before it's used.</p>
  <form method="POST" action="/upload" enctype="multipart/form-data">
    <select name="category" style="padding:8px;width:100%;margin-bottom:10px">
      <option value="Calendar">Promo Calendar</option>
      <option value="Margins">Margins / PO style file</option>
      <option value="Inventory">Inventory</option>
      <option value="Inbox">Something new (goes to review)</option>
    </select>
    <input type="file" name="file" style="margin-bottom:10px"><br>
    <button style="padding:10px 18px;background:#2563EB;color:#fff;border:0;border-radius:6px">Upload</button>
  </form></div>`));
app.post('/upload', uploadGuard, uploadMw.single('file'), async (req, res) => {
  try {
    const cat = req.body.category, f = req.file;
    if (!f) return res.status(400).send('No file');
    const known = { Calendar:'Promo_Calendar_CURRENT.xlsx', Margins:'PO_Style_Margins_CURRENT.xlsx', Inventory:'Inventory_CURRENT.xlsx' };
    const dest = cat === 'Inbox'
      ? `/Data/Inbox/${Date.now()}_${f.originalname}`
      : `/Data/${cat}/${known[cat]}`;
    const r = await fetch('https://content.dropboxapi.com/2/files/upload', { method:'POST',
      headers: { Authorization:`Bearer ${process.env.DROPBOX_TOKEN}`, 'Content-Type':'application/octet-stream',
        'Dropbox-API-Arg': JSON.stringify({ path:`${process.env.DROPBOX_BASE}${dest}`, mode:'overwrite' }) },
      body: f.buffer });
    if (!r.ok) return res.status(500).send('Dropbox upload failed: ' + await r.text());
    res.send(`✅ Uploaded to ${dest}. ${cat==='Inbox' ? "It will be analyzed on the next run and you'll get a confirmation of what it is." : 'The next run uses it automatically.'}`);
  } catch (e) { res.status(500).send(e.message); }
});

// ---- INTERNAL RERUN API (called by the upload portal; token-protected) ----
app.post('/api/rerun', express.json(), (req, res) => {
  if (req.get('X-Internal-Token') !== process.env.INTERNAL_TOKEN) return res.status(401).json({ error: 'bad token' });
  const keys = Array.isArray(req.body.keys) && req.body.keys.length ? req.body.keys : undefined;
  runMorning(keys);                          // fire async; confirmation email reports the outcome
  res.json({ accepted: true, scope: keys || 'all' });
});
