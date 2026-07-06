// Data gathering. Direct API pulls; Haiku is used to SHAPE noisy text (emails/PDF text) into compact JSON.
const Anthropic = require('@anthropic-ai/sdk');
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

async function shopifyQL(query) {
  const r = await fetch(`https://${process.env.SHOPIFY_STORE}/admin/api/2025-01/graphql.json`, {
    method: 'POST',
    headers: { 'X-Shopify-Access-Token': process.env.SHOPIFY_TOKEN, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: `query { shopifyqlQuery(query: ${JSON.stringify(query)}) { __typename ... on TableResponse { tableData { rowData columns { name } } } } }` })
  });
  return (await r.json());
}

async function dropboxRead(path) {
  const r = await fetch('https://content.dropboxapi.com/2/files/download', {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.DROPBOX_TOKEN}`,
      'Dropbox-API-Arg': JSON.stringify({ path: `${process.env.DROPBOX_BASE}${path}` }) }
  });
  return r.ok ? await r.text() : `(missing: ${path})`;
}

async function haikuShape(label, rawText) {
  // Compress noisy raw source text into compact JSON via the cheap model.
  const msg = await anthropic.messages.create({
    model: require('../config/models.json').gather, max_tokens: 2000,
    messages: [{ role: 'user', content: `Extract the key figures from this ${label} as compact JSON (numbers, dates, names only, no prose):\n\n${rawText.slice(0, 30000)}` }]
  });
  return msg.content.find(c => c.type === 'text')?.text || '{}';
}

async function gatherAll() {
  const today = new Date().toISOString().slice(0, 10);
  const [agentFile, calendar, watchtower, weather] = await Promise.all([
    dropboxRead('/agent.skill/Daily_Operation.md'),
    dropboxRead('/Calendar/FY2026_Promo_Summary_Jul5-23.md'),
    fetch(process.env.WATCHTOWER_URL).then(r => r.text()).catch(e => `(watchtower error: ${e.message})`),
    fetch('https://api.weather.gov/alerts/active?area=NJ,PA,NY,MD,GA,IL,MI,OH,VA,NC,TX,FL').then(r => r.text()).catch(e => '(nws error)')
  ]);
  // Shopify pulls (yesterday close + categories + returns)
  const y = new Date(Date.now() - 864e5).toISOString().slice(0, 10);
  const [dayClose, categories] = await Promise.all([
    shopifyQL(`FROM sales SHOW net_sales, gross_sales, orders SINCE ${y} UNTIL ${y}`),
    shopifyQL(`FROM sales SHOW net_sales, returns GROUP BY product_type SINCE ${y} UNTIL ${y} ORDER BY net_sales DESC LIMIT 12`)
  ]);
  // TODO (IT-6): mailbox feeds (Hourly Order Counts, KPI PDF, POS) via MS Graph once app credentials exist.
  const weatherCompact = await haikuShape('NWS alerts feed (keep only alerts for NJ PA NY MD GA IL MI OH VA NC TX FL store states)', weather);
  const priorReports = await dropboxRead(`/Daily/${y}/Daily_Reports_${y}_ALL.md`);
  const teamFeedback = await dropboxRead('/Feedback/Feedback_CURRENT.md') || '(no team feedback yet)';
  return { today, agentFile, calendar, watchtower, weatherCompact, dayClose, categories, priorReports, teamFeedback };
}
module.exports = { gatherAll };
