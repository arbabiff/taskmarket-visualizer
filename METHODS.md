# Methods

Exactly what this dashboard does, which endpoints it calls, and where the
numbers can be wrong. Kept in the repo so the figures can be audited rather
than taken on trust.

## Pipeline

1. `scripts/fetch.mjs` runs on a server (a GitHub Actions job, hourly).
2. It calls Taskmarket's public API at `https://api.taskmarket.dev` **server-side**.
   The API rejects cross-origin browser requests, so no browser ever calls it directly.
3. Everything it receives is written to `public/data/snapshot.json`.
4. `public/index.html` reads that single file and renders every section from it.

The page therefore shows a **snapshot with a timestamp**, not a live socket.

## Endpoints used

All are public, unauthenticated, and read-only. `chainId` is `8453` (Base) or
`4217` (Tempo).

| Purpose | Endpoint |
| --- | --- |
| Headline numbers | `/api/market/stats?chainId=…` |
| Tasks by status / mode / actor type | `/api/stats/breakdowns?chainId=…` |
| Time series | `/api/stats/platform-time-series?chainId=…&range=7d\|30d\|90d\|all&bucket=day\|week` |
| Heatmap | `/api/stats/activity-heatmap?chainId=…&range=30d&dimension=mode\|hourOfWeek` |
| Live activity feed | `/api/stats/activity-feed?chainId=…&limit=40` |
| Task list | `/api/tasks?chainId=…&sort=newest&limit=100` (paginated via `cursor`) |

## Definitions

- **Money** — the API returns integer micro-units. Every dollar figure on the
  page is `value / 1e6`, displayed as OUSD/USDC with two decimals.
- **Time** — all buckets are UTC. `7d` and `30d` use `bucket=day`; `90d` and
  `all` use `bucket=week`.
- **Active agents / Active workers** — the platform's own 7-day figures from
  `/api/market/stats`. Not recomputed here.
- **Distinct posters per week** — computed in `scripts/fetch.mjs`: unique,
  lower-cased `requester` addresses per Monday-anchored UTC week, over every task
  the build could page through.
- **Heatmaps** — cell values are counts of **tasks created** in that bucket. The
  current bucket grows through the day; past buckets are stable.
- **"Open tasks right now"** — `status === "open"` from the task list, newest first.

## Known limitations

- **The task list is paginated and not complete.** `/api/tasks` returns pages of
  100 with a `nextCursor`. A build walks pages until the API stops returning
  more, with a hard cap of 40 pages (4,000 tasks). In practice this covers a few
  hundred tasks per chain, not the platform's full history. `distinct posters per
  week` is therefore a **lower bound**, and the page states the exact scan count
  for the current snapshot under "This snapshot".
- **No backfill control.** There is no endpoint to request tasks older than the
  cursor window, so historic poster counts cannot be completed retroactively.
- **Hourly, not real time.** The feed is the most recent 40 events at build time.
- **Platform-reported aggregates are taken as given.** Stats, breakdowns and
  time series are not recomputed from raw tasks; if the platform's own numbers
  are wrong, so are these.
- **Failure handling.** Each endpoint is retried up to 3 times. If some endpoints
  fail, the snapshot is still written and the page shows a visible banner naming
  the failed endpoints — a partial page never silently presents itself as complete.
  If the headline stats fail for *both* chains, the build exits non-zero so CI
  turns red instead of publishing an empty dashboard.

## Freshness and caching

- Rebuilt every hour by `.github/workflows/refresh.yml` (`cron: "17 * * * *"`).
  GitHub may delay scheduled runs under load, so the rendered "data as of" time
  is the authority.
- The snapshot is a static file served over HTTPS; no login and no wallet needed.
- The page ships as one HTML file with an inline stylesheet and script: no CDN,
  no webfont, no third-party request. First load is the HTML plus one JSON file.
