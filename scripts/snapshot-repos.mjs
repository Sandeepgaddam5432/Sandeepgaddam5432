#!/usr/bin/env node
/**
 * Optional: capture the public repository list of a GitHub user at deploy time.
 * The extension falls back to this file when the anonymous GitHub API quota (60 req/h) is exhausted.
 *
 *   GITHUB_USERNAME=Sandeepgaddam5432 node scripts/snapshot-repos.mjs
 *   (optionally GITHUB_TOKEN=... to lift the rate limit)
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const user = process.env.VITE_GITHUB_USERNAME || process.env.GITHUB_USERNAME || "Sandeepgaddam5432";
const headers = process.env.GITHUB_TOKEN ? { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {};

const repos = [];
for (let page = 1; page <= 10; page++) {
  const res = await fetch(`https://api.github.com/users/${user}/repos?per_page=100&type=owner&sort=pushed&page=${page}`, { headers });
  if (!res.ok) throw new Error(`GitHub API ${res.status}: ${await res.text()}`);
  const batch = await res.json();
  for (const r of batch) {
    repos.push({
      name: r.name,
      branch: r.default_branch || "main",
      description: r.description || "",
      fork: !!r.fork,
      archived: !!r.archived,
      size: r.size || 0,
    });
  }
  if (batch.length < 100) break;
}

for (const repo of repos) {
  if (repo.size !== 0) continue;
  try {
    const res = await fetch(
      `https://api.github.com/repos/${encodeURIComponent(user)}/${encodeURIComponent(repo.name)}/git/trees/${encodeURIComponent(repo.branch)}?recursive=1`,
      { headers },
    );
    if (res.status === 409) repo.empty = true;
  } catch (_) {}
}

const out = path.join(root, "public/extensions/github-repo-provider/repos-snapshot.json");
fs.writeFileSync(out, JSON.stringify({ user, at: new Date().toISOString(), repos }, null, 2) + "\n");
console.log(`[snapshot] ${repos.length} repos for ${user} -> ${out}`);
