# On Taking Pictures — Photographer of the Week

A single static page, `index.html`, listing every Photographer of the Week from
the [On Taking Pictures](https://ontakingpictures.com/) podcast. No build step,
no JavaScript. Published by GitHub Pages at https://mikesub.github.io/otp/ on
push to `main`.

## Adding a new episode

You need three things, all from the episode's post on ontakingpictures.com:

- the episode number
- the episode URL
- the photographer's name — the post says "X is our Photographer of the Week"

The list is grouped by year, newest first. Add the entry at the **top** of the
first `<ul>` (directly under the newest `<h2>`), matching the existing entries
exactly:

```html
            <li>
                <span>382</span>
                <a href="https://ontakingpictures.com/2026/10/382-some-title/">Name</a>
            </li>
```

The year comes from the `/YYYY/MM/` in the episode URL, not from today's date.
If it's the first episode of a new year, add a new heading and list above the
previous year's:

```html
        <h2 id="2027">2027</h2>
        <ul>
            <li>…</li>
        </ul>
```

Edge cases:

- No photographer that week: use `—` as the name, still linking to the episode.
- Two photographers: `First Person and Second Person`.
- Escape HTML in names (`&amp;`, `&#39;`).
- Numbers run 1 to latest with no gaps or duplicates; check the new number is
  exactly one more than the current top entry.

Touch only the new entry: don't reformat or reorder the rest of the file.

## Committing

One commit per episode, and the commit message is just the episode number
(e.g. `382`). Push to `origin main` to publish.
