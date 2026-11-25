#!/opt/homebrew/bin/python3 -I
"""Check the On Taking Pictures feed for new episodes and publish them.

Run by launchd (see scripts/net.mikesub.otp-check.plist). For each episode in
the feed that is newer than the top entry in index.html, it asks Claude for
the Photographer of the Week, adds the entry, commits it (message = episode
number), pushes to origin main, and sends a Telegram message.

    check_episode.py            normal run
    check_episode.py --dry-run  show what would be added; no edits, no push, no ping
"""

import html
import json
import re
import subprocess
import sys
import tempfile
import traceback
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
INDEX = REPO / "index.html"
FEED_URL = "https://ontakingpictures.com/feed/"
TG_ENV = Path.home() / ".config" / "tg-bot.env"
CLAUDE = "/opt/homebrew/bin/claude"
GIT = "/opt/homebrew/bin/git"
UA = "Mozilla/5.0 (otp-check)"
NS = {"content": "http://purl.org/rss/1.0/modules/content/"}


def log(msg):
    print(msg, flush=True)


def git(*args):
    return subprocess.run(
        [GIT, *args], cwd=REPO, check=True, capture_output=True, text=True
    ).stdout.strip()


def fetch(url):
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=30) as r:
        return r.read()


def text_of(fragment):
    t = re.sub(r"<[^>]+>", " ", fragment or "")
    return re.sub(r"\s+", " ", html.unescape(t)).strip()


def feed_episodes():
    root = ET.fromstring(fetch(FEED_URL))
    eps = []
    for it in root.iter("item"):
        title = it.findtext("title") or ""
        m = re.match(r"\s*#?(\d+)\b", title)
        if not m:
            continue
        eps.append({
            "num": int(m.group(1)),
            "title": title.strip(),
            "link": (it.findtext("link") or "").strip(),
            "text": text_of(it.findtext("content:encoded", namespaces=NS)
                            or it.findtext("description")),
        })
    return eps


def top_entry(page):
    num = int(re.search(r"<span>(\d+)</span>", page).group(1))
    year = int(re.search(r'<h2 id="(\d{4})">', page).group(1))
    return num, year


PROMPT = """\
You are reading one episode post from the On Taking Pictures photography
podcast. Each episode usually features a "Photographer of the Week".

Find the Photographer of the Week for this episode. Clues, strongest first:
- an explicit line: "X is our Photographer of the Week", "Photographer of the
  Week X", "PotW X", "this week's featured photographer, X"
- otherwise, a photographer credited on the post's image ("© X") who also has
  a link or artist talk listed at the end of the post

A photographer who is only discussed as a topic (an obituary, a documentary, a
show review) is not the Photographer of the Week. If there is none, answer "—".
If there are two, answer "First Person and Second Person".

Reply with JSON only, no code fence:
{{"name": "<name or —>", "confident": true|false, "note": "<one short line on what you based it on>"}}
Set confident to false unless the post says it explicitly.

Episode: {title}
URL: {link}
Post text:
{text}
"""


def ask_photographer(ep):
    prompt = PROMPT.format(**ep)
    with tempfile.TemporaryDirectory() as tmp:
        out = subprocess.run(
            [CLAUDE, "-p", prompt, "--model", "sonnet", "--tools", "",
             "--strict-mcp-config", "--no-session-persistence"],
            cwd=tmp, check=True, capture_output=True, text=True, timeout=300,
        ).stdout
    m = re.search(r"\{.*\}", out, re.S)
    if not m:
        raise RuntimeError(f"Claude gave no JSON for {ep['num']}: {out[:300]}")
    ans = json.loads(m.group(0))
    name = str(ans.get("name", "")).strip()
    if not name:
        raise RuntimeError(f"Claude gave an empty name for {ep['num']}: {out[:300]}")
    return name, bool(ans.get("confident")), str(ans.get("note", "")).strip()


def escape(name):
    return (name.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
                .replace('"', "&quot;").replace("'", "&#39;"))


