// Convert each report's rich HTML into a TRUE .docx binary (real Word file, formatting preserved:
// headings, colored tables, callout boxes). Used for both the Dropbox archive and the email attachment.
const HTMLtoDOCX = require('html-to-docx');
async function toDocx(html, title) {
  return await HTMLtoDOCX(html, null, {
    title, orientation: 'portrait',
    margins: { top: 1000, right: 900, bottom: 1000, left: 900 },
    font: 'Arial', fontSize: 21,           // half-points -> 10.5pt body
    table: { row: { cantSplit: true } },
  });
}
module.exports = { toDocx };
