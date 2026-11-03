#!/usr/bin/env node
/**
 * Downloads the OFFICIAL Microsoft VS Code Web distribution (vscode-web.tar.gz,
 * the same artifact @vscode/test-web uses) and unpacks it into ./public so that
 * `vite build` ships it verbatim inside dist/.
 *
 * Usage:
 *   node scripts/fetch-vscode-web.mjs                 # latest stable
 *   VSCODE_COMMIT=<sha> node scripts/fetch-vscode-web.mjs   # pin a commit
 *
 * The custom built-in web extension in public/extensions/github-repo-provider
 * is never touched by this script.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const publicDir = path.join(root, "public");

// Parts of the distribution that are not needed for a static, read-only
// "browse GitHub repos" deployment. Removing them keeps dist/ small.
const PRUNE = [
  "out/vs/sessions", // agents window (separate product surface)
  "extensions/TypeScriptTeam.jsts-chat-features",
  "package.json",
];

async function resolveRelease() {
  const commit = process.env.VSCODE_COMMIT;
  if (commit) {
    return {
      version: commit,
      url: `https://update.code.visualstudio.com/commit:${commit}/web-standalone/stable`,
    };
  }
  const res = await fetch("https://update.code.visualstudio.com/api/update/web-standalone/stable/latest");
  if (!res.ok) throw new Error(`update API failed: ${res.status}`);
  return res.json();
}

const release = await resolveRelease();
console.log("[vscode-web] release:", release.productVersion ?? release.version, release.version);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "vscode-web-"));
const archive = path.join(tmp, "vscode-web.tar.gz");

console.log("[vscode-web] downloading", release.url);
const dl = await fetch(release.url, { redirect: "follow" });
if (!dl.ok) throw new Error(`download failed: ${dl.status}`);
fs.writeFileSync(archive, Buffer.from(await dl.arrayBuffer()));

const extractDir = path.join(tmp, "x");
fs.mkdirSync(extractDir);
execFileSync("tar", ["xzf", archive, "-C", extractDir, "--strip-components=1"], { stdio: "inherit" });

const pkg = JSON.parse(fs.readFileSync(path.join(extractDir, "package.json"), "utf8"));

for (const rel of PRUNE) fs.rmSync(path.join(extractDir, rel), { recursive: true, force: true });

fs.mkdirSync(publicDir, { recursive: true });
// replace the vendored runtime folders, keep everything else (our extension lives in public/extensions)
fs.rmSync(path.join(publicDir, "out"), { recursive: true, force: true });
fs.rmSync(path.join(publicDir, "node_modules"), { recursive: true, force: true });
fs.cpSync(extractDir, publicDir, { recursive: true, force: true });

fs.writeFileSync(
  path.join(publicDir, "vscode-version.json"),
  JSON.stringify({ commit: release.version, version: pkg.version, quality: "stable" }, null, 2) + "\n",
);

fs.rmSync(tmp, { recursive: true, force: true });
console.log("[vscode-web] done ->", publicDir);
