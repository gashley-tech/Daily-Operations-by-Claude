// DYNAMIC REPORT REGISTRY — reports are defined as .md files in Dropbox /agent.skill/reports/
// Adding/editing/disabling a report = editing Dropbox. No redeploy. Same command daily.
//
// Definition file format (Markdown with a JSON frontmatter block):
// ```json
// { "key": "R6_Reorders", "title": "Reorder Candidates", "enabled": true,
//   "recipients": ["sam@gashley.com"], "schedule_days": ["Mon"],   // omit = every day
//   "sources": ["shopify","watchtower","weather","prior"] }
// ```
// ...followed by the report's template/instructions in plain markdown.

async function dbx(pathSuffix, raw) {
  const r = await fetch('https://content.dropboxapi.com/2/files/download', {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.DROPBOX_TOKEN}`,
      'Dropbox-API-Arg': JSON.stringify({ path: `${process.env.DROPBOX_BASE}${pathSuffix}` }) }
  });
  return r.ok ? await r.text() : null;
}
async function dbxList(folderSuffix) {
  const r = await fetch('https://api.dropboxapi.com/2/files/list_folder', {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.DROPBOX_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: `${process.env.DROPBOX_BASE}${folderSuffix}` })
  });
  if (!r.ok) return [];
  return (await r.json()).entries.filter(e => e['.tag'] === 'file' && e.name.endsWith('.md')).map(e => e.name);
}

async function loadReportDefinitions() {
  const files = await dbxList('/agent.skill/reports');
  const defs = [];
  for (const f of files) {
    const text = await dbx(`/agent.skill/reports/${f}`);
    if (!text) continue;
    const m = text.match(/```json\s*([\s\S]*?)```/);
    if (!m) continue;
    try {
      const meta = JSON.parse(m[1]);
      const template = text.slice(text.indexOf('```', m.index + 3) + 3).trim();
      defs.push({ ...meta, template, file: f });
    } catch (e) { defs.push({ key: f, error: `bad frontmatter: ${e.message}` }); }
  }
  // day-of-week filter (e.g. Monday-only reorder report)
  const dow = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][new Date().getDay()];
  return defs.filter(d => d.enabled !== false && (!d.schedule_days || d.schedule_days.includes(dow)));
}
async function loadAllDefinitions() {
  const files = await dbxList('/agent.skill/reports');
  const defs = [];
  for (const f of files) {
    const text = await dbx(`/agent.skill/reports/${f}`);
    const m = text && text.match(/```json\s*([\s\S]*?)```/);
    if (m) { try { defs.push(JSON.parse(m[1])); } catch(_){} }
  }
  return defs;
}
module.exports = { loadReportDefinitions, loadAllDefinitions, dbx };
