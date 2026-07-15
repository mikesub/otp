#!/usr/bin/env node
// Re-extract the Photographer(s) of the Week for one or more specific episodes and
// update episodes.csv in place. Pass each episode's page URL:
//
//   node update-episode.js https://ontakingpictures.com/2014/06/on-taking-pictures-113-a-day-late-a-dollar-short/
//   node update-episode.js <url1> <url2> ...
//
// Upserts by episode number — an existing row is replaced, a new one is added.
// Uses your local `claude` CLI (no API key). Do NOT run while a backfill is
// writing the CSV; this rewrites the whole file.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CSV_PATH = path.join(HERE, "episodes.csv");
const CSV_HEADER = "episode_number,episode_url,photographer";
const USER_AGENT = "Mozilla/5.0 (compatible; OTP-Scraper/1.0; +podcast archive)";
const MODEL = "haiku";
const MAX_BODY_CHARS = 15000;

const urls = process.argv.slice(2).filter((a) => /^https?:\/\//.test(a));
if (urls.length === 0) {
  console.error("Usage: node update-episode.js <episode-url> [more-urls...]");
  process.exit(1);
}

// ---------------------------------------------------------------------------
// HTML parsing (same approach as scrape.js)
// ---------------------------------------------------------------------------
const NAMED_ENTITIES = {
  "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&apos;": "'",
  "&nbsp;": " ", "&hellip;": "…", "&mdash;": "—", "&ndash;": "–",
  "&rsquo;": "’", "&lsquo;": "‘", "&ldquo;": "“", "&rdquo;": "”",
};

function safeCodePoint(n) {
  try { return String.fromCodePoint(n); } catch { return ""; }
}

function decodeEntities(s) {
  return s
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => safeCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => safeCodePoint(parseInt(d, 10)))
    .replace(/&[a-zA-Z]+;/g, (m) => NAMED_ENTITIES[m] ?? m);
}

function stripTags(html) {
  return decodeEntities(
    html
      .replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, " ")
      .replace(/<[^>]+>/g, " ")
  )
    .replace(/\s+/g, " ")
    .trim();
}

function episodeNumber(title, url) {
  let m = decodeEntities(title).match(/#\s*0*(\d+)/);
  if (m) return Number(m[1]);
  m = url.match(/(?:podcast-)?on-taking-pictures-0*(\d+)/);
  if (m) return Number(m[1]);
  m = url.match(/\/0*(\d+)-[a-z]/);
  if (m) return Number(m[1]);
  return null;
}

const ANCHOR_RE =
  /<a href="(https:\/\/(?:www\.)?ontakingpictures\.com\/20\d{2}\/\d{2}\/[^"]+?)"\s+rel="bookmark">([\s\S]*?)<\/a>/;

// A single-episode page has no pagination footer; cut at whatever ends the post
// (comments / sidebar widgets / footer) so that chrome doesn't leak into the body.
function trimChrome(html) {
  const markers = [
    'id="nav-below"', 'id="comments"', 'id="respond"',
    'class="widget', 'id="sidebar"', 'id="footer"', "<footer",
  ];
  let cut = html.length;
  for (const mk of markers) {
    const i = html.indexOf(mk);
    if (i !== -1 && i < cut) cut = i;
  }
  return html.slice(0, cut);
}

// Parse the first episode post out of a page (the post itself on a permalink page).
function parseFirstEpisode(html) {
  html = trimChrome(html);
  const chunks = html.split('<div class="posttitle">');
  for (let i = 1; i < chunks.length; i++) {
    const chunk = chunks[i];
    const a = chunk.match(ANCHOR_RE);
    if (!a) continue;
    const url = a[1].replace("://www.", "://");
    const number = episodeNumber(a[2], url);
    if (number == null) continue;
    const paIdx = chunk.indexOf('<div class="postarea"');
    const body = stripTags(paIdx === -1 ? chunk : chunk.slice(paIdx)).slice(0, MAX_BODY_CHARS);
    return { number, url, body };
  }
  return null;
}

// ---------------------------------------------------------------------------
// CSV (same minimal parser/escaper as scrape.js)
// ---------------------------------------------------------------------------
function csvEscape(field) {
  const s = String(field ?? "");
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

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
      // ignore
    } else field += c;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows;
}

