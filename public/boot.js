/**
 * Bootstrap for the OFFICIAL Microsoft VS Code Web workbench (vscode-web).
 *
 * The workbench is the unmodified `vs/workbench/workbench.web.main.internal.js`
 * bundle shipped by Microsoft. This file plays the role of the embedder
 * (what `workbench.html` + `workbench.js` do on a server): it resolves the
 * GitHub user, builds the workspace and calls the public `create()` API.
 *
 * User resolution order:
 *   1. ?user=<username>                                  (URL query)
 *   2. VITE_GITHUB_USERNAME / GITHUB_USERNAME            (build-time env, via <meta name="github-username">)
 *   3. Sandeepgaddam5432                                 (default)
 */
(async () => {
  const DEFAULT_USER = "Sandeepgaddam5432";
  const SCHEME = "ghrepo";
  const USER_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;

  const boot = document.getElementById("boot-status");
  const setStatus = (msg) => boot && (boot.textContent = msg);

  try {
    const baseUrl = new URL("./", location.href);
    const base = baseUrl.toString().replace(/\/$/, "");

    /* ---- resolve target user ------------------------------------------ */
    const params = new URLSearchParams(location.search);
    const meta = document.querySelector('meta[name="github-username"]');
    const envRaw = meta ? (meta.getAttribute("content") || "").trim() : "";
    const envUser = envRaw.startsWith("%") ? "" : envRaw; // un-substituted placeholder -> unset
    const user =
      [params.get("user"), envUser, DEFAULT_USER].map((u) => (u || "").trim()).find((u) => u && USER_RE.test(u)) ||
      DEFAULT_USER;

    /* ---- runtime globals the workbench expects -------------------------- */
    const version = await (await fetch(`${base}/vscode-version.json`)).json();
    globalThis._VSCODE_FILE_ROOT = `${base}/out/`;

    setStatus("Loading workbench...");
    document.head.appendChild(
      Object.assign(document.createElement("link"), {
        rel: "stylesheet",
        href: `${base}/out/vs/workbench/workbench.web.main.internal.css`,
      }),
    );
    document.head.appendChild(
      Object.assign(document.createElement("link"), { rel: "icon", href: `${base}/favicon.ico` }),
    );

    await import(`${base}/out/nls.messages.js`); // built-in English NLS messages
    const { create, URI } = await import(`${base}/out/vs/workbench/workbench.web.main.internal.js`);

    /* ---- workspace: one multi-root workspace, one folder per repo -------- */
    const workspaceUri = URI.from({ scheme: SCHEME, authority: user, path: `/${user}.code-workspace` });

    const navigateToUser = (next) => {
      const target = new URL(location.href);
      target.searchParams.set("user", next);
      return target.toString();
    };

    const userFromWorkspace = (ws) => {
      const uri = ws && (ws.workspaceUri || ws.folderUri);
      return uri && uri.scheme === SCHEME ? uri.authority : undefined;
    };

    const workspaceProvider = {
      workspace: { workspaceUri },
      trusted: true,
      async open(workspace, options) {
        const next = userFromWorkspace(workspace) || user;
        const target = navigateToUser(next);
        if (options && options.reuse === false) {
          window.open(target, "_blank");
        } else {
          location.assign(target);
        }
        return true;
      },
    };

    const loc = new URL(`${base}/extensions/github-repo-provider`);

    create(document.body, {
      productConfiguration: {
        nameShort: "Code",
        nameLong: "Visual Studio Code",
        applicationName: "code",
        quality: version.quality,
        commit: version.commit,
        version: version.version,
        // Serve the extension-host iframe locally (static hosting, no *.vscode-cdn.net round trip).
        webEndpointUrlTemplate: "",
        // Extensions are resolved from Open VSX (Microsoft's marketplace is licensed for MS products only).
        extensionsGallery: {
          serviceUrl: "https://open-vsx.org/vscode/gallery",
          itemUrl: "https://open-vsx.org/vscode/item",
          resourceUrlTemplate: "https://open-vsx.org/vscode/unpkg/{publisher}/{name}/{version}/{path}",
          controlUrl:
            "https://raw.githubusercontent.com/EclipseFdn/publish-extensions/refs/heads/master/extension-control/extensions.json",
          nlsBaseUrl: "",
          publisherUrl: "https://open-vsx.org/vscode/publisher",
        },
        linkProtectionTrustedDomains: ["https://github.com", "https://raw.githubusercontent.com", "https://open-vsx.org"],
      },
      workspaceProvider,
      enableWorkspaceTrust: false,
      additionalBuiltinExtensions: [
        { scheme: loc.protocol.replace(":", ""), authority: loc.host, path: loc.pathname },
      ],
      configurationDefaults: {
        "workbench.startupEditor": "none",
        "workbench.colorTheme": "Default Dark Modern",
        "security.workspace.trust.enabled": false,
        "telemetry.telemetryLevel": "off",
        "window.commandCenter": true,
        "explorer.compactFolders": false,
        "files.exclude": { "**/.git": true },
        "terminal.integrated.defaultProfile.windows": "GitHub Shell",
        "terminal.integrated.defaultProfile.osx": "GitHub Shell",
        "terminal.integrated.defaultProfile.linux": "GitHub Shell",
      },
      commands: [
        {
          // invoked by the github-repo-provider extension ("GitHub Repos: Switch GitHub User...")
          id: "ghrepo.navigate",
          handler: (next) => {
            if (typeof next === "string" && USER_RE.test(next.trim())) location.assign(navigateToUser(next.trim()));
          },
        },
      ],
    });

    // remove the splash once the real workbench is on screen
    const done = () => {
      const splash = document.getElementById("boot");
      if (splash) splash.remove();
    };
    if (document.querySelector(".monaco-workbench")) done();
    else {
      const mo = new MutationObserver(() => {
        if (document.querySelector(".monaco-workbench")) {
          mo.disconnect();
          done();
        }
      });
      mo.observe(document.body, { childList: true, subtree: true });
    }
  } catch (err) {
    console.error("[vscode-web] boot failed", err);
    setStatus("Failed to start VS Code Web: " + (err && err.message ? err.message : err));
  }
})();