def add_entry(page, ep, name):
    top_num, top_year = top_entry(page)
    if ep["num"] != top_num + 1:
        raise RuntimeError(f"expected episode {top_num + 1}, got {ep['num']}")
    m = re.search(r"/(\d{4})/\d{2}/", ep["link"])
    if not m:
        raise RuntimeError(f"no /YYYY/MM/ in {ep['link']}")
    year = int(m.group(1))
    li = (
        "            <li>\n"
        f"                <span>{ep['num']}</span>\n"
        f"                <a href=\"{escape(ep['link'])}\">{escape(name)}</a>\n"
        "            </li>\n"
    )
    h2 = f'        <h2 id="{top_year}">{top_year}</h2>\n        <ul>\n'
    if year == top_year:
        return page.replace(h2, h2 + li, 1)
    if year > top_year:
        block = f'        <h2 id="{year}">{year}</h2>\n        <ul>\n{li}        </ul>\n'
        return page.replace(h2, block + h2, 1)
    raise RuntimeError(f"episode {ep['num']} year {year} is older than {top_year}")


def telegram(text):
    env = {}
    for line in TG_ENV.read_text().splitlines():
        if "=" in line and not line.lstrip().startswith("#"):
            k, v = line.split("=", 1)
            env[k.strip()] = v.strip().strip("'\"")
    data = urllib.parse.urlencode({
        "chat_id": env["MY_ID"], "text": text, "disable_web_page_preview": "true",
    }).encode()
    url = f"https://api.telegram.org/bot{env['BOT_TOKEN']}/sendMessage"
    try:
        with urllib.request.urlopen(url, data=data, timeout=30) as r:
            json.load(r)
    except urllib.error.HTTPError as e:
        # Raise without the URL: it contains the bot token.
        reason = json.loads(e.read() or b"{}").get("description", e.reason)
        raise RuntimeError(f"Telegram sendMessage failed: {reason}") from None


def main(dry_run):
    if git("status", "--porcelain", "index.html"):
        raise RuntimeError("index.html has uncommitted changes; not touching it")
    if git("rev-parse", "--abbrev-ref", "HEAD") != "main":
        raise RuntimeError("repo is not on main")
    git("pull", "--ff-only", "--quiet", "origin", "main")
    if not dry_run and git("rev-list", "origin/main..main"):
        git("push", "--quiet", "origin", "main")  # leftovers from a failed run

    page = INDEX.read_text()
    top_num, _ = top_entry(page)
    new = sorted((e for e in feed_episodes() if e["num"] > top_num),
                 key=lambda e: e["num"])
    if not new:
        log(f"no new episode (top is {top_num})")
        return
    if new[0]["num"] != top_num + 1:
        raise RuntimeError(f"feed starts at {new[0]['num']}, site is at {top_num}; "
                           "missing episodes need adding by hand")

    lines = []
    for ep in new:
        name, confident, note = ask_photographer(ep)
        log(f"{ep['num']}: {name} (confident={confident}; {note})")
        page = add_entry(page, ep, name)
        line = f"{ep['num']} — {name}\n{ep['link']}"
        if not confident:
            line += f"\n⚠️ Not sure: {note}"
        lines.append(line)
        if not dry_run:
            INDEX.write_text(page)
            git("add", "index.html")
            git("commit", "--quiet", "-m", str(ep["num"]))

    if dry_run:
        log("dry run: nothing written, pushed or sent")
        return
    git("push", "--quiet", "origin", "main")
    telegram("OTP: published\n\n" + "\n\n".join(lines))
    log("pushed and pinged")


if __name__ == "__main__":
    dry = "--dry-run" in sys.argv
    try:
        main(dry)
    except Exception as e:
        traceback.print_exc()
        if not dry:
            try:
                telegram(f"OTP check failed: {e}\n\nLog: ~/Library/Logs/otp-check.log")
            except Exception:
                traceback.print_exc()
        sys.exit(1)
