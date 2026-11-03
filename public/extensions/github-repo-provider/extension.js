/* eslint-disable */
/**
 * github-repo-provider - built-in VS Code *web* extension.
 *
 *  - registers the `ghrepo:` FileSystemProvider (read-only) so every public repo
 *    of a GitHub user shows up as a native workspace folder in the real Explorer
 *  - directory listings : GitHub git-trees API  (fallback: jsDelivr data API)
 *  - file contents      : https://raw.githubusercontent.com
 *  - contributes an in-browser "GitHub Shell" terminal profile
 *
 * No Node.js APIs are used: this runs inside the VS Code web extension host worker.
 */
const vscode = require("vscode");

const SCHEME = "ghrepo";
const GH_API = "https://api.github.com";
const RAW = "https://raw.githubusercontent.com";
const JSDELIVR = "https://data.jsdelivr.com/v1/packages/gh";
const REPO_TTL_MS = 15 * 60 * 1000;
const TREE_TTL_MS = 60 * 60 * 1000;

const enc = new TextEncoder();
const dec = new TextDecoder();

/* ------------------------------------------------------------------ helpers */

const encodePath = (p) => p.split("/").map(encodeURIComponent).join("/");
const splitPath = (p) => p.split("/").filter(Boolean);
const baseName = (p) => splitPath(p).pop() || "";

function userFromUri(uri) {
  return uri.authority;
}

function makeUri(user, path) {
  return vscode.Uri.from({ scheme: SCHEME, authority: user, path: path || "/" });
}

function workspaceFileName(user) {
  return `${user}.code-workspace`;
}

function currentUser() {
  const wf = vscode.workspace.workspaceFile;
  // URI authorities are lower-cased by VS Code; the workspace file name keeps the user's original casing
  if (wf && wf.scheme === SCHEME) return baseName(wf.path).replace(/\.code-workspace$/, "") || wf.authority;
  const folder = (vscode.workspace.workspaceFolders || []).find((f) => f.uri.scheme === SCHEME);
  return folder ? folder.uri.authority : undefined;
}

async function getJson(url) {
  const res = await fetch(url);
  if (!res.ok) {
    const err = new Error(`${res.status} ${res.statusText} - ${url}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

/* ------------------------------------------------------- GitHub data layer */

class GitHubData {
  /** @param {vscode.ExtensionContext} ctx */
  constructor(ctx) {
    this.ctx = ctx;
    this.repoLists = new Map(); // user -> Promise<Repo[]>
    this.trees = new Map(); // `${user}/${repo}` -> Promise<Tree>
    this.warned = new Set();
  }

  warnOnce(key, message) {
    if (this.warned.has(key)) return;
    this.warned.add(key);
    vscode.window.showWarningMessage(message);
  }

  clear() {
    this.repoLists.clear();
    this.trees.clear();
    const keys = this.ctx.globalState.keys().filter((k) => k.startsWith("repos:") || k.startsWith("tree:"));
    return Promise.all(keys.map((k) => this.ctx.globalState.update(k, undefined)));
  }

  repos(user) {
    const key = user.toLowerCase();
    if (!this.repoLists.has(key)) {
      const p = this.loadRepos(user).catch((e) => {
        this.repoLists.delete(key);
        throw e;
      });
      this.repoLists.set(key, p);
    }
    return this.repoLists.get(key);
  }

  async loadRepos(user) {
    const cacheKey = `repos:${user.toLowerCase()}`;
    const cached = this.ctx.globalState.get(cacheKey);
    if (cached && Date.now() - cached.at < REPO_TTL_MS) return cached.repos;

    try {
      const all = [];
      for (let page = 1; page <= 10; page++) {
        const batch = await getJson(
          `${GH_API}/users/${encodeURIComponent(user)}/repos?per_page=100&type=owner&sort=pushed&page=${page}`,
        );
        for (const r of batch) {
          all.push({
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
      await this.ctx.globalState.update(cacheKey, { at: Date.now(), repos: all });
      return all;
    } catch (e) {
      if (e.status === 404) {
        this.warnOnce(`404:${user}`, `GitHub user "${user}" was not found. Use "GitHub Repos: Switch GitHub User..." to pick another one.`);
        return [];
      }
      // stale cache is better than nothing
      if (cached) return cached.repos;
      // bundled snapshot (generated at deploy time for the default user)
      const snap = await this.loadSnapshot(user);
      if (snap) {
        this.warnOnce(
          `snap:${user}`,
          "GitHub API rate limit reached - showing the repository list captured at deploy time.",
        );
        return snap;
      }
      this.warnOnce(`err:${user}`, `Could not load repositories for "${user}": ${e.message}`);
      return [];
    }
  }

  async loadSnapshot(user) {
    try {
      const url = vscode.Uri.joinPath(this.ctx.extensionUri, "repos-snapshot.json").toString();
      const snap = await getJson(url);
      if (snap && snap.user && snap.user.toLowerCase() === user.toLowerCase()) return snap.repos;
    } catch (_) {}
    return undefined;
  }

  async repo(user, name) {
    const repos = await this.repos(user);
    return repos.find((r) => r.name.toLowerCase() === name.toLowerCase());
  }

  /** true once the file list of a repo has been fetched */
  hasTree(user, repo) {
    return this.trees.has(`${user}/${repo.name}`.toLowerCase());
  }

  tree(user, repo) {
    const key = `${user}/${repo.name}`.toLowerCase();
    if (!this.trees.has(key)) {
      const p = this.loadTree(user, repo).catch((e) => {
        this.trees.delete(key);
        throw e;
      });
      this.trees.set(key, p);
    }
    return this.trees.get(key);
  }

  async loadTree(user, repo) {
    if (repo.empty) return buildTree([]);
    // trees are cached for an hour so reloads do not burn the anonymous 60 req/h GitHub API quota
    const cacheKey = `tree:${user}/${repo.name}@${repo.branch}`.toLowerCase();
    const cached = this.ctx.globalState.get(cacheKey);
    if (cached && Date.now() - cached.at < TREE_TTL_MS) {
      return buildTree(cached.e.map(([path, dir, size]) => ({ path, dir: !!dir, size })));
    }
    let entries; // [{path, dir, size}]
    try {
      const data = await getJson(
        `${GH_API}/repos/${encodeURIComponent(user)}/${encodeURIComponent(repo.name)}/git/trees/${encodeURIComponent(
          repo.branch,
        )}?recursive=1`,
      );
      entries = (data.tree || []).map((t) => ({ path: t.path, dir: t.type !== "blob", size: t.size || 0 }));
      if (data.truncated) {
        this.warnOnce(`trunc:${user}/${repo.name}`, `Repository "${repo.name}" is very large - the file list is truncated.`);
      }
    } catch (apiError) {
      if (apiError.status === 409) return buildTree([]);
      try {
        const data = await getJson(
          `${JSDELIVR}/${encodeURIComponent(user)}/${encodeURIComponent(repo.name)}@${encodeURIComponent(
            repo.branch,
          )}?structure=flat`,
        );
        entries = (data.files || []).map((f) => ({ path: f.name.replace(/^\//, ""), dir: false, size: f.size || 0 }));
        console.info("[github-repo-provider] GitHub API unavailable - listing served through jsDelivr");
      } catch (_) {
        this.warnOnce(
          "tree-fail",
          `Could not list files of "${repo.name}" (${apiError.message}). GitHub's anonymous API limit is 60 requests/hour; try again later.`,
        );
        throw vscode.FileSystemError.Unavailable(apiError.message);
      }
    }
    if (entries.length < 15000) {
      this.ctx.globalState.update(cacheKey, { at: Date.now(), e: entries.map((x) => [x.path, x.dir ? 1 : 0, x.size]) });
    }
    return buildTree(entries);
  }
}

