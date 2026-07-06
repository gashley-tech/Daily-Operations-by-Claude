// Non-public dashboard (basic auth) + schedule editor + run-now + logs.
const express = require('express');
const auth = require('basic-auth');
const cron = require('node-cron');
const fs = require('fs');
const { runMorning } = require('./run');

const app = express(); app.use(express.json());
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

app.get('/', guard, (req, res) => {
  const s = readSched();
  const logs = fs.existsSync('cache/runs.log') ? fs.readFileSync('cache/runs.log','utf8').trim().split('\n').slice(-10).reverse() : [];
  res.send(`<html><body style="font-family:Arial;max-width:780px;margin:40px auto">
  <h2>Ashley Daily Analytics Runner</h2>
  <p>Schedule: <b>${s.cron}</b> (${s.timezone}) — ${s.enabled ? 'ENABLED' : 'DISABLED'}</p>
  <form method="POST" action="/schedule"><input name="cron" value="${s.cron}" style="width:160px">
   <select name="enabled"><option ${s.enabled?'selected':''}>true</option><option ${!s.enabled?'selected':''}>false</option></select>
   <button>Save schedule</button></form>
  <form method="POST" action="/run-now"><button>Run now</button></form>
  <h3>Last runs</h3><pre style="background:#f5f5f5;padding:10px;font-size:11px">${logs.join('\n\n')}</pre>
  </body></html>`);
});
app.use(express.urlencoded({ extended: true }));
app.post('/schedule', guard, (req, res) => {   // body: full schedules JSON from the dashboard editor
  fs.writeFileSync(SCHED, JSON.stringify({ schedules: JSON.parse(req.body.schedules) }, null, 2));
  register(); res.redirect('/');
});
app.post('/run-now', guard, async (req, res) => { runMorning(); res.redirect('/'); });
app.get('/health', (req, res) => res.send('ok'));

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
  meta.recipients = mutate(meta.recipients || []);
  text = text.replace(m[0], '```json\n' + JSON.stringify(meta, null, 2) + '\n```');
  await fetch('https://content.dropboxapi.com/2/files/upload', { method:'POST',
    headers:{Authorization:`Bearer ${process.env.DROPBOX_TOKEN}`,'Content-Type':'application/octet-stream',
    'Dropbox-API-Arg':JSON.stringify({path:p,mode:'overwrite'})}, body:text });
}
app.post('/recipients/add', guard, async (req, res) => {
  const email = (req.body.email||'').trim();
  if (/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email))
    await dbxDefRW(req.body.key, r => r.includes(email) ? r : [...r, email]);
  res.redirect('/');
});
app.post('/recipients/remove', guard, async (req, res) => {
  await dbxDefRW(req.body.key, r => r.filter(x => x !== req.body.email));
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
    const r = await fetch('https://content.dropboxapi.com/2/files/download', {
      method: 'POST', headers: { Authorization: `Bearer ${process.env.DROPBOX_TOKEN}`,
        'Dropbox-API-Arg': JSON.stringify({ path: `${process.env.DROPBOX_BASE}/agent.skill/Daily_Operation.md` }) } });
    out.dropbox = { ok: r.ok, found_daily_operation_md: r.ok };
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

// ---- ONE-TIME Shopify OAuth token capture (delete or ignore after use) ----
// New vars needed temporarily: SHOPIFY_CLIENT_ID, SHOPIFY_CLIENT_SECRET (from Dev Dashboard)
app.get('/shopify/auth', guard, (req, res) => {
  const redirect = `https://${req.get('host')}/shopify/callback`;
  const url = `https://${process.env.SHOPIFY_STORE}/admin/oauth/authorize` +
    `?client_id=${process.env.SHOPIFY_CLIENT_ID}` +
    `&scope=read_orders,read_products,read_analytics` +
    `&redirect_uri=${encodeURIComponent(redirect)}`;
  res.redirect(url);
});

app.get('/shopify/callback', async (req, res) => {
  try {
    const r = await fetch(`https://${process.env.SHOPIFY_STORE}/admin/oauth/access_token`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id: process.env.SHOPIFY_CLIENT_ID,
        client_secret: process.env.SHOPIFY_CLIENT_SECRET,
        code: req.query.code })
    });
    const j = await r.json();
    if (!j.access_token) return res.status(500).send('Exchange failed: ' + JSON.stringify(j));
    console.log('SHOPIFY_TOKEN (copy from Railway logs):', j.access_token);
    res.send(`<div style="font-family:Arial;max-width:600px;margin:60px auto">
      <h2>Token captured</h2>
      <p>Copy this into Railway Variables as <b>SHOPIFY_TOKEN</b>, then redeploy:</p>
      <pre style="background:#f5f5f5;padding:14px;word-break:break-all">${j.access_token}</pre>
      <p style="color:#64748B;font-size:13px">Scopes: ${j.scope}. This is an offline token, it does not expire
      unless the app is uninstalled or reinstalled. You can now remove the /shopify routes or leave them,
      since /shopify/auth is behind your dashboard login.</p></div>`);
  } catch (e) { res.status(500).send(e.message); }
});
