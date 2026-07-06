const { gatherAll } = require('./gather');
const { loadReportDefinitions } = require('./reports');
const { generateReports } = require('./claude');
const { sendReport, sendConfirmation } = require('./email');
const { toDocx } = require('./docx');
const fs = require('fs');

async function dropboxSave(path, content) {
  return fetch('https://content.dropboxapi.com/2/files/upload', {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.DROPBOX_TOKEN}`, 'Content-Type': 'application/octet-stream',
      'Dropbox-API-Arg': JSON.stringify({ path: `${process.env.DROPBOX_BASE}${path}`, mode: 'overwrite' }) },
    body: content });
}

async function runMorning(onlyKeys) {
  const log = { started: new Date().toISOString(), steps: [] };
  try {
    let defs = await loadReportDefinitions(); if (Array.isArray(onlyKeys)) defs = defs.filter(d => onlyKeys.includes(d.key));
    log.steps.push({ definitions: defs.map(d => d.key) });
    const ctx = await gatherAll(); log.steps.push('gathered');
    const { reports, usage } = await generateReports(ctx, defs);
    log.steps.push({ usage });
    for (const def of defs) {
      const html = reports[def.key];
      if (!html) { log.steps.push({ key: def.key, missing: true }); continue; }
      const docxBuf = await toDocx(html, def.title);                      // TRUE .docx binary
      log.steps.push(await sendReport(def, html, ctx.today, docxBuf));    // email w/ .docx attachment
      const dres = await dropboxSave(`/Daily/${ctx.today}/${def.key}_${ctx.today}.docx`, docxBuf); log.steps[log.steps.length-1].dropbox = dres.ok;
    }
    await dropboxSave(`/Daily/${ctx.today}/run_log_${ctx.today}.json`, JSON.stringify(log, null, 2));
    log.ok = true; await sendConfirmation(log, ctx.today).catch(e=>log.steps.push({confirmError:e.message}));
  } catch (e) { log.ok = false; log.error = e.message; }
  log.finished = new Date().toISOString();
  fs.appendFileSync('cache/runs.log', JSON.stringify(log) + '\n');
  return log;
}
module.exports = { runMorning };
if (require.main === module) runMorning().then(l => console.log(JSON.stringify(l, null, 2)));
