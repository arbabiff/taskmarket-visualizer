#!/usr/bin/env node
/**
 * One-command deploy.
 *
 *   node scripts/deploy.mjs                 # fresh snapshot, then push -> Pages
 *   node scripts/deploy.mjs --no-fetch      # deploy what is already in public/
 *
 * Requires a git repo with an "origin" remote whose GitHub Actions are
 * allowed to publish Pages. The workflow in .github/workflows/ does the
 * building and publishing; this script only refreshes and pushes.
 */
import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(__dirname, "..");
const skipFetch = process.argv.includes("--no-fetch");

const run = (cmd, args) =>
  execFileSync(cmd, args, { cwd: REPO, stdio: "inherit", shell: false });

const capture = (cmd, args) =>
  execFileSync(cmd, args, { cwd: REPO, encoding: "utf8", shell: false }).trim();

function step(label, fn) {
  console.log(`\n▸ ${label}`);
  fn();
}

try {
  capture("git", ["rev-parse", "--is-inside-work-tree"]);
} catch {
  console.error("Not a git repository. Run: git init && git remote add origin <url>");
  process.exit(1);
}

let remote = "";
try {
  remote = capture("git", ["remote", "get-url", "origin"]);
} catch {
  console.error("No 'origin' remote. Add one: git remote add origin git@github.com:<you>/<repo>.git");
  process.exit(1);
}

if (!skipFetch) step("refreshing snapshot from the Taskmarket API", () => run("node", ["scripts/fetch.mjs"]));

step("staging", () => run("git", ["add", "-A"]));

const staged = (() => {
  try {
    return capture("git", ["diff", "--cached", "--name-only"]);
  } catch {
    return "";
  }
})();

if (!staged) {
  console.log("\nNothing changed — the snapshot is identical. Skipping empty commit.");
} else {
  const stamp = new Date().toISOString().replace("T", " ").slice(0, 16);
  step(`committing (${staged.split("\n").length} file(s))`, () =>
    run("git", ["commit", "-m", `data: refresh snapshot ${stamp} UTC`])
  );
}

step("pushing to origin", () => run("git", ["push", "origin", "HEAD"]));

const repoSlug = remote
  .replace(/^git@github\.com:/, "")
  .replace(/^https?:\/\/github\.com\//, "")
  .replace(/\.git$/, "");

console.log(`\n✓ pushed to ${repoSlug}`);
console.log(`  Actions:  https://github.com/${repoSlug}/actions`);
console.log(`  Live URL: https://${repoSlug.split("/")[0].toLowerCase()}.github.io/${repoSlug.split("/")[1]}/`);
console.log("\nThe workflow refreshes the snapshot hourly and republishes Pages on every push.");
