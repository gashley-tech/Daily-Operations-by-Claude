// New-file intake: scans /Data/Inbox, uses Haiku to draft a registry entry,
// includes the draft in the confirmation email. NEVER feeds unregistered data to reports.
const Anthropic = require('@anthropic-ai/sdk');
const XLSX = require('xlsx');
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

async function dbxList(suffix) {
  const r = await fetch('https://api.dropboxapi.com/2/files/list_folder', { method:'POST',
    headers:{Authorization:`Bearer ${process.env.DROPBOX_TOKEN}`,'Content-Type':'application/json'},
    body: JSON.stringify({ path: `${process.env.DROPBOX_BASE}${suffix}` }) });
  if (!r.ok) return [];
  return (await r.json()).entries.filter(e => e['.tag'] === 'file');
}
async function dbxDownloadBuf(suffix) {
  const r = await fetch('https://content.dropboxapi.com/2/files/download', { method:'POST',
    headers:{Authorization:`Bearer ${process.env.DROPBOX_TOKEN}`,'Dropbox-API-Arg':JSON.stringify({path:`${process.env.DROPBOX_BASE}${suffix}`})}});
  return r.ok ? Buffer.from(await r.arrayBuffer()) : null;
}
async function processInbox() {
  const files = await dbxList('/Data/Inbox');
  const findings = [];
  for (const f of files.slice(0, 3)) {                 // max 3 per run, keeps cost tiny
    try {
      const buf = await dbxDownloadBuf(`/Data/Inbox/${f.name}`);
      let structure = `filename: ${f.name}, size: ${f.size}`;
      if (/\.(xlsx|xls|csv)$/i.test(f.name)) {
        const wb = XLSX.read(buf);
        structure += `\nsheets: ${wb.SheetNames.join(', ')}`;
        const ws = wb.Sheets[wb.SheetNames[0]];
        const rows = XLSX.utils.sheet_to_json(ws, { header: 1 }).slice(0, 8);
        structure += `\nfirst rows of "${wb.SheetNames[0]}":\n` + rows.map(r => (r||[]).slice(0,14).join(' | ')).join('\n');
      }
      const m = await anthropic.messages.create({ model: require('../config/models.json').gather, max_tokens: 500,
        messages: [{ role:'user', content: `A new business data file arrived for a plus-size retail analytics system. Based on its structure, draft a one-paragraph registry entry: what the file appears to be, which sheet/columns matter, a proposed home under /Data/<Category>/, and which daily report (Shopify sales / Stores / Returns / Weather / Messaging / Reorders) could consume it. Flag anything ambiguous a human must confirm.\n\n${structure}` }] });
      findings.push({ file: f.name, analysis: m.content.find(c=>c.type==='text')?.text || '' });
    } catch (e) { findings.push({ file: f.name, error: e.message }); }
  }
  return findings;   // surfaced in the confirmation email; registration stays HUMAN-approved
}
module.exports = { processInbox };