/** Builds directory index from a flat entry list. */
function buildTree(entries) {
  const dirs = new Map(); // dirPath -> Map(name -> {dir,size})
  const files = new Map(); // path -> size
  const ensureDir = (p) => {
    if (!dirs.has(p)) {
      dirs.set(p, new Map());
      if (p !== "") {
        const idx = p.lastIndexOf("/");
        const parent = idx === -1 ? "" : p.slice(0, idx);
        ensureDir(parent);
        dirs.get(parent).set(p.slice(idx + 1), { dir: true, size: 0 });
      }
    }
  };
  ensureDir("");
  for (const e of entries) {
    const idx = e.path.lastIndexOf("/");
    const parent = idx === -1 ? "" : e.path.slice(0, idx);
    const name = e.path.slice(idx + 1);
    ensureDir(parent);
    if (e.dir) {
      ensureDir(e.path);
    } else {
      dirs.get(parent).set(name, { dir: false, size: e.size });
      files.set(e.path, e.size);
    }
  }
  return { dirs, files };
}

/** hidden root-level config probes (".vscode/...", ".mcp.json") issued by the workbench for each folder */
const isProbe = (rel) => rel.startsWith(".");

/* -------------------------------------------------- FileSystemProvider (VFS) */

class GitHubFileSystem {
  /** @param {GitHubData} data */
  constructor(data) {
    this.data = data;
    this._emitter = new vscode.EventEmitter();
    this.onDidChangeFile = this._emitter.event;
  }

  parse(uri) {
    const segs = splitPath(uri.path);
    return { user: userFromUri(uri), repo: segs[0], rel: segs.slice(1).join("/"), segs };
  }

  async workspaceFileContent(user) {
    const repos = await this.data.repos(user);
    const doc = {
      folders: repos.map((r) => ({ name: r.name, uri: makeUri(user, "/" + r.name).toString() })),
      settings: {},
    };
    return enc.encode(JSON.stringify(doc, null, 2));
  }

  isWorkspaceFile(uri) {
    return uri.path.toLowerCase() === ("/" + workspaceFileName(uri.authority)).toLowerCase();
  }

  watch() {
    return new vscode.Disposable(() => {});
  }

