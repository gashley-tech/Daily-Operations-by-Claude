// MCP-based generation: Claude queries Shopify itself via the MCP connector
// during report generation — no gather-side Shopify code needed.
const Anthropic = require('@anthropic-ai/sdk');
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

async function generateReportsMCP(ctx, defs) {
  const system = [
    { type: 'text',
      text: `You are the Ashley Stewart daily analytics engine. Follow Daily_Operation.md EXACTLY (locked templates, LESSONS block, RED recommendations, QA block per report). You have a Shopify MCP connector — pull yesterday's sales, categories, and returns yourself (net_sales, orders, returns by product_type; ShopifyQL where available). Output each report as Word-compatible HTML wrapped in <!--REPORT:key--> markers.\n\n=== Daily_Operation.md ===\n${ctx.agentFile}\n\n=== Promo Calendar ===\n${ctx.calendar}`,
      cache_control: { type: 'ephemeral' } }
  ];
  const defList = defs.map(d => `<!--REPORT:${d.key}-->\n${d.title}\n${d.template}`).join('\n\n---\n\n');
  const msg = await anthropic.messages.create({
    model: require('../config/models.json').generate,
    max_tokens: 32000,
    system,
    messages: [{ role: 'user', content:
      `Date: ${ctx.today}. Generate these ${defs.length} reports. Use the Shopify MCP tools for all Shopify data. Declare any source you could not retrieve as MISSING. No invented numbers.\n\n=== DEFINITIONS ===\n${defList}\n\n=== NON-SHOPIFY SOURCES ===\n[Prior reports]\n${(ctx.priorReports||'').slice(0,8000)}\n\n[Watchtower]\n${(ctx.watchtower||'').slice(0,4000)}\n\n[Weather]\n${ctx.weatherCompact}` }],
    mcp_servers: [{
      type: 'url',
      url: process.env.SHOPIFY_MCP_URL || 'https://setup.shopify.com/mcp',
      name: 'shopify',
      authorization_token: process.env.SHOPIFY_MCP_TOKEN
    }]
  });
  // MCP responses interleave text / mcp_tool_use / mcp_tool_result blocks — join ALL text blocks
  const text = msg.content.filter(c => c.type === 'text').map(c => c.text).join('\n');
  const reports = {};
  for (const d of defs) {
    const seg = text.split(`<!--REPORT:${d.key}-->`)[1];
    reports[d.key] = seg ? seg.split('<!--')[0].trim() : null;
  }
  return { reports, usage: msg.usage,
    toolCalls: msg.content.filter(c => c.type === 'mcp_tool_use').map(c => c.name) }; // audit trail
}
module.exports = { generateReportsMCP };
