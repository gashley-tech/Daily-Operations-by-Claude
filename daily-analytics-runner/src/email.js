// Gmail via Railway's Gmail integration env vars (GMAIL_USER + GMAIL_APP_PASSWORD).
const nodemailer = require('nodemailer');
const t = () => nodemailer.createTransport({
  service: 'gmail',
  auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_APP_PASSWORD }
});
async function sendReport(def, html, date, docxBuf) {
  const to = def.recipients || [];
  if (!to.length || !html) return { key: def.key, skipped: true };
  await t().sendMail({
    from: process.env.MAIL_FROM || process.env.GMAIL_USER, to: to.join(','),
    subject: `Ashley Daily — ${def.title} — ${date}`,
    html,
    attachments: [{ filename: `${def.key}_${date}.docx`, content: docxBuf, contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' }]
  });
  return { key: def.key, to };
}
module.exports = { sendReport };

async function sendConfirmation(log, date) {
  const to = (process.env.CONFIRM_TO || process.env.GMAIL_USER).split(',');
  const rows = log.steps.filter(s => s && s.key).map(s =>
    `<tr><td style="padding:5px;border:1px solid #ddd">${s.key}</td>
     <td style="padding:5px;border:1px solid #ddd">${s.to ? '✅ ' + s.to.join(', ') : (s.missing ? '⚠️ not generated' : s.skipped ? '– no recipients' : '')}</td>
     <td style="padding:5px;border:1px solid #ddd">${s.dropbox === false ? '❌ failed' : '✅ /Daily/' + date + '/'}</td></tr>`).join('');
  const html = `<div style="font-family:Arial">
   <h2 style="color:#1D3557">🌅 Morning Run Confirmation — ${date}</h2>
   <p>Status: <b style="color:${log.ok ? '#1D9E75' : '#C41E3A'}">${log.ok ? 'SUCCESS' : 'FAILED: ' + (log.error||'')}</b>
   · Started ${log.started} · Finished ${log.finished}</p>
   <table style="border-collapse:collapse;font-size:13px">
   <tr style="background:#1D3557;color:#fff"><th style="padding:6px">Report</th><th style="padding:6px">Emailed to</th><th style="padding:6px">Dropbox (.docx)</th></tr>
   ${rows}</table>
   <p style="font-size:11px;color:#64748B">Tokens: ${JSON.stringify((log.steps.find(s=>s&&s.usage)||{}).usage||{})} · Full log saved to Dropbox.</p></div>`;
  await t().sendMail({ from: process.env.MAIL_FROM || process.env.GMAIL_USER, to: to.join(','),
    subject: `✅ Daily run ${log.ok ? 'complete' : 'FAILED'} — ${date}`, html });
}
module.exports.sendConfirmation = sendConfirmation;
