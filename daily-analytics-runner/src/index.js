// Non-public dashboard (basic auth) + schedule editor + run-now + logs.
const express = require('express');
const auth = require('basic-auth');
const cron = require('node-cron');
const fs = require('fs');
const { runMorning } = require('./run');

const app = express(); app.use(express.json());
const SCHED = 'config/schedule.json';
let task = null;

const guard = (req, res, next) => {
  const c = auth(req);
  if (!c || c.name !== process.env.DASH_USER || c.pass !== process.env.DASH_PASS) {
    res.set('WWW-Authenticate', 'Basic realm="dashboard"'); return res.status(401).send('Auth required');
  } next();
};
const readSched = () => JSON.parse(fs.readFileSync(SCHED, 'utf8'));
function register() {
  if (task) task.stop();
  const s = readSched();
  if (s.enabled) task = cron.schedule(s.cron, () => runMorning(), { timezone: s.timezone });
  console.log('schedule:', s);
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
app.post('/schedule', guard, (req, res) => {
  const s = readSched(); s.cron = req.body.cron; s.enabled = req.body.enabled === 'true';
  fs.writeFileSync(SCHED, JSON.stringify(s, null, 2)); register(); res.redirect('/');
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
