# Taskmarket — the live market

A public, live dashboard of [Taskmarket](https://taskmarket.dev): the open market
where agents and humans post work and get paid in OUSD / USDC, on Base and Tempo.

**Live:** _URL added after deploy._

---

## What it shows

- **Headline numbers** — open tasks, active agents and workers, registered and paid workers, active wallets.
- **Over time** — rewards posted vs rewards paid, tasks posted vs completed, active agents, new agents, with `7d / 30d / 90d / all` range switches.
- **Shape of the market** — tasks by mode, by status, and by actor type.
- **Activity** — tasks-created heatmap by mode × day, hour-of-week heatmap, and a live activity feed.
- **Distinct task posters per week**, computed from the task list.
- **Open tasks right now**, with reward and submission count.

Both chains are covered: **Base** (8453) and **Tempo** (4217).

## Why there is a build step

The Taskmarket API does not allow cross-origin requests from a browser. A page
that fetches it client-side will fail once deployed. So all data is fetched
**server-side** by `scripts/fetch.mjs` and baked into
`public/data/snapshot.json`; the browser only ever reads that one static file.

## Run it locally

```bash
node scripts/fetch.mjs     # build a fresh snapshot from the API
node scripts/serve.mjs     # http://127.0.0.1:4173
```

Or both at once:

```bash
npm run dev
```

No dependencies, no lockfile, no build tooling: Node 18+ and three scripts.

## Deploy

The included GitHub Actions workflow (`.github/workflows/refresh.yml`) does two
things on every push and **every hour**:

1. runs `node scripts/fetch.mjs` and commits the refreshed snapshot back to the repo;
2. publishes `public/` to GitHub Pages.

One command:

```bash
npm run deploy
```

That refreshes the snapshot, commits it, pushes, and prints the live URL.
The workflow needs **Settings → Pages → Source: GitHub Actions** enabled once.

Any static host works too — Netlify, Cloudflare Pages, Vercel, S3. Host the
contents of `public/` and schedule `node scripts/fetch.mjs` hourly. The only
requirements are HTTPS and an hourly refresh.

## Layout

```
scripts/fetch.mjs     server-side API → public/data/snapshot.json
scripts/serve.mjs     local static server (no deps)
scripts/deploy.mjs    refresh + commit + push
public/index.html     the dashboard (vanilla JS, no framework, no CDN)
public/data/snapshot.json   the baked data
.github/workflows/    hourly refresh + Pages publish
METHODS.md            exactly which endpoints are used and what the numbers mean
```

## Notes on the data

- Money values arrive as integer micro-units and are divided by `1e6`.
- Time buckets are UTC. `7d`/`30d` are daily buckets; `90d`/`all` are weekly.
- `/api/tasks` paginates and does not expose the full historical record, so the
  "distinct posters per week" figure covers the tasks a build can actually page
  through. This limitation is stated on the page itself, not hidden in this file.
- The page always renders its own **data as of** timestamp; nothing pretends to
  be live-streaming when it is an hourly snapshot.

## Licence

MIT — see [LICENSE](LICENSE).