// ---------------------------------------------------------------------------
// Claude (same prompt as scrape.js — keep them in sync)
// ---------------------------------------------------------------------------
const PROMPT = `You read the show notes / description of one episode of the photography podcast "On Taking Pictures".

The two hosts each often choose a "Photographer of the Week" — written many ways: "Photographer of the Week", "PHOTOGRAPHER of the WEEK", "Photographers of the Week", "PotW", "our photographer of the week", "X is our PotW", a "PotW - X" show-notes link, etc. So a single episode may name ONE, TWO, or occasionally more. The mention can appear anywhere in the text.

List the full name of EVERY photographer this episode explicitly designates as a Photographer of the Week — one name per line, with nothing else on the line. Do NOT include photographers or other artists who are merely mentioned in the show notes but are not named as a Photographer of the Week.

If the episode designates none, reply with exactly: NONE`;

function runClaude(systemPrompt, userText) {
  return new Promise((resolve, reject) => {
    const child = spawn("claude", [
      "-p",
      "--model", MODEL,
      "--output-format", "json",
      "--system-prompt", systemPrompt,
    ]);
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) reject(new Error(`claude exited ${code}: ${(err || out).trim().slice(0, 200)}`));
      else resolve(out);
    });
    child.stdin.end(userText);
  });
}

function cleanNames(result) {
  const parts = result.split(/\r?\n|,|\s+&\s+|\s+\band\b\s+/i);
  const seen = new Set();
  const names = [];
  for (let p of parts) {
    p = p
      .replace(/^[\s*\-–—•\d.)]+/, "")
      .replace(/^["'“”]+|["'“”]+$/g, "")
      .replace(/\.+$/, "")
      .trim();
    if (!p || /^none$/i.test(p)) continue;
    const key = p.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    names.push(p);
  }
  return names;
}

async function extractPhotographers(body) {
  const out = await runClaude(PROMPT, body);
  let text = out.trim();
  try {
    text = String(JSON.parse(out).result ?? "").trim();
  } catch {
    /* fall back to raw stdout */
  }
  return cleanNames(text);
}

async function fetchHtml(url) {
  const res = await fetch(url, { headers: { "User-Agent": USER_AGENT } });
  if (!res.ok) throw new Error(`GET ${url} -> ${res.status} ${res.statusText}`);
  return res.text();
}

// ---------------------------------------------------------------------------
// Main — fetch each URL, re-extract, upsert into the CSV, rewrite sorted.
// ---------------------------------------------------------------------------
async function main() {
  const byNumber = new Map(); // number -> { url, photographer }
  if (fs.existsSync(CSV_PATH)) {
    for (const r of parseCsv(fs.readFileSync(CSV_PATH, "utf8")).slice(1)) {
      const n = Number(r[0]);
      if (Number.isInteger(n)) byNumber.set(n, { url: r[1] ?? "", photographer: r[2] ?? "" });
    }
  }

  for (const inputUrl of urls) {
    const html = await fetchHtml(inputUrl);
    const ep = parseFirstEpisode(html);
    if (!ep) {
      console.warn(`! ${inputUrl}: could not find an episode post on that page`);
      continue;
    }
    const photographer = (await extractPhotographers(ep.body)).join("; ");
    const prev = byNumber.get(ep.number)?.photographer;
    byNumber.set(ep.number, { url: ep.url, photographer });

    let status = "added";
    if (prev !== undefined) status = prev === photographer ? "unchanged" : `updated (was "${prev}")`;
    console.log(`#${ep.number}: ${photographer || "(no Photographer of the Week)"}  [${status}]`);
  }

  const numbers = [...byNumber.keys()].sort((a, b) => a - b);
  const lines = [CSV_HEADER];
  for (const n of numbers) {
    const { url, photographer } = byNumber.get(n);
    lines.push([csvEscape(n), csvEscape(url), csvEscape(photographer)].join(","));
  }
  fs.writeFileSync(CSV_PATH, lines.join("\n") + "\n");
  console.log(`Wrote ${CSV_PATH} (${numbers.length} episodes).`);
}

main().catch((err) => {
  if (err?.code === "ENOENT") {
    console.error("\n`claude` CLI not found on PATH. Install Claude Code so that `claude` runs, then retry.\n");
  } else {
    console.error("\nError:", err.message);
  }
  process.exit(1);
});
