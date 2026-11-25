#!/usr/bin/env node
/**
 * Write a snapshot to disk. Used by `npm run refresh` and by the hourly
 * GitHub Actions job; the live server builds snapshots in memory via lib.mjs.
 *
 * Usage:  node scripts/fetch.mjs [--out path]
 */

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildSnapshot, isUseless } from "./snapshot.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT =
  process.argv.find((a) => a.startsWith("--out="))?.slice(6) ??
  resolve(__dirname, "..", "public", "data", "snapshot.json");

async function main() {
  console.log(`[fetch] snapshot start ${new Date().toISOString()}`);

  const snapshot = await buildSnapshot();

  await mkdir(dirname(OUT), { recursive: true });
  await writeFile(OUT, JSON.stringify(snapshot, null, 1), "utf8");

  for (const c of snapshot.chains) {
    const s = c.data.stats;
    console.log(
      `[fetch] ${c.name}: ${c.errors.length} errors, ` +
        `${c.taskReport?.tasksScanned ?? 0} tasks scanned, ` +
        `openTasks=${s?.openTasks ?? "?"} activeAgents7d=${s?.activeAgents7d ?? "?"}`
    );
  }
  console.log(`[fetch] wrote ${OUT} (${(JSON.stringify(snapshot).length / 1024).toFixed(1)} KB)`);

  if (isUseless(snapshot)) {
    console.error("[fetch] no headline stats for any chain — treating as failure");
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("[fetch] fatal:", err);
  process.exit(1);
});
