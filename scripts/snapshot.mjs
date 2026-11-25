/**
 * Snapshot builder shared by the CLI (scripts/fetch.mjs) and the live server,
 * so there is exactly one implementation of "how a snapshot is made".
 *
 * The Taskmarket API does not allow cross-origin browser requests, so every
 * number is fetched here, in Node, and handed on as plain JSON.
 */

export const API = "https://api.taskmarket.dev";

export const CHAINS = [
  { id: 8453, name: "Base" },
  { id: 4217, name: "Tempo" },
];

export const RANGES = ["7d", "30d", "90d", "all"];

const TASK_PAGE_LIMIT = 100;
const TASK_MAX_PAGES = 40; // hard stop; 4,000 tasks
const CONCURRENCY = 6;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getJSON(path, { retries = 3, timeout = 30000 } = {}) {
  let lastErr;
  for (let attempt = 1; attempt <= retries; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeout);
    try {
      const res = await fetch(`${API}${path}`, {
        signal: ctrl.signal,
        headers: { accept: "application/json", "user-agent": "taskmarket-visualizer/1.0" },
      });
      if (!res.ok) {
        const body = (await res.text()).slice(0, 200);
        throw new Error(`HTTP ${res.status} for ${path}: ${body}`);
      }
      return await res.json();
    } catch (err) {
      lastErr = err;
      if (attempt < retries) await sleep(600 * attempt);
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error(`GET ${path} failed after ${retries} tries: ${lastErr?.message}`);
}

/** Run async tasks with a small concurrency cap. */
async function pool(items, limit, fn) {
  const out = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const i = cursor++;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

/** Walk the task list until exhaustion, de-duplicating by task id. */
async function fetchAllTasks(chainId) {
  const seen = new Map();
  let cursor = null;
  let pages = 0;
  let truncated = false;

  while (pages < TASK_MAX_PAGES) {
    const qs = new URLSearchParams({
      chainId: String(chainId),
      sort: "newest",
      limit: String(TASK_PAGE_LIMIT),
    });
    if (cursor) qs.set("cursor", cursor);

    const page = await getJSON(`/api/tasks?${qs}`);
    pages++;

    const tasks = page?.tasks ?? [];
    for (const t of tasks) if (t?.id && !seen.has(t.id)) seen.set(t.id, t);

    if (!page?.hasMore || !page?.nextCursor || tasks.length === 0) break;
    cursor = page.nextCursor;
    if (pages === TASK_MAX_PAGES) truncated = true;
  }

  return { tasks: [...seen.values()], pages, truncated };
}

/** Distinct task posters per ISO week (Monday-anchored), from the task list. */
export function postersPerWeek(tasks) {
  const weeks = new Map();
  for (const t of tasks) {
    if (!t?.createdAt || !t?.requester) continue;
    const d = new Date(t.createdAt);
    if (Number.isNaN(d.getTime())) continue;
    const monday = new Date(d);
    monday.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
    monday.setUTCHours(0, 0, 0, 0);
    const key = monday.toISOString().slice(0, 10);
    if (!weeks.has(key)) weeks.set(key, new Set());
    weeks.get(key).add(String(t.requester).toLowerCase());
  }
  return [...weeks.entries()]
    .map(([week, set]) => ({ week, posters: set.size }))
    .sort((a, b) => a.week.localeCompare(b.week));
}

/** Trim a task down to what the dashboard actually renders. */
function publicTask(t) {
  return {
    id: t.id,
    ref: t.referenceCode ?? null,
    status: t.status ?? null,
    mode: t.mode ?? null,
    reward: t.reward ?? null,
    netReward: t.netReward ?? null,
    createdAt: t.createdAt ?? null,
    expiryTime: t.expiryTime ?? null,
    requester: t.requester ?? null,
    requesterDisplayName: t.requesterDisplayName ?? null,
    requesterActorType: t.requesterActorType ?? null,
    submissionCount: t.submissionCount ?? 0,
    awardCount: t.awardCount ?? 0,
    description: typeof t.description === "string" ? t.description.slice(0, 220) : null,
  };
}

async function buildChain(chain) {
  const c = `chainId=${chain.id}`;

  const jobs = [
    ["stats", `/api/market/stats?${c}`],
    ["breakdowns", `/api/stats/breakdowns?${c}`],
    ["heatmapMode", `/api/stats/activity-heatmap?${c}&range=30d&dimension=mode`],
    ["heatmapHour", `/api/stats/activity-heatmap?${c}&range=30d&dimension=hourOfWeek`],
    ["feed", `/api/stats/activity-feed?${c}&limit=40`],
    ...RANGES.map((r) => [
      `series_${r}`,
      `/api/stats/platform-time-series?${c}&range=${r}&bucket=${r === "90d" || r === "all" ? "week" : "day"}`,
    ]),
  ];

  const results = await pool(jobs, CONCURRENCY, async ([key, path]) => {
    try {
      return [key, path, await getJSON(path), null];
    } catch (err) {
      return [key, path, null, err.message];
    }
  });

  const data = {};
  const errors = [];
  const endpoints = [];
  for (const [key, path, value, error] of results) {
    endpoints.push({ path, ok: !error });
    if (error) errors.push({ endpoint: path, error });
    else data[key] = value;
  }

  let taskReport = null;
  try {
    const { tasks, pages, truncated } = await fetchAllTasks(chain.id);
    data.postersPerWeek = postersPerWeek(tasks);
    data.recentTasks = tasks.slice(0, 60).map(publicTask);
    data.openTasks = tasks
      .filter((t) => t.status === "open")
      .sort((a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? ""))
      .slice(0, 40)
      .map(publicTask);
    taskReport = { tasksScanned: tasks.length, pages, truncated };
    endpoints.push({ path: `/api/tasks?${c}&sort=newest&limit=${TASK_PAGE_LIMIT}`, ok: true });
  } catch (err) {
    errors.push({ endpoint: `/api/tasks?chainId=${chain.id}`, error: err.message });
  }

  return { chain, data, errors, endpoints, taskReport };
}

/**
 * Build a complete snapshot. Resolves even when individual endpoints fail,
 * so a partial dashboard can still be served with a visible warning.
 */
export async function buildSnapshot() {
  const chains = await pool(CHAINS, 2, async (chain) => {
    try {
      return await buildChain(chain);
    } catch (err) {
      return { chain, data: {}, errors: [{ endpoint: "*", error: err.message }], endpoints: [] };
    }
  });

  return {
    generatedAt: new Date().toISOString(),
    source: {
      name: "Taskmarket public API",
      baseUrl: API,
      note:
        "All data is fetched server-side at build time and served as this static JSON file. " +
        "The Taskmarket API rejects cross-origin browser requests, so no browser request ever hits api.taskmarket.dev.",
    },
    chains: chains.map(({ chain, data, errors, endpoints, taskReport }) => ({
      id: chain.id,
      name: chain.name,
      data,
      errors,
      endpoints,
      taskReport,
    })),
    totalErrors: chains.reduce((n, c) => n + c.errors.length, 0),
  };
}

/** True when the snapshot has headline stats for no chain at all. */
export function isUseless(snapshot) {
  return snapshot.chains.every((c) => !c.data?.stats);
}
