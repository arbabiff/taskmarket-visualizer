#!/usr/bin/env node
/**
 * Server-side snapshot builder for the Taskmarket visualizer.
 *
 * The Taskmarket API does not allow cross-origin browser requests, so every
 * number on the dashboard is fetched here (in Node) and baked into
 * public/data/snapshot.json. The browser only ever reads that one static file.
 *
 * Usage:  node scripts/fetch.mjs [--out path]
 */

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const API = "https://api.taskmarket.dev";
const CHAINS = [
  { id: 8453, name: "Base", short: "Base" },
  { id: 4217, name: "Tempo", short: "Tempo" },
];
const RANGES = ["7d", "30d", "90d", "all"];
const TASK_PAGE_LIMIT = 100;
const TASK_MAX_PAGES = 40; // hard stop; 4,000 tasks
const CONCURRENCY = 6;

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT =
  process.argv.find((a) => a.startsWith("--out="))?.slice(6) ??
  resolve(__dirname, "..", "public", "data", "snapshot.json");

/* ------------------------------------------------------------------ helpers */

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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
function postersPerWeek(tasks) {
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

/* -------------------------------------------------------------------- build */

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

async function main() {
  const startedAt = new Date().toISOString();
  console.log(`[fetch] snapshot start ${startedAt}`);

  const chains = await pool(CHAINS, 2, async (chain) => {
    try {
      return await buildChain(chain);
    } catch (err) {
      console.error(`[fetch] chain ${chain.name} failed:`, err.message);
      return { chain, data: {}, errors: [{ endpoint: "*", error: err.message }], endpoints: [] };
    }
  });

  const snapshot = {
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

  await mkdir(dirname(OUT), { recursive: true });
  await writeFile(OUT, JSON.stringify(snapshot, null, 1), "utf8");

  const bytes = JSON.stringify(snapshot).length;
  for (const c of snapshot.chains) {
    const s = c.data.stats;
    console.log(
      `[fetch] ${c.name}: ${c.errors.length} errors, ` +
        `${c.taskReport?.tasksScanned ?? 0} tasks scanned, ` +
        `openTasks=${s?.openTasks ?? "?"} activeAgents7d=${s?.activeAgents7d ?? "?"}`
    );
  }
  console.log(`[fetch] wrote ${OUT} (${(bytes / 1024).toFixed(1)} KB)`);

  // A wholly empty snapshot is a failure worth surfacing to CI.
  if (snapshot.totalErrors > 0 && snapshot.chains.every((c) => !c.data.stats)) {
    console.error("[fetch] no headline stats for any chain — treating as failure");
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("[fetch] fatal:", err);
  process.exit(1);
});
