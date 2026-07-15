#!/usr/bin/env node
// Build a plain static HTML page from episodes.csv.
//
//   node build-html.js            # reads episodes.csv -> writes index.html
//   node build-html.js out.html   # custom output path
//
// Output is a title + an unordered list, newest episode first:
//   #375. <a href="...">David Hockney</a>

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CSV_PATH = path.join(HERE, "episodes.csv");
const OUT_PATH = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.join(HERE, "index.html");
const TITLE = "On Taking Pictures — Photographer of the Week";

// Minimal RFC-4180 CSV parser (handles quotes, embedded commas/newlines).
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += c;
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ",") {
      row.push(field); field = "";
    } else if (c === "\n") {
      row.push(field); rows.push(row); row = []; field = "";
    } else if (c === "\r") {
      // ignore; \n ends the line
    } else field += c;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows;
}

function escapeHtml(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

if (!fs.existsSync(CSV_PATH)) {
  console.error(`No ${CSV_PATH} found. Run the scraper first (npm run backfill).`);
  process.exit(1);
}

const rows = parseCsv(fs.readFileSync(CSV_PATH, "utf8"));
const episodes = rows
  .slice(1) // drop header
  .filter((r) => Number.isInteger(Number(r[0])))
  .map((r) => ({ number: Number(r[0]), url: r[1], photographer: r[2] }))
  .sort((a, b) => b.number - a.number); // newest first

const items = episodes
  .map((ep) => {
    const names = (ep.photographer || "")
      .split(/\s*;\s*/)
      .map((n) => n.trim())
      .filter(Boolean);
    const href = escapeHtml(ep.url);
    const inner = names.length
      ? names.map((n) => `<a href="${href}">${escapeHtml(n)}</a>`).join(", ")
      : `<a href="${href}">(no Photographer of the Week)</a>`;
    return `<li>#${ep.number}. ${inner}</li>`;
  })
  .join("\n");

const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(TITLE)}</title>
<style>
  body { font-family: system-ui, sans-serif; line-height: 1.5; margin: 2rem; }
  h1 { font-size: 1.4rem; }
  /* Fit as many ~20rem columns as the viewport allows; reflows on resize. */
  ul { list-style: none; padding: 0; column-width: 20rem; column-gap: 2.5rem; }
  li { break-inside: avoid; margin: 0 0 .35rem; }
</style>
</head>
<body>
<h1>${escapeHtml(TITLE)}</h1>
<ul>
${items}
</ul>
</body>
</html>
`;

fs.writeFileSync(OUT_PATH, html);
console.log(`Wrote ${OUT_PATH} with ${episodes.length} episodes.`);
