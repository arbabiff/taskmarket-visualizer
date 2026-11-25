#!/usr/bin/env node
/**
 * Live server: serves ./public and keeps the snapshot fresh in memory.
 *
 * Why a server rather than pure static hosting: the bounty requires the data to
 * be refreshed at least hourly, and the Taskmarket API refuses cross-origin
 * browser requests. So the refresh has to happen somewhere server-side. Here it
 * happens in this process on a timer — no CI, no cron, no external scheduler.
 *
 *   - On boot the baked snapshot file (public/data/snapshot.json) is served
 *     immediately, so the first request is fast and the health check passes.
 *   - A background rebuild then runs, and again every REFRESH_MS (default 30 min,
 *     well inside the hourly requirement).
 *   - If a rebuild fails, the previous good snapshot keeps being served and the
 *     failure is visible in /data/snapshot.json's own error list and /healthz.
 *
 * Env: PORT (default 3000), REFRESH_MS (default 1800000 = 30 min).
 */

import { createReadStream } from "node:fs";
import { readFile, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, extname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { buildSnapshot, isUseless } from "./snapshot.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * This file runs from two layouts:
 *   project:  scripts/live-server.mjs  -> public/ sits one level up
 *   package:  ./live-server.mjs        -> public/ sits beside it
 * Resolve whichever exists, and let SITE_DIR override outright.
 */
async function resolveRoot() {
  if (process.env.SITE_DIR) return resolve(process.env.SITE_DIR);
  const beside = resolve(__dirname, "public");
  const above = resolve(__dirname, "..", "public");
  if (await fileAt(join(beside, "index.html"))) return beside;
  if (await fileAt(join(above, "index.html"))) return above;
  return beside; // report the package layout, which is the deployed one
}

let ROOT = resolve(__dirname, "..", "public");
let SNAPSHOT_FILE = join(ROOT, "data", "snapshot.json");

const PORT = Number(process.env.PORT ?? 3000);
const REFRESH_MS = Number(process.env.REFRESH_MS ?? 30 * 60 * 1000);
const BOOT_GRACE_MS = Number(process.env.BOOT_GRACE_MS ?? 20 * 1000);

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".webmanifest": "application/manifest+json",
};

/* ------------------------------------------------------------ snapshot state */

const state = {
  json: null, // current snapshot as a string, served verbatim
  builtAt: null, // when the in-memory snapshot was produced
  lastAttempt: null,
  lastError: null,
  refreshing: false,
  refreshCount: 0,
};

async function loadBakedSnapshot() {
  try {
    const raw = await readFile(SNAPSHOT_FILE, "utf8");
    JSON.parse(raw); // reject a corrupt file rather than serve it
    state.json = raw;
    state.builtAt = JSON.parse(raw).generatedAt ?? null;
    console.log(`[live] baked snapshot loaded (${(raw.length / 1024).toFixed(1)} KB, as of ${state.builtAt})`);
  } catch (err) {
    console.warn(`[live] no usable baked snapshot (${err.message}); waiting for the first build`);
  }
}

async function refresh(reason) {
  if (state.refreshing) return;
  state.refreshing = true;
  state.lastAttempt = new Date().toISOString();
  const started = Date.now();
  try {
    const snapshot = await buildSnapshot();
    if (isUseless(snapshot)) throw new Error("snapshot has no headline stats for any chain");

    const json = JSON.stringify(snapshot, null, 1);
    state.json = json;
    state.builtAt = snapshot.generatedAt;
    state.lastError = null;
    state.refreshCount++;

    // Keep the file in step so a restart or an rsync sees the same data.
    writeFile(SNAPSHOT_FILE, json, "utf8").catch((e) =>
      console.warn(`[live] could not persist snapshot: ${e.message}`)
    );

    const summary = snapshot.chains
      .map((c) => `${c.name}:${c.errors.length}err/${c.taskReport?.tasksScanned ?? 0}tasks`)
      .join(" ");
    console.log(
      `[live] refreshed (${reason}) in ${Date.now() - started}ms — ${summary}, ${snapshot.totalErrors} total errors`
    );
  } catch (err) {
    state.lastError = err.message;
    console.error(`[live] refresh failed (${reason}): ${err.message} — still serving the last good snapshot`);
  } finally {
    state.refreshing = false;
  }
}

