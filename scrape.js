#!/usr/bin/env node
// Scraper for https://ontakingpictures.com/
//
// Fetches the front page (or, with --backfill, every archive page), extracts each
// episode's full description, and asks Claude (via the `claude -p` CLI) who the
// "Photographer of the Week" is. New episodes are appended to episodes.csv and the
// highest episode number is written to last_episode.txt.
//
// Usage:
//   node scrape.js                 # front page only — the normal cron run
//   node scrape.js --backfill      # walk every archive page to populate the db
//   node scrape.js --dry-run       # parse + print, no model call, no CSV write
//   node scrape.js --backfill --max-pages 40
//
// Auth: uses your local `claude` CLI login — no API key or .env needed.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BASE = "https://ontakingpictures.com";
const CSV_PATH = path.join(HERE, "episodes.csv");
const LAST_PATH = path.join(HERE, "last_episode.txt");
const CSV_HEADER = "episode_number,episode_url,photographer";
const USER_AGENT = "Mozilla/5.0 (compatible; OTP-Scraper/1.0; +podcast archive)";
const MODEL = "haiku";
const MAX_BODY_CHARS = 15000; // whole post body; generous so the mention is never cut off

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------
const args = process.argv.slice(2);
const BACKFILL = args.includes("--backfill");
const DRY_RUN = args.includes("--dry-run");
const MAX_PAGES = args.includes("--max-pages") ? Number(args[args.indexOf("--max-pages") + 1]) : 60;

// ---------------------------------------------------------------------------
// HTML helpers
// ---------------------------------------------------------------------------
const NAMED_ENTITIES = {
  "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&apos;": "'",
  "&nbsp;": " ", "&hellip;": "…", "&mdash;": "—", "&ndash;": "–",
  "&rsquo;": "’", "&lsquo;": "‘", "&ldquo;": "“", "&rdquo;": "”",
};

function decodeEntities(s) {
  return s
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => safeCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => safeCodePoint(parseInt(d, 10)))
    .replace(/&[a-zA-Z]+;/g, (m) => NAMED_ENTITIES[m] ?? m);
}

function safeCodePoint(n) {
  try {
    return String.fromCodePoint(n);
  } catch {
    return "";
  }
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
  m = url.match(/podcast-on-taking-pictures-0*(\d+)/);
  if (m) return Number(m[1]);
  m = url.match(/\/0*(\d+)-[a-z]/);
  if (m) return Number(m[1]);
  return null;
}

// Parse all episode posts out of an archive/front page.
// Returns [{ number, url, title, body }] in document order (newest first).
//
// Each post is: <div class="posttitle"> #NNN title + author </div>
//               <div class="postarea"> …description + show notes… </div>
// (new posts also wrap the whole thing in an outer <div class="postarea">).
// We split on the title block, then take that post's own content "postarea"
// div — the first one inside the post — and hand its text to the model.
const ANCHOR_RE =
  /<a href="(https:\/\/(?:www\.)?ontakingpictures\.com\/20\d{2}\/\d{2}\/[^"]+?)"\s+rel="bookmark">([\s\S]*?)<\/a>/;

function parseEpisodes(html) {
  // Drop everything from the pagination footer onward (sidebar, footer, etc.)
  // so the last post on the page isn't polluted with non-episode text.
  const navIdx = html.indexOf('id="nav-below"');
  if (navIdx !== -1) html = html.slice(0, navIdx);

  const episodes = [];
  // chunks[0] is the page header; chunks[1..] each start one post.
  const chunks = html.split('<div class="posttitle">');
  for (let i = 1; i < chunks.length; i++) {
    const chunk = chunks[i];

    const a = chunk.match(ANCHOR_RE);
    if (!a) continue;
    const url = a[1].replace("://www.", "://"); // normalise to bare host
    const title = stripTags(a[2]);
    const number = episodeNumber(a[2], url);
    if (number == null) continue; // not a numbered episode (e.g. a stray blog post)

    // The post's content is the first "postarea" div after the title; it runs to
    // the next post (chunk boundary). Falls back to the whole chunk if not found.
    const paIdx = chunk.indexOf('<div class="postarea"');
    const content = paIdx === -1 ? chunk : chunk.slice(paIdx);
    const body = stripTags(content).slice(0, MAX_BODY_CHARS);

    episodes.push({ number, url, title, body });
  }
  return episodes;
}

// ---------------------------------------------------------------------------
// CSV helpers
// ---------------------------------------------------------------------------
function csvEscape(field) {
  const s = String(field ?? "");
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

// Minimal RFC-4180 parser (handles quotes, embedded commas/newlines).
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
      // ignore; \n handles the line break
    } else field += c;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows;
}

function loadExistingNumbers() {
  if (!fs.existsSync(CSV_PATH)) return new Set();
  const rows = parseCsv(fs.readFileSync(CSV_PATH, "utf8"));
  const numbers = new Set();
  for (const r of rows) {
    const n = Number(r[0]);
    if (Number.isInteger(n)) numbers.add(n);
  }
  return numbers;
}

