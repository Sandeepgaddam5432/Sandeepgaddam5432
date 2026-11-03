# VS Code for the Web - GitHub repos in the native Explorer

This project ships the **official, unmodified Microsoft VS Code Web** runtime (`vscode-web.tar.gz`,
the same artifact `@vscode/test-web` uses) as a 100% static site. There is no React/Tailwind re-creation
of the UI: the workbench (`out/vs/workbench/workbench.web.main.internal.js`), codicons, Command Palette,
Settings, Keybindings, split editors, tabs and the terminal panel are all VS Code's own code.

## How it works

| Piece | Location |
| --- | --- |
| Official VS Code Web runtime (vendored) | `public/out`, `public/extensions`, `public/node_modules` |
| Embedder / bootstrap (`create()` call, `workspaceProvider`) | `public/boot.js`, loaded from `index.html` |
| Built-in web extension `github-repo-provider` | `public/extensions/github-repo-provider` |
| Runtime fetch / refresh script | `scripts/fetch-vscode-web.mjs` |

* **User resolution:** `?user=<name>` -> `VITE_GITHUB_USERNAME` / `GITHUB_USERNAME` (build time) -> `Sandeepgaddam5432`.
* **Native Explorer injection:** `workspaceProvider` opens a multi-root workspace
  `ghrepo://<user>/<user>.code-workspace`. The extension registers a `ghrepo:` `FileSystemProvider`
  (`vscode.workspace.registerFileSystemProvider`) and every public repo becomes a workspace folder.
* **Data:** repo list from `api.github.com`, directory trees from the git-trees API (jsDelivr as fallback),
  file contents from `raw.githubusercontent.com`. Read-only.
* **Terminal:** a "GitHub Shell" terminal profile (pure in-browser JS pseudoterminal: `ls cd cat grep find tree open repos ...`),
  since a static browser runtime has no pty host.
* **Extensions view:** backed by Open VSX.

## Commands

```bash
npm run build            # static output in dist/ (GitHub Pages ready, relative URLs)
GITHUB_USERNAME=octocat npm run build
node scripts/fetch-vscode-web.mjs   # re-download / upgrade the VS Code Web runtime (VSCODE_COMMIT=<sha> to pin)
node scripts/snapshot-repos.mjs     # optional: embed the repo list as a rate-limit fallback
```

Anonymous GitHub API access is limited to 60 requests/hour per IP; the extension caches results
and falls back to jsDelivr (file lists) and the optional snapshot (repo list).