  async stat(uri) {
    const now = Date.now();
    const { user, repo, rel, segs } = this.parse(uri);
    if (segs.length === 0) return { type: vscode.FileType.Directory, ctime: now, mtime: now, size: 0 };
    if (this.isWorkspaceFile(uri)) {
      const bytes = await this.workspaceFileContent(user);
      return { type: vscode.FileType.File, ctime: now, mtime: now, size: bytes.length };
    }
    const info = await this.data.repo(user, repo);
    if (!info) throw vscode.FileSystemError.FileNotFound(uri);
    if (!rel) return { type: vscode.FileType.Directory, ctime: now, mtime: now, size: 0 };
    // VS Code probes <folder>/.vscode/*.json, <folder>/.mcp.json, ... for every workspace folder at startup.
    // Answer those without a network round trip (and without burning GitHub API quota) until the repo is expanded.
    if (!this.data.hasTree(user, info) && isProbe(rel)) {
      throw vscode.FileSystemError.FileNotFound(uri);
    }
    const tree = await this.data.tree(user, info);
    if (tree.dirs.has(rel)) return { type: vscode.FileType.Directory, ctime: now, mtime: now, size: 0 };
    if (tree.files.has(rel)) {
      return {
        type: vscode.FileType.File,
        ctime: now,
        mtime: now,
        size: tree.files.get(rel),
        permissions: vscode.FilePermission.Readonly,
      };
    }
    throw vscode.FileSystemError.FileNotFound(uri);
  }

  async readDirectory(uri) {
    const { user, repo, rel, segs } = this.parse(uri);
    if (segs.length === 0) {
      const repos = await this.data.repos(user);
      return repos.map((r) => [r.name, vscode.FileType.Directory]);
    }
    const info = await this.data.repo(user, repo);
    if (!info) throw vscode.FileSystemError.FileNotFound(uri);
    const tree = await this.data.tree(user, info);
    const dir = tree.dirs.get(rel);
    if (!dir) throw vscode.FileSystemError.FileNotADirectory(uri);
    return [...dir.entries()].map(([name, e]) => [name, e.dir ? vscode.FileType.Directory : vscode.FileType.File]);
  }

  async readFile(uri) {
    const { user, repo, rel, segs } = this.parse(uri);
    if (this.isWorkspaceFile(uri)) return this.workspaceFileContent(user);
    if (segs.length < 2) throw vscode.FileSystemError.FileIsADirectory(uri);
    const info = await this.data.repo(user, repo);
    if (!info) throw vscode.FileSystemError.FileNotFound(uri);
    if (this.data.hasTree(user, info)) {
      const tree = await this.data.tree(user, info);
      if (!tree.files.has(rel)) throw vscode.FileSystemError.FileNotFound(uri);
    } else if (isProbe(rel)) {
      throw vscode.FileSystemError.FileNotFound(uri);
    }
    const url = `${RAW}/${encodeURIComponent(user)}/${encodeURIComponent(info.name)}/${encodePath(info.branch)}/${encodePath(rel)}`;
    const res = await fetch(url);
    if (res.status === 404) throw vscode.FileSystemError.FileNotFound(uri);
    if (!res.ok) throw vscode.FileSystemError.Unavailable(`${res.status} ${res.statusText}`);
    return new Uint8Array(await res.arrayBuffer());
  }

  writeFile(uri) {
    throw vscode.FileSystemError.NoPermissions("GitHub repositories are mounted read-only.");
  }
  delete(uri) {
    throw vscode.FileSystemError.NoPermissions("GitHub repositories are mounted read-only.");
  }
  rename(uri) {
    throw vscode.FileSystemError.NoPermissions("GitHub repositories are mounted read-only.");
  }
  createDirectory(uri) {
    throw vscode.FileSystemError.NoPermissions("GitHub repositories are mounted read-only.");
  }
}

/* ------------------------------------------------------------ web terminal */

const C = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  blue: "\x1b[1;34m",
  green: "\x1b[1;32m",
  cyan: "\x1b[36m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
  magenta: "\x1b[35m",
};

function tokenize(line) {
  const out = [];
  let cur = "";
  let q = null;
  let had = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (q) {
      if (ch === q) q = null;
      else cur += ch;
    } else if (ch === '"' || ch === "'") {
      q = ch;
      had = true;
    } else if (/\s/.test(ch)) {
      if (cur || had) out.push(cur);
      cur = "";
      had = false;
    } else if (ch === "|") {
      if (cur || had) out.push(cur);
      out.push("|");
      cur = "";
      had = false;
    } else cur += ch;
  }
  if (cur || had) out.push(cur);
  return out;
}

function globToRegExp(glob) {
  const re = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
  return new RegExp("^" + re + "$");
}

const COMMANDS = [
  "help", "pwd", "cd", "ls", "cat", "head", "tail", "wc", "grep", "find", "tree", "echo", "clear",
  "open", "repos", "whoami", "github", "rate", "date", "uname", "history", "exit", "switch",
];

