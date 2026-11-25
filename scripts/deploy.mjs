#!/usr/bin/env node
/**
 * One-command deploy.
 *
 *   node scripts/deploy.mjs                 # fresh snapshot, then push -> Pages
 *   node scripts/deploy.mjs --no-fetch      # deploy what is already in public/
 *
 * Requires a git repo with an "origin" remote whose GitHub Actions are allowed
 * to publish Pages. The workflow in .github/workflows/ builds and publishes;
 * this script refreshes the snapshot, commits it, and pushes.
 */
import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(__dirname, "..");
const skipFetch = process.argv.includes("--no-fetch");

function run(cmd, args, opts = {}) {
  return execFileSync(cmd, args, { cwd: REPO, encoding: "utf8", ...opts });
}

function capture(cmd, args) {
  return run(cmd, args).trim();
}

function step(label, fn) {
  console.log(`\n▸ ${label}`);
  return fn();
}

function fail(message) {
  console.error(`\n✗ ${message}`);
  process.exit(1);
}

/* -------------------------------------------------------------- preconditions */

try {
  capture("git", ["rev-parse", "--is-inside-work-tree"]);
} catch {
  fail("Not a git repository.\n  Run: git init -b main && git remote add origin <url>");
}

let remote;
try {
  remote = capture("git", ["remote", "get-url", "origin"]);
} catch {
  fail("No 'origin' remote.\n  Add one: git remote add origin git@github.com:<you>/<repo>.git");
}

// A commit needs an identity. Without one git exits 128 with a wall of advice,
// so give the repo a local fallback rather than failing the whole deploy.
let identity = false;
try {
  capture("git", ["config", "user.email"]);
  capture("git", ["config", "user.name"]);
  identity = true;
} catch {
  /* set below */
}

if (!identity) {
  step("no git identity configured — setting a repo-local one", () => {
    run("git", ["config", "user.email", "agent@localhost"]);
    run("git", ["config", "user.name", "Taskmarket Visualizer"]);
    console.log("  (repo-local only; change with: git config user.email you@example.com)");
  });
}

/* ------------------------------------------------------------------- pipeline */

if (!skipFetch) {
  step("refreshing snapshot from the Taskmarket API", () => {
    run("node", ["scripts/fetch.mjs"], { stdio: "inherit", encoding: "utf8" });
  });
}

step("staging", () => run("git", ["add", "-A"]));

let staged = "";
try {
  staged = capture("git", ["diff", "--cached", "--name-only"]);
} catch {
  staged = "";
}

if (!staged) {
  console.log("\nNothing changed — the snapshot is identical to the last build.");
} else {
  const stamp = new Date().toISOString().replace("T", " ").slice(0, 16);
  step(`committing ${staged.split("\n").length} file(s)`, () => {
    try {
      run("git", ["commit", "-m", `data: refresh snapshot ${stamp} UTC`], { stdio: "inherit" });
    } catch {
      fail("git commit failed — see the message above.");
    }
  });
}

step("pushing to origin", () => {
  try {
    run("git", ["push", "origin", "HEAD"], { stdio: "inherit" });
  } catch {
    fail(
      "git push failed — see the message above.\n" +
        "  Common causes: no network, no credentials, or a non-fast-forward remote.\n" +
        "  For HTTPS remotes GitHub needs a personal access token, not a password."
    );
  }
});

/* --------------------------------------------------------------------- report */

const slug = remote
  .replace(/^git@github\.com:/, "")
  .replace(/^https?:\/\/github\.com\//, "")
  .replace(/\.git$/, "");

const isGitHub = /^[^/]+\/[^/]+$/.test(slug);

console.log(`\n✓ pushed to origin (${remote})`);
if (isGitHub) {
  const [owner, repo] = slug.split("/");
  console.log(`  Actions:  https://github.com/${slug}/actions`);
  console.log(`  Live URL: https://${owner.toLowerCase()}.github.io/${repo}/`);
  console.log("\n  One-time setup: repo Settings → Pages → Source: GitHub Actions.");
  console.log("  The workflow then refreshes hourly and republishes on every push.");
} else {
  console.log("  Remote is not a github.com repo; Pages publishing is not applicable.");
}
