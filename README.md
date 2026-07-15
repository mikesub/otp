# On Taking Pictures — Photographer of the Week scraper

Scrapes [ontakingpictures.com](https://ontakingpictures.com/) and records, for each
podcast episode, the **Photographer of the Week**. The mention is phrased differently
in every episode (e.g. `Bastiaan Woudt is our Photographer of the Week`,
`PHOTOGRAPHER of the WEEK: Yousuf Karsh`, a `PotW – Name` show-notes link…), so the
whole episode description is handed to **Claude Haiku**, which returns the name.

Plain `fetch`, no headless browser. **Zero npm dependencies** — the model call goes
through your local `claude` CLI, so there's no API key or `.env` to manage.

## Requirements

- Node 21+ (uses built-in `fetch`)
- The `claude` CLI installed and logged in (`claude` must run from your shell)

## Usage

```bash
npm run backfill     # one-time: walk every archive page (/, /page/2 … ) → ~375 episodes
npm run scrape       # the cron run: front page only, adds any episodes not in the db
npm run dry-run      # parse + print what would be processed; no model call, no writes
```

`npm run scrape` is the cron job: it reads the front page, finds episodes missing
from `episodes.csv`, asks Haiku for each one, and appends them — normally just the one
or two newest. Run `npm run backfill` once at the start to fill the full archive; it's
resumable (already-stored episodes are skipped), so re-run it if interrupted.

To re-extract one specific episode (e.g. to correct a bad row), pass its page URL — it
upserts that episode's row in place:

```bash
node update-episode.js https://ontakingpictures.com/2014/06/on-taking-pictures-113-a-day-late-a-dollar-short/
node update-episode.js <url1> <url2> ...   # several at once
```

It rewrites the whole CSV, so don't run it while a backfill is writing the file.

Example cron entry (hourly):

```cron
0 * * * * cd /Users/mikesub/devenv/otp && /usr/bin/env node scrape.js >> scrape.log 2>&1
```

## Output

- **`episodes.csv`** — the database. Columns: `episode_number,episode_url,photographer`.
  The two hosts often each pick a Photographer of the Week, so an episode can have
  more than one — multiple names are stored in the `photographer` column joined by
  `; ` (e.g. `Mathew Brady; Alexander Gardner`). Episodes with none get an empty
  field, so they're still recorded and not re-fetched every run.
- **`last_episode.txt`** — the highest episode number stored.

Dedup is by episode number present in `episodes.csv`, so runs are idempotent.

## How it works

1. Fetch the page(s), trim everything from the pagination footer (`id="nav-below"`)
   onward, and split out each post by its `rel="bookmark"` title link (`#NNN: Title`),
   which yields the episode number and URL.
2. Strip each post body to plain text (the full description + show notes — the
   Photographer of the Week can appear anywhere in it).
3. Pipe that text to `claude -p --model haiku` with a fixed extraction system prompt
   and read back the name (or `NONE`).
4. Append new rows to the CSV and update `last_episode.txt`.

The next step (per the project plan) is a small HTML page generated from `episodes.csv`.