class GitHubShell {
  /** @param {GitHubData} data @param {GitHubFileSystem} fsProvider @param {string} user */
  constructor(data, fsProvider, user) {
    this.data = data;
    this.fsp = fsProvider;
    this.user = user;
    this.cwd = "/";
    this.buf = "";
    this.cur = 0;
    this.history = [];
    this.histIdx = 0;
    this.busy = false;
    this.abort = false;
    this.pending = [];
    this._write = new vscode.EventEmitter();
    this._close = new vscode.EventEmitter();
    this.onDidWrite = this._write.event;
    this.onDidClose = this._close.event;
  }

  /* pty lifecycle */
  open() {
    this.print(
      `${C.bold}GitHub Shell${C.reset} ${C.dim}- in-browser web shell, read-only view of github.com/${this.user}${C.reset}\r\n` +
        `Type ${C.cyan}help${C.reset} for commands, ${C.cyan}repos${C.reset} to list repositories.\r\n\r\n`,
    );
    this.prompt();
  }
  close() {}

  print(s) {
    this._write.fire(s.replace(/\r?\n/g, "\r\n"));
  }

  promptText() {
    return `${C.green}${this.user}@github${C.reset}:${C.blue}${this.cwd === "/" ? "~" : "~" + this.cwd}${C.reset}$ `;
  }
  promptLen() {
    return `${this.user}@github:${this.cwd === "/" ? "~" : "~" + this.cwd}$ `.length;
  }

  prompt() {
    this.buf = "";
    this.cur = 0;
    this._write.fire(this.promptText());
  }

  redraw() {
    this._write.fire("\r\x1b[2K" + this.promptText() + this.buf);
    const back = this.buf.length - this.cur;
    if (back > 0) this._write.fire(`\x1b[${back}D`);
  }