function appendRow(ep) {
  if (!fs.existsSync(CSV_PATH)) {
    fs.writeFileSync(CSV_PATH, CSV_HEADER + "\n");
  }
  const line =
    [csvEscape(ep.number), csvEscape(ep.url), csvEscape(ep.photographer)].join(",") + "\n";
  fs.appendFileSync(CSV_PATH, line);
}

function updateLastEpisode(numbers) {
  if (numbers.size === 0) return;
  fs.writeFileSync(LAST_PATH, String(Math.max(...numbers)) + "\n");
}

// ---------------------------------------------------------------------------
// Fetching
// ---------------------------------------------------------------------------
async function fetchHtml(url) {
  const res = await fetch(url, { headers: { "User-Agent": USER_AGENT } });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`GET ${url} -> ${res.status} ${res.statusText}`);
  return res.text();
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Claude (via the `claude -p` CLI — uses your local login, no API key)
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
    child.on("error", reject); // ENOENT if `claude` isn't on PATH
    child.on("close", (code) => {
      if (code !== 0) reject(new Error(`claude exited ${code}: ${(err || out).trim().slice(0, 200)}`));
      else resolve(out);
    });
    child.stdin.end(userText);
  });
}

// Split the model's reply (names, ideally one per line) into clean, de-duplicated
// full names. Tolerates stray bullets/numbers and inline "A, B" / "A and B" lists.
function cleanNames(result) {
  const parts = result.split(/\r?\n|,|\s+&\s+|\s+\band\b\s+/i);
  const seen = new Set();
  const names = [];
  for (let p of parts) {
    p = p
      .replace(/^[\s*\-–—•\d.)]+/, "")    // leading bullets / "1." / "-"
      .replace(/^["'“”]+|["'“”]+$/g, "")  // surrounding quotes
      .replace(/\.+$/, "")                 // trailing period
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
    text = String(JSON.parse(out).result ?? "").trim(); // --output-format json envelope
  } catch {
    /* fall back to raw stdout */
  }
  return cleanNames(text);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function collectEpisodes() {
  if (!BACKFILL) {
    const html = await fetchHtml(`${BASE}/`);
    return parseEpisodes(html);
  }
  const all = [];
  const seenUrls = new Set();
  for (let page = 1; page <= MAX_PAGES; page++) {
    const url = page === 1 ? `${BASE}/` : `${BASE}/page/${page}/`;
    const html = await fetchHtml(url);
    if (!html) break; // 404 -> past the last page
    const eps = parseEpisodes(html);
    if (eps.length === 0) break;
    let added = 0;
    for (const ep of eps) {
      if (seenUrls.has(ep.url)) continue;
      seenUrls.add(ep.url);
      all.push(ep);
      added++;
    }
    console.log(`page ${page}: ${eps.length} episodes (${added} new on page)`);
    if (added === 0) break; // fully overlapping page -> nothing left to find
    await sleep(400); // be polite
  }
  return all;
}

async function main() {
  console.log(BACKFILL ? "Mode: backfill (all archive pages)" : "Mode: front page");
  const existing = loadExistingNumbers();
  console.log(`Already in db: ${existing.size} episodes`);

  const parsed = await collectEpisodes();
  const fresh = parsed
    .filter((ep) => !existing.has(ep.number))
    .sort((a, b) => a.number - b.number);

  console.log(`Found ${parsed.length} episodes on site, ${fresh.length} new.`);

  if (DRY_RUN) {
    for (const ep of fresh) {
      console.log(`\n#${ep.number}  ${ep.url}`);
      console.log(`  ${ep.body.slice(0, 200)}...`);
    }
    console.log(`\n[dry-run] ${fresh.length} episode(s) would be processed. No CSV written.`);
    return;
  }

  if (fresh.length === 0) {
    console.log("Nothing new. Done.");
    return;
  }

  for (const ep of fresh) {
    try {
      ep.photographer = (await extractPhotographers(ep.body)).join("; ");
    } catch (err) {
      if (err?.code === "ENOENT") throw err; // `claude` missing — affects every episode
      console.warn(`  ! #${ep.number}: extraction failed (${err.message}); will retry next run`);
      continue; // leave it out of the db so it's reprocessed next time
    }
    appendRow(ep);
    existing.add(ep.number);
    updateLastEpisode(existing);
    console.log(`  + #${ep.number}: ${ep.photographer || "(no Photographer of the Week)"}`);
  }

  console.log(`Done. db now holds ${existing.size} episodes; last = ${Math.max(...existing)}.`);
}

main().catch((err) => {
  if (err?.code === "ENOENT") {
    console.error("\n`claude` CLI not found on PATH. Install Claude Code so that `claude` runs, then retry.\n");
  } else {
    console.error("\nError:", err.message);
  }
  process.exit(1);
});