/* ---------------------------------------------------------------- static I/O */

async function fileAt(path) {
  try {
    const info = await stat(path);
    return info.isFile() ? { path, size: info.size } : undefined;
  } catch {
    return undefined;
  }
}

async function resolveFile(urlPath) {
  const rel = normalize(decodeURIComponent(urlPath)).replace(/^([/\\])+/, "");
  const base = join(ROOT, rel);
  if (base !== ROOT && !base.startsWith(ROOT + sep)) return undefined;
  return (await fileAt(base)) ?? (await fileAt(`${base}.html`)) ?? (await fileAt(join(base, "index.html")));
}

function sendFile(req, res, status, file) {
  const type = MIME[extname(file.path).toLowerCase()] ?? "application/octet-stream";
  res.writeHead(status, {
    "Content-Type": type,
    "Content-Length": file.size,
    "Cache-Control": "no-cache",
    "X-Content-Type-Options": "nosniff",
  });
  if (req.method === "HEAD") return res.end();
  createReadStream(file.path).pipe(res);
}

function sendJson(req, res, status, body) {
  const buf = Buffer.from(body, "utf8");
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": buf.length,
    "Cache-Control": "public, max-age=60",
    "X-Content-Type-Options": "nosniff",
  });
  if (req.method === "HEAD") return res.end();
  res.end(buf);
}

/* ------------------------------------------------------------------- server */

const server = createServer(async (req, res) => {
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(405, { Allow: "GET, HEAD" }).end();
    return;
  }

  let pathname;
  try {
    pathname = new URL(req.url ?? "/", "http://localhost").pathname;
  } catch {
    res.writeHead(400).end();
    return;
  }

  // Health: the snapshot must exist and be reasonably fresh.
  if (pathname === "/healthz") {
    const ageMin = state.builtAt ? (Date.now() - Date.parse(state.builtAt)) / 60000 : null;
    const ok = Boolean(state.json) && (ageMin === null || ageMin < 180);
    return sendJson(
      req,
      res,
      ok ? 200 : 503,
      JSON.stringify(
        {
          status: ok ? "ok" : "stale",
          snapshotAsOf: state.builtAt,
          ageMinutes: ageMin === null ? null : Math.round(ageMin),
          refreshCount: state.refreshCount,
          lastAttempt: state.lastAttempt,
          lastError: state.lastError,
          refreshing: state.refreshing,
          refreshIntervalMinutes: Math.round(REFRESH_MS / 60000),
        },
        null,
        1
      )
    );
  }

  // Always serve the freshest in-memory snapshot, never the stale file on disk.
  if (pathname === "/data/snapshot.json") {
    if (!state.json) {
      return sendJson(req, res, 503, JSON.stringify({ error: "snapshot not ready yet" }));
    }
    return sendJson(req, res, 200, state.json);
  }

  const file = await resolveFile(pathname);
  if (file) return sendFile(req, res, 200, file);

  const notFound = await fileAt(join(ROOT, "404.html"));
  if (notFound) return sendFile(req, res, 404, notFound);
  res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" }).end("Not Found");
});

async function main() {
  ROOT = await resolveRoot();
  SNAPSHOT_FILE = join(ROOT, "data", "snapshot.json");

  await loadBakedSnapshot();

  server.listen(PORT, "0.0.0.0", () => {
    console.log(`[live] listening on 0.0.0.0:${PORT}, serving ${ROOT}`);
    console.log(`[live] refresh interval ${Math.round(REFRESH_MS / 60000)} min`);
  });

  // Let the health check pass on the baked snapshot before spending time on a build.
  setTimeout(() => refresh("boot"), BOOT_GRACE_MS).unref?.();
  setInterval(() => refresh("schedule"), REFRESH_MS).unref?.();

  for (const sig of ["SIGINT", "SIGTERM"]) {
    process.on(sig, () => {
      console.log(`[live] ${sig} — shutting down`);
      server.close(() => process.exit(0));
      setTimeout(() => process.exit(0), 3000).unref?.();
    });
  }
}

main().catch((err) => {
  console.error("[live] fatal:", err);
  process.exit(1);
});