  /* input */
  handleInput(data) {
    const tokens = data.match(/\x1b\[[0-9;]*[A-Za-z~]|\x1b.|[\s\S]/g) || [];
    for (const t of tokens) this.key(t);
  }

  key(k) {
    if (this.busy) {
      if (k === "\x03") {
        this.abort = true;
        this.print(`^C\r\n`);
      } else {
        this.pending.push(k); // type-ahead while a command is running
      }
      return;
    }
    switch (k) {
      case "\r":
      case "\n":
        this._write.fire("\r\n");
        this.run(this.buf);
        return;
      case "\x7f":
      case "\b":
        if (this.cur > 0) {
          this.buf = this.buf.slice(0, this.cur - 1) + this.buf.slice(this.cur);
          this.cur--;
          this.redraw();
        }
        return;
      case "\x1b[3~":
        if (this.cur < this.buf.length) {
          this.buf = this.buf.slice(0, this.cur) + this.buf.slice(this.cur + 1);
          this.redraw();
        }
        return;
      case "\x03":
        this._write.fire("^C\r\n");
        this.prompt();
        return;
      case "\x0c":
        this._write.fire("\x1b[2J\x1b[3J\x1b[H");
        this.redraw();
        return;
      case "\x01":
      case "\x1b[H":
        this.cur = 0;
        this.redraw();
        return;
      case "\x05":
      case "\x1b[F":
        this.cur = this.buf.length;
        this.redraw();
        return;
      case "\x15":
        this.buf = this.buf.slice(this.cur);
        this.cur = 0;
        this.redraw();
        return;
      case "\x1b[D":
        if (this.cur > 0) {
          this.cur--;
          this._write.fire("\x1b[D");
        }
        return;
      case "\x1b[C":
        if (this.cur < this.buf.length) {
          this.cur++;
          this._write.fire("\x1b[C");
        }
        return;
      case "\x1b[A":
        if (this.histIdx > 0) {
          this.histIdx--;
          this.buf = this.history[this.histIdx];
          this.cur = this.buf.length;
          this.redraw();
        }
        return;
      case "\x1b[B":
        if (this.histIdx < this.history.length) {
          this.histIdx++;
          this.buf = this.history[this.histIdx] || "";
          this.cur = this.buf.length;
          this.redraw();
        }
        return;
      case "\t":
        this.complete();
        return;
      default:
        if (k.length === 1 && k >= " ") {
          this.buf = this.buf.slice(0, this.cur) + k + this.buf.slice(this.cur);
          this.cur++;
          if (this.cur === this.buf.length) this._write.fire(k);
          else this.redraw();
        }
    }
  }

  async complete() {
    const before = this.buf.slice(0, this.cur);
    const parts = before.split(/\s+/);
    const word = parts[parts.length - 1];
    let candidates = [];
    if (parts.length === 1) {
      candidates = COMMANDS.filter((c) => c.startsWith(word));
    } else {
      const slash = word.lastIndexOf("/");
      const dirPart = slash === -1 ? "" : word.slice(0, slash + 1);
      const namePart = slash === -1 ? word : word.slice(slash + 1);
      try {
        const entries = await this.readDir(this.resolve(dirPart || "."));
        candidates = entries
          .filter(([n]) => n.startsWith(namePart))
          .map(([n, t]) => dirPart + n + (t === vscode.FileType.Directory ? "/" : ""));
      } catch (_) {}
    }
    if (candidates.length === 0) return;
    if (candidates.length === 1) {
      const add = candidates[0].slice(word.length) + (candidates[0].endsWith("/") ? "" : " ");
      this.buf = before + add + this.buf.slice(this.cur);
      this.cur += add.length;
      this.redraw();
      return;
    }
    let prefix = candidates[0];
    for (const c of candidates) while (!c.startsWith(prefix)) prefix = prefix.slice(0, -1);
    if (prefix.length > word.length) {
      const add = prefix.slice(word.length);
      this.buf = before + add + this.buf.slice(this.cur);
      this.cur += add.length;
      this.redraw();
    } else {
      this._write.fire("\r\n" + candidates.map((c) => baseName(c) + (c.endsWith("/") ? "/" : "")).join("  ") + "\r\n");
      this.redraw();
    }
  }

  /* fs helpers */
  resolve(p) {
    if (p === "~" || p === "") return "/";
    if (p.startsWith("~/")) p = p.slice(1);
    const stack = p.startsWith("/") ? [] : splitPath(this.cwd);
    for (const seg of p.split("/")) {
      if (!seg || seg === ".") continue;
      if (seg === "..") stack.pop();
      else stack.push(seg);
    }
    return "/" + stack.join("/");
  }
  uri(p) {
    return makeUri(this.user, p);
  }
  async readDir(p) {
    return vscode.workspace.fs.readDirectory(this.uri(p));
  }
  async stat(p) {
    return vscode.workspace.fs.stat(this.uri(p));
  }
  async text(p) {
    return dec.decode(await vscode.workspace.fs.readFile(this.uri(p)));
  }

  /** every file path below `p` (absolute shell paths), using the cached repo trees */
  async walk(p, withDirs = false) {
    const out = [];
    const rec = async (dir) => {
      if (this.abort) return;
      const entries = await this.readDir(dir);
      entries.sort((a, b) => a[0].localeCompare(b[0]));
      for (const [name, type] of entries) {
        const full = (dir === "/" ? "" : dir) + "/" + name;
        if (type === vscode.FileType.Directory) {
          if (withDirs) out.push({ path: full, dir: true });
          await rec(full);
        } else out.push({ path: full, dir: false });
      }
    };
    await rec(p);
    return out;
  }

  /* execution */
  async run(line) {
    const trimmed = line.trim();
    if (!trimmed) return this.prompt();
    this.history.push(trimmed);
    this.histIdx = this.history.length;
    this.busy = true;
    this.abort = false;
    try {
      const tokens = tokenize(trimmed);
      const pipeline = [[]];
      for (const t of tokens) {
        if (t === "|") pipeline.push([]);
        else pipeline[pipeline.length - 1].push(t);
      }
      let stdin = "";
      for (let i = 0; i < pipeline.length; i++) {
        const [cmd, ...args] = pipeline[i];
        if (!cmd) throw new Error("syntax error near `|`");
        const last = i === pipeline.length - 1;
        const out = await this.exec(cmd, args, stdin);
        if (last) {
          if (out) this.print(out.endsWith("\n") ? out : out + "\n");
        } else stdin = out || "";
      }
    } catch (e) {
      this.print(`${C.red}${e && e.message ? e.message : e}${C.reset}\n`);
    } finally {
      this.busy = false;
      if (!this._closed) {
        this.prompt();
        const queued = this.pending;
        this.pending = [];
        for (const k of queued) this.key(k);
      }
    }
  }

  async exec(cmd, args, stdin) {
    const fn = this.commands()[cmd];
    if (!fn) throw new Error(`${cmd}: command not found (try ${C.cyan}help${C.reset}${C.red})`);
    return fn.call(this, args, stdin);
  }

  commands() {
    const self = this;
    const flags = (args) => {
      const f = new Set();
      const rest = [];
      for (const a of args) {
        if (/^-[a-zA-Z]+$/.test(a)) for (const ch of a.slice(1)) f.add(ch);
        else rest.push(a);
      }
      return { f, rest };
    };
    const numOpt = (args, def) => {
      const i = args.indexOf("-n");
      if (i !== -1 && args[i + 1]) {
        const n = parseInt(args[i + 1], 10);
        args = args.filter((_, j) => j !== i && j !== i + 1);
        return { n: isNaN(n) ? def : n, args };
      }
      return { n: def, args };
    };
    const humanSize = (n) => (n < 1024 ? `${n}` : n < 1048576 ? (n / 1024).toFixed(1) + "K" : (n / 1048576).toFixed(1) + "M");
    const colorName = (name, dir) => (dir ? `${C.blue}${name}/${C.reset}` : name);

    return {
      help() {
        return [
          `${C.bold}GitHub Shell${C.reset} - available commands`,
          `  ${C.cyan}ls [-l] [path]${C.reset}        list directory`,
          `  ${C.cyan}cd <path>${C.reset}             change directory (cd ~ = all repos)`,
          `  ${C.cyan}pwd${C.reset}                   print working directory`,
          `  ${C.cyan}cat <file...>${C.reset}         print files`,
          `  ${C.cyan}head|tail [-n N] [file]${C.reset}`,
          `  ${C.cyan}wc [-l] [file]${C.reset}        count lines / words / bytes`,
          `  ${C.cyan}grep [-inrl] pat [path]${C.reset}  search text (supports pipes)`,
          `  ${C.cyan}find [path] [-name glob]${C.reset}`,
          `  ${C.cyan}tree [-L depth] [path]${C.reset}`,
          `  ${C.cyan}open <file>${C.reset}           open file in the editor`,
          `  ${C.cyan}repos [filter]${C.reset}        list repositories of ${self.user}`,
          `  ${C.cyan}github [path]${C.reset}         open the path on github.com`,
          `  ${C.cyan}switch <user>${C.reset}         load another GitHub user`,
          `  ${C.cyan}rate${C.reset}                  show GitHub API rate limit`,
          `  ${C.cyan}whoami, date, uname, history, echo, clear, exit${C.reset}`,
          `Pipes (${C.yellow}|${C.reset}) are supported between commands. Tab completes paths.`,
        ].join("\n");
      },
      pwd() {
        return self.cwd;
      },
      whoami() {
        return self.user;
      },
      date() {
        return new Date().toString();
      },
      uname() {
        return "VSCodeWeb 1.0 (browser) x-wasm-less js";
      },
      echo(args) {
        return args.join(" ");
      },
      clear() {
        self._write.fire("\x1b[2J\x1b[3J\x1b[H");
        return "";
      },
      history() {
        return self.history.map((h, i) => `${String(i + 1).padStart(4)}  ${h}`).join("\n");
      },
      exit() {
        self._closed = true;
        self._close.fire(0);
        return "";
      },
      async cd(args) {
        const target = self.resolve(args[0] || "~");
        const st = await self.stat(target);
        if (st.type !== vscode.FileType.Directory) throw new Error(`cd: ${args[0]}: Not a directory`);
        self.cwd = target;
        return "";
      },
      async ls(args) {
        const { f, rest } = flags(args);
        const target = self.resolve(rest[0] || ".");
        const st = await self.stat(target);
        if (st.type !== vscode.FileType.Directory) return baseName(target);
        let entries = await self.readDir(target);
        entries.sort((a, b) => {
          const da = a[1] === vscode.FileType.Directory ? 0 : 1;
          const db = b[1] === vscode.FileType.Directory ? 0 : 1;
          return da - db || a[0].localeCompare(b[0]);
        });
        if (!f.has("a")) entries = entries.filter(([n]) => !n.startsWith("."));
        if (f.has("l")) {
          const lines = [];
          for (const [name, type] of entries) {
            const isDir = type === vscode.FileType.Directory;
            let size = "-";
            if (!isDir) {
              try {
                size = humanSize((await self.stat((target === "/" ? "" : target) + "/" + name)).size);
              } catch (_) {}
            }
            lines.push(`${isDir ? "dr-xr-xr-x" : "-r--r--r--"} ${size.padStart(7)}  ${colorName(name, isDir)}`);
          }
          return lines.join("\n");
        }
        return entries.map(([n, t]) => colorName(n, t === vscode.FileType.Directory)).join("  ");
      },
      async cat(args, stdin) {
        if (args.length === 0) return stdin;
        const parts = [];
        for (const a of args) parts.push(await self.text(self.resolve(a)));
        return parts.join("");
      },
      async head(args, stdin) {
        const { n, args: rest } = numOpt(args, 10);
        const text = rest[0] ? await self.text(self.resolve(rest[0])) : stdin;
        return text.split("\n").slice(0, n).join("\n");
      },
      async tail(args, stdin) {
        const { n, args: rest } = numOpt(args, 10);
        const text = (rest[0] ? await self.text(self.resolve(rest[0])) : stdin).replace(/\n$/, "");
        return text.split("\n").slice(-n).join("\n");
      },
      async wc(args, stdin) {
        const { f, rest } = flags(args);
        const text = rest[0] ? await self.text(self.resolve(rest[0])) : stdin;
        const lines = text === "" ? 0 : text.split("\n").length - (text.endsWith("\n") ? 1 : 0);
        const words = text.split(/\s+/).filter(Boolean).length;
        const bytes = enc.encode(text).length;
        if (f.has("l")) return String(lines);
        return `${lines} ${words} ${bytes}`;
      },
      async grep(args, stdin) {
        const { f, rest } = flags(args);
        const pattern = rest.shift();
        if (pattern === undefined) throw new Error("usage: grep [-inrl] pattern [path...]");
        let re;
        try {
          re = new RegExp(pattern, f.has("i") ? "i" : "");
        } catch (_) {
          re = new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), f.has("i") ? "i" : "");
        }
        const results = [];
        const scan = (text, label) => {
          const lines = text.split("\n");
          let matched = false;
          for (let i = 0; i < lines.length; i++) {
            if (re.test(lines[i])) {
              matched = true;
              if (f.has("l")) break;
              const prefix = (label ? `${C.magenta}${label}${C.reset}:` : "") + (f.has("n") ? `${C.green}${i + 1}${C.reset}:` : "");
              results.push(prefix + lines[i]);
            }
          }
          if (matched && f.has("l")) results.push(label);
        };
        if (rest.length === 0 && !f.has("r")) {
          scan(stdin, "");
          return results.join("\n");
        }
        const roots = rest.length ? rest : ["."];
        let files = [];
        for (const r of roots) {
          const p = self.resolve(r);
          const st = await self.stat(p);
          if (st.type === vscode.FileType.Directory) {
            if (!f.has("r")) throw new Error(`grep: ${r}: Is a directory (use -r)`);
            files = files.concat((await self.walk(p)).map((x) => x.path));
          } else files.push(p);
        }
        if (files.length > 400) {
          self.print(`${C.yellow}grep: limiting search to the first 400 of ${files.length} files${C.reset}\n`);
          files = files.slice(0, 400);
        }
        const multi = files.length > 1;
        let idx = 0;
        const worker = async () => {
          while (idx < files.length && !self.abort) {
            const p = files[idx++];
            if (/\.(png|jpe?g|gif|webp|ico|pdf|zip|gz|woff2?|ttf|otf|mp[34]|wasm|bin|exe|class|jar)$/i.test(p)) continue;
            try {
              const text = await self.text(p);
              if (text.indexOf("\u0000") !== -1) continue;
              scan(text, multi || f.has("r") ? p.replace(/^\//, "") : "");
            } catch (_) {}
          }
        };
        await Promise.all([worker(), worker(), worker(), worker(), worker(), worker()]);
        return results.join("\n");
      },
      async find(args) {
        const nameIdx = args.indexOf("-name");
        let re = null;
        if (nameIdx !== -1) {
          re = globToRegExp(args[nameIdx + 1] || "*");
          args = args.filter((_, i) => i !== nameIdx && i !== nameIdx + 1);
        }
        const start = self.resolve(args[0] || ".");
        const all = await self.walk(start, true);
        return all
          .filter((e) => !re || re.test(baseName(e.path)))
          .map((e) => e.path.replace(/^\//, "") || ".")
          .join("\n");
      },
      async tree(args) {
        let depth = Infinity;
        const li = args.indexOf("-L");
        if (li !== -1) {
          depth = parseInt(args[li + 1], 10) || Infinity;
          args = args.filter((_, i) => i !== li && i !== li + 1);
        }
        const root = self.resolve(args[0] || ".");
        const lines = [root === "/" ? "~" : baseName(root)];
        let count = 0;
        const rec = async (dir, prefix, level) => {
          if (level > depth || self.abort) return;
          const entries = await self.readDir(dir);
          entries.sort((a, b) => {
            const da = a[1] === vscode.FileType.Directory ? 0 : 1;
            const db = b[1] === vscode.FileType.Directory ? 0 : 1;
            return da - db || a[0].localeCompare(b[0]);
          });
          for (let i = 0; i < entries.length; i++) {
            const [name, type] = entries[i];
            const isLast = i === entries.length - 1;
            const isDir = type === vscode.FileType.Directory;
            lines.push(prefix + (isLast ? "\u2514\u2500\u2500 " : "\u251c\u2500\u2500 ") + colorName(name, isDir).replace(/\/(\x1b\[0m)?$/, "$1"));
            if (++count > 3000) return;
            if (isDir) await rec((dir === "/" ? "" : dir) + "/" + name, prefix + (isLast ? "    " : "\u2502   "), level + 1);
          }
        };
        await rec(root, "", 1);
        if (count > 3000) lines.push(`${C.yellow}... output truncated${C.reset}`);
        return lines.join("\n");
      },
      async repos(args) {
        const list = await self.data.repos(self.user);
        const filter = (args[0] || "").toLowerCase();
        const rows = list
          .filter((r) => !filter || r.name.toLowerCase().includes(filter) || r.description.toLowerCase().includes(filter))
          .map(
            (r) =>
              `${C.blue}${r.name}${C.reset}${r.fork ? C.dim + " (fork)" + C.reset : ""}${r.archived ? C.dim + " (archived)" + C.reset : ""}` +
              (r.description ? `\n    ${C.dim}${r.description}${C.reset}` : ""),
          );
        return rows.join("\n") + `\n${C.dim}${rows.length} repositories${C.reset}`;
      },
      async open(args) {
        if (!args[0]) throw new Error("usage: open <file>");
        const uri = self.uri(self.resolve(args[0]));
        const st = await vscode.workspace.fs.stat(uri);
        if (st.type === vscode.FileType.Directory) {
          await vscode.commands.executeCommand("revealInExplorer", uri);
        } else {
          await vscode.window.showTextDocument(uri, { preview: false });
        }
        return "";
      },
      async github(args) {
        const p = self.resolve(args[0] || ".");
        await vscode.env.openUri(githubUrl(self.user, p, await self.data.repos(self.user)));
        return "";
      },
      async switch(args) {
        if (!args[0]) throw new Error("usage: switch <github-username>");
        await vscode.commands.executeCommand("ghrepo.navigate", args[0]);
        return "";
      },
      async rate() {
        const r = await getJson(`${GH_API}/rate_limit`);
        const c = r.resources.core;
        return `GitHub API core: ${c.remaining}/${c.limit} remaining, resets ${new Date(c.reset * 1000).toLocaleTimeString()}`;
      },
    };
  }
}

function githubUrl(user, path, repos) {
  const segs = splitPath(path);
  if (segs.length === 0) return vscode.Uri.parse(`https://github.com/${user}?tab=repositories`);
  const info = (repos || []).find((r) => r.name.toLowerCase() === segs[0].toLowerCase());
  const branch = info ? info.branch : "main";
  if (segs.length === 1) return vscode.Uri.parse(`https://github.com/${user}/${segs[0]}`);
  return vscode.Uri.parse(`https://github.com/${user}/${segs[0]}/blob/${branch}/${encodePath(segs.slice(1).join("/"))}`);
}

/* --------------------------------------------------------------- activation */

function activate(context) {
  const data = new GitHubData(context);
  const fsProvider = new GitHubFileSystem(data);

  context.subscriptions.push(
    vscode.workspace.registerFileSystemProvider(SCHEME, fsProvider, {
      isCaseSensitive: true,
      isReadonly: new vscode.MarkdownString(
        "GitHub repositories are mounted **read-only** from `raw.githubusercontent.com`.",
      ),
    }),
  );

  const user = () => currentUser();

  /* status bar */
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 1000);
  status.command = "ghrepo.switchUser";
  const updateStatus = () => {
    const u = user();
    if (!u) return status.hide();
    status.text = `$(github) ${u}`;
    status.tooltip = `Browsing github.com/${u} - click to switch user`;
    status.show();
  };
  updateStatus();
  context.subscriptions.push(status, vscode.workspace.onDidChangeWorkspaceFolders(updateStatus));

  /* commands */
  context.subscriptions.push(
    vscode.commands.registerCommand("ghrepo.switchUser", async () => {
      const value = await vscode.window.showInputBox({
        title: "Switch GitHub User",
        prompt: "Enter a GitHub username - all of their public repositories will be mounted in the Explorer",
        placeHolder: "octocat",
        value: user() || "",
        validateInput: (v) => (/^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,38})$/.test(v.trim()) ? undefined : "Not a valid GitHub username"),
      });
      if (value && value.trim()) await vscode.commands.executeCommand("ghrepo.navigate", value.trim());
    }),
    vscode.commands.registerCommand("ghrepo.refresh", async () => {
      await data.clear();
      await vscode.commands.executeCommand("workbench.action.reloadWindow");
    }),
    vscode.commands.registerCommand("ghrepo.openOnGitHub", async (resource) => {
      const uri = resource instanceof vscode.Uri ? resource : vscode.window.activeTextEditor && vscode.window.activeTextEditor.document.uri;
      if (!uri || uri.scheme !== SCHEME) return vscode.window.showInformationMessage("Open a file from a mounted GitHub repository first.");
      await vscode.env.openUri(githubUrl(uri.authority, uri.path, await data.repos(uri.authority)));
    }),
    vscode.commands.registerCommand("ghrepo.openShell", () => {
      const u = user();
      if (!u) return vscode.window.showInformationMessage("No GitHub workspace is open.");
      const term = vscode.window.createTerminal({
        name: "GitHub Shell",
        pty: new GitHubShell(data, fsProvider, u),
        iconPath: new vscode.ThemeIcon("github"),
      });
      term.show();
    }),
  );

  /* web terminal profile (no pty host exists in a static browser runtime) */
  context.subscriptions.push(
    vscode.window.registerTerminalProfileProvider("ghrepo.shell", {
      provideTerminalProfile() {
        const u = user() || "guest";
        return new vscode.TerminalProfile({
          name: "GitHub Shell",
          pty: new GitHubShell(data, fsProvider, u),
          iconPath: new vscode.ThemeIcon("github"),
        });
      },
    }),
  );

  /* friendly landing: show the profile README (user/user) or the first repo README */
  (async () => {
    const u = user();
    if (!u) return;
    try {
      if (vscode.window.visibleTextEditors.length > 0 || vscode.window.tabGroups.all.some((g) => g.tabs.length > 0)) return;
      const repos = await data.repos(u);
      const profile = repos.find((r) => r.name.toLowerCase() === u.toLowerCase());
      const target = profile || repos[0];
      if (!target) return;
      const readme = makeUri(u, `/${target.name}/README.md`);
      await vscode.workspace.fs.stat(readme);
      await vscode.window.showTextDocument(readme, { preview: true });
    } catch (_) {
      /* no README - leave the editor area empty */
    }
  })();
}

function deactivate() {}

module.exports = { activate, deactivate };
