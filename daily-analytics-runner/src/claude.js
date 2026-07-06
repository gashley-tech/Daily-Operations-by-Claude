// Sonnet 4.6 generation with PROMPT CACHING. One call generates ALL of today's enabled
// reports (definitions loaded from Dropbox at runtime), each wrapped in <!--REPORT:key--> markers.
const Anthropic = require('@anthropic-ai/sdk');
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

async function generateReports(ctx, defs) {
  const system = [
    { type: 'text',
      text: `You are the Ashley Stewart daily analytics engine. Follow Daily_Operation.md EXACTLY (locked templates, LESSONS block, RED recommendations as <span style="color:#C41E3A;font-weight:bold">, QA block ending every report). Output each report as Word-compatible HTML wrapped in <!--REPORT:key--> ... <!--END--> markers.\n\n=== Daily_Operation.md ===\n${ctx.agentFile}\n\n=== Promo Calendar ===\n${ctx.calendar}`,
      cache_control: { type: 'ephemeral' } }
  ];
  const defList = defs.map(d => `<!--REPORT:${d.key}--> ${d.title}\nTEMPLATE/INSTRUCTIONS:\n${d.template}`).join('\n\n---\n\n');
  const user = `Date: ${ctx.today}. Generate the following ${defs.length} reports (keys and templates below). Declare any source you did not receive as MISSING in each source-status line. No invented numbers.\n\n=== TODAY'S REPORT DEFINITIONS ===\n${defList}\n\n=== SOURCE DATA ===\n[Prior day reports]\n${(ctx.priorReports||'').slice(0,8000)}\n\n[Shopify day close]\n${JSON.stringify(ctx.dayClose).slice(0,4000)}\n\n[Categories]\n${JSON.stringify(ctx.categories).slice(0,4000)}\n\n[Watchtower]\n${(ctx.watchtower||'').slice(0,4000)}\n\n[Weather shaped]\n${ctx.weatherCompact}`;
  const msg = await anthropic.messages.create({
    model: require('../config/models.json').generate, max_tokens: 32000, system,
    messages: [{ role: 'user', content: user }]
  });
  const text = msg.content.find(c => c.type === 'text')?.text || '';
  const reports = {};
  for (const d of defs) {
    const seg = text.split(`<!--REPORT:${d.key}-->`)[1];
    reports[d.key] = seg ? seg.split('<!--')[0].trim() : null;
  }
  return { reports, usage: msg.usage };
}
module.exports = { generateReports };
