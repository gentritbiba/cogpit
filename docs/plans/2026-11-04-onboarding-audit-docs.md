> Audit evidence for [the onboarding tracker](2026-11-04-beginner-onboarding.md). Screenshot and sandbox paths under /tmp/onboard-qa/ were temporary and no longer exist.

# Cogpit newcomer journey audit: docs, installers, code paths

Date: 2026-11-04 · Repo HEAD `75b4104e` (v3.5.4) plus the uncommitted working tree · Read-only audit

**Method.** I read README.md, docs/usage.md, docs/self-hosting.md and packages/cogpit-cli/README.md, then traced the code under electron/, server/ and src/.

I also ran the `npx` launcher (`packages/cogpit-cli/dist/cli.js`, built Oct 30) in a sandbox:
- `env -i`, so no `COGPIT_*` variables were inherited
- an empty `HOME=/tmp/onboard-qa/home` and no agent CLIs on PATH
- a random loopback port, never 19384

In that sandbox I ran three scenarios:
- **(a)** No agent history at all.
- **(b)** An empty `~/.claude/projects`.
- **(c)** A deliberately invalid `ANTHROPIC_API_KEY`, to reproduce a signed-out failure safely without touching the real account.

The sandbox server and its Claude child were stopped afterwards, and the sandbox folders were deleted. The captured output is in `/tmp/onboard-qa/sandbox-evidence.txt`. No browser was opened and nothing in the repo was edited.

**Severity:**
- **blocker:** a newcomer cannot get to a working session without outside help.
- **major:** likely confusion, abandonment or risk.
- **minor:** polish.

**Size:** S < ½ day · M ≈ 1–3 days · L > 3 days.

---

## Stage 0: "What is Cogpit?" (README)

| # | Finding | Evidence | Sev | Fix (size) |
|---|---|---|---|---|
| 0.1 | The prerequisite is stated, and linked, as the first line of "Get started". But it sits about 35 lines down, below the feature list. The intro only says "uses your existing CLI logins". A reader who skims the hero and goes straight to Download never learns that Cogpit has no models of its own. self-hosting.md says this much more bluntly. | README.md:23, README.md:38. Compare docs/self-hosting.md:13-14: "It does not replace them and it has no models of its own." | minor | Add one sentence to the hero (README.md:6-8): "Cogpit is a window onto Claude Code, Codex or Copilot CLI. Install and sign in to one of them first." (S) |
| 0.2 | The README doesn't say the CLI must have been **used** before. On desktop, a Claude-only user is gated by a setup screen that needs `~/.claude/projects` (see 2.1). "Install and sign in" is not enough. | README.md:38; server/config.ts:356-360 | major | Fix the code (2.1). Until then, add "run `claude` once in any folder" to Get started. (S) |
| 0.3 | The Node version contradicts itself: the README says **20.11**, while the launcher README, `engines` and the runtime check all say **22.16**. A user on Node 20 or 21 follows the README and gets an error. | README.md:57 "With Node.js 20.11 or newer"; packages/cogpit-cli/README.md:20 "Node.js 22.16 or newer"; packages/cogpit-cli/package.json `"node": ">=22.16"`; packages/cogpit-cli/scripts/build-npm.mjs:49-50 | major | Change README.md:57 to 22.16 and link nodejs.org. (S) |
| 0.4 | There's no macOS Gatekeeper guidance. Release builds are ad-hoc signed and not notarized, so the first open of a downloaded DMG is blocked: Apple "could not verify" it, and the user must go to System Settings → Privacy & Security → Open Anyway. The README covers Windows SmartScreen but not this. | .github/workflows/release.yml:180 `CSC_IDENTITY_AUTO_DISCOVERY: "false"`; electron/macBundleUpdate.ts:9 "Release builds are ad-hoc signed"; no notarize step in electron-builder.yml:48-63; README.md:53 is Windows-only | **blocker** (for macOS non-developers) | Short term: add a macOS paragraph next to README.md:53 with the Open Anyway steps (S). Long term: Developer ID signing and notarization (M; it also unblocks Squirrel.Mac). |
| 0.5 | "Build from source" assumes Bun is installed and gives no link or version. self-hosting.md links bun.sh, but README doesn't. | README.md:137-142; docs/self-hosting.md:20 | minor | Add "Requires [Bun](https://bun.sh)". (S) |
| 0.6 | There's no "Your first session" page. usage.md opens with "select a project and a session", which assumes existing history. No doc walks through: open app → pick folder → type task → approve. | docs/usage.md:3; `docs/` has no quickstart (searched for first session, quick start, getting started, new session) | major | Add `docs/first-session.md` (about 40 lines, with 3 screenshots) and link it from the README and from in-app empty states. (S) |
| 0.7 | Agent CLI links point at the older `docs.anthropic.com/en/docs/claude-code` URL and the Codex GitHub repo, not their install or login quickstarts. | README.md:38 | minor | Link straight to each CLI's install-and-login page. (S) |

## Stage 1: Installing and launching

### 1A. `npx cogpit`

I ran the launcher with `node dist/cli.js` (sandbox output below).

| # | Finding | Evidence | Sev | Fix (size) |
|---|---|---|---|---|
| 1.1 | **First-run output is minimal and slightly alarming.** Exactly this is printed: `(node:…) ExperimentalWarning: SQLite is an experimental feature and might change at any time` / `(Use node --trace-warnings ... …)` / `Cogpit is running at http://127.0.0.1:55584/` / `Press Ctrl+C to stop.` The warning comes from `node:sqlite` and looks like a problem to a beginner. Nothing says which agent CLIs were found or whether setup is needed. | /tmp/onboard-qa/sandbox-evidence.txt; server/orchestration/database.ts:8; packages/cogpit-cli/src/index.ts:263-264 | major | (a) Suppress that one ExperimentalWarning in the CLI shim, before importing the runtime (`process.removeAllListeners('warning')` filtered to SQLite, or `--disable-warning=ExperimentalWarning` via `NODE_OPTIONS`). (b) After start, print a short environment check: `✓ Claude Code 2.1.306 (signed in?) · ✗ Codex not found → npm i -g @openai/codex`. (M) |
| 1.2 | **The old-Node path is good.** `cli.js` prints `Cogpit requires Node.js 22.16 or newer. Please upgrade Node.js.` and exits 1. npm will also show an EBADENGINE warning first. | packages/cogpit-cli/scripts/build-npm.mjs:47-54; dist/cli.js | ok | Add a download link to the message (`https://nodejs.org`). (S) |
| 1.3 | **`--help` and argument errors are fine.** `cogpit foo` → `Unknown command: foo` / ``Run `cogpit --help` for usage.``, exit 1. The help text never mentions that an agent CLI is needed. | packages/cogpit-cli/src/index.ts:35-47, 225-230 | minor | Add one line to USAGE: "Needs Claude Code, Codex or Copilot CLI installed and signed in." (S) |
| 1.4 | **Linux `npx` compiles node-pty from source.** node-pty 1.1.0 ships prebuilds only for darwin-x64/arm64 and win32-x64/arm64. On Linux the install script falls back to `node-gyp rebuild`, which needs python3, make and g++. A fresh box fails mid-`npx` with a gyp stack trace. | `node_modules/node-pty/prebuilds/` (darwin-*, win32-* only); node-pty package.json `"install": "node scripts/prebuild.js \|\| node-gyp rebuild"`; packages/cogpit-cli/package.json deps | major (Linux) | Document "On Linux, install build-essential and python3 first" (S). Or make the PTY optional for the launcher and degrade the terminal panel (M). |
| 1.5 | **With no Claude Code installed, `npx` still has a Claude.** It falls back to the Agent SDK's vendored binary. In the sandbox, `/api/provider-updates` reported Claude `installed:true` from `…/claude-agent-sdk-darwin-arm64/claude` and `status:"behind"`, with `updateCommand:null`. So for an npx user, "no CLI" really means "a signed-out Claude" (see 3.1), and the "behind" badge offers no update path. The packaged desktop app behaves differently: it omits this binary, so there "no CLI" is a hard failure (see 3.4). | server/agents/claudeExecutable.ts:4-10; sandbox `/api/provider-updates` response | major | Detect when the vendored binary has no credentials, and show the sign-in guidance from 3.4. Hide "behind" for the vendored copy. (M) |
| 1.6 | The launcher README says session data "is never uploaded". The prompts themselves do go to the model provider. README.md:129 words this correctly. | packages/cogpit-cli/README.md:10-12 | minor | Reuse the README.md:129 wording. (S) |

### 1B. Desktop app first launch

| # | Finding | Evidence | Sev | Fix (size) |
|---|---|---|---|---|
| 1.7 | **No window until the server is ready.** There's no splash screen or `show:false`/`ready-to-show`. The window is created only after the worker posts `ready`, which can take up to 15 s. Before that, a synchronous `execSync(\`${SHELL} -ilc 'echo -n "$PATH"'\`)` runs with **no timeout**. A shell startup file that prompts (oh-my-zsh update, conda init) can hang launch before anything appears. | electron/main.ts:14-21 (PATH probe), :131-133 (15 s timeout), :160-170 | major | Show a lightweight window or splash immediately. Add `timeout: 3000` to the PATH probe. (S/M) |
| 1.8 | **A worker crash leaves the app hung with no window and no message.** The `exit` handler clears the timeout but never rejects. If the worker dies before posting `ready` (listen error, node-pty ABI mismatch), the promise never settles. The success path just calls `app.quit()` and logs to the console. | electron/main.ts:146-152 (exit handler: `clearTimeout(timeout)`, no reject), :166-171 (`console.error` + `app.quit()`); electron/server-worker.ts:38-40 (no `httpServer.on("error")`) | major | Reject on early exit. Show `dialog.showErrorBox("Cogpit could not start", <reason + log path>)` before quitting. (S) |
| 1.9 | **Permission prompts are well-behaved.** The only usage string is `NSMicrophoneUsageDescription: "Cogpit records from the microphone only while you dictate a message."`, and it's requested on first dictation, not at launch. The Notification prompt appears on the first notification. There are no Documents/Desktop folder probes at startup. | electron-builder.yml:61; src/plugins/dictation/recorder.ts:52; electron/notifications.ts:93; server/config.ts:222-241 | ok | Consider asking for notifications on purpose from a first-run checklist item rather than on the first background event. (S) |
| 1.10 | The window title flips from "Cogpit" to the page title "Cogpit - Agent Session Dashboard". | electron/main.ts:72-79; index.html:11 | minor | Retitle index.html to "Cogpit". (S) |
| 1.11 | **No onboarding exists anywhere.** I searched src/, server/, electron/ and shared/ for onboard, firstRun, firstLaunch, welcome, hasSeen, tour, walkthrough and "get started". None of them exist, and there's no first-run localStorage key. | (search result) | major | See the top-10 list: a first-run checklist. |

## Stage 2: The setup gate ("Connect your coding agent")

| # | Finding | Evidence | Sev | Fix (size) |
|---|---|---|---|---|
| 2.1 | **Desktop never auto-detects `~/.claude`.** The npx and standalone shells save `~/.claude` automatically when `~/.claude/projects` exists. The desktop shell only runs `loadConfig()`, whose bootstrap checks only **Codex and Copilot** (home directory or binary on PATH), because Claude is `homeIsDiscoverable:false`. So a desktop user who has only Claude Code, or nothing at all, lands on a manual setup screen. Ironically, that's the most common newcomer profile. | server/standalone-runtime.ts:96-102 (auto-save, standalone only); server/app-server.ts:105 (desktop: `loadConfig()` only); server/config.ts:222-242 (`detectBootstrapConfig` only checks discoverable agents); shared/session/agent-descriptors.ts:637-638 | **blocker** | Move the `~/.claude/projects` auto-detect into `detectBootstrapConfig`, so every shell shares it. Also treat a `claude` binary on PATH as bootstrap evidence, like Codex and Copilot already are. (S) |
| 2.2 | **The setup screen copy.** Title: "Connect your coding agent". Body: "Cogpit detects Codex and GitHub Copilot CLI automatically. Existing histories live in `~/.codex` and `~/.copilot/session-state`. For Claude Code, enter its data directory, usually `~/.claude`." The input is labeled "Claude Code data directory" with placeholder `/Users/you/.claude`, and the button reads "Connect Claude Code". There's no folder picker, no install links, no "I don't have any of these" path and no skip. | src/components/SetupScreen.tsx:94-117, :160 | major | Rewrite it as an environment check, with one row per CLI: found/not found, signed in, an install link and a "Check again" button. Make the Claude directory an optional advanced field with a native folder picker (Electron `dialog.showOpenDialog`). (M) |
| 2.3 | **Typing the suggested `~/.claude` fails.** `validateClaudeDir` uses `resolve()` with no tilde expansion. Sandbox: `GET /api/config/validate?path=~/.claude` → `{"valid":false,"error":"Path does not exist"}`. | server/config.ts:341-351; sandbox reproduction | **blocker** (for anyone who types what the screen suggests) | Expand a leading `~` server-side in `validateClaudeDir` and the save path. Pre-fill the input with the detected absolute home path. (S) |
| 2.4 | **A freshly installed, never-used Claude Code can't pass the gate.** A `~/.claude` without `projects/` gives: `Directory does not contain a "projects" subdirectory. This does not appear to be a valid .claude directory.` A user who has just installed and signed in, but not yet run a session, is stuck, and the message doesn't say how to fix it. | server/config.ts:353-360; sandbox reproduction | **blocker** | Accept a `~/.claude` that exists, creating `projects/` lazily. Or bootstrap with the placeholder, as Codex does. (S) |
| 2.5 | After setup, the default agent for a Claude-only user isn't explicit; it's left to `defaultAgent` in the config. | server/routes/config.ts:136-141 | minor | Set `defaultAgent` from the detected CLI. (S) |

## Stage 3: Missing or signed-out agent CLI

| # | Finding | Evidence | Sev | Fix (size) |
|---|---|---|---|---|
| 3.1 | **A signed-out or bad-auth Claude session looks like a normal reply.** Sandbox (c) with an invalid key: the transcript gets an assistant message `Invalid API key · Fix external API key` with `model:"<synthetic>"`, `error:"authentication_failed"`, `isApiErrorMessage:true`, `apiErrorStatus:401`. `/api/session-status` reports `outcome:"completed"` (not `error`). The renderer treats `<synthetic>` only as "hide the model name" and renders it as plain markdown. Nothing in src/, server/ or shared/ reads `isApiErrorMessage`, `apiErrorStatus` or `authentication_failed`. | sandbox `/api/session-result` + transcript; src/components/timeline/AssistantText.tsx:83-90; grep (no hits) | **blocker** (a first session "succeeds" with a cryptic line) | Parse `isApiErrorMessage` / `error:"authentication_failed"` into an error block with a "Sign in to Claude Code" call to action (see 3.4). Report `outcome:"error"`. (M) |
| 3.2 | **The CLI's own fix text points to something Cogpit can't do.** Signed-out Claude says "… Please run /login". Cogpit has no `/login` handling anywhere in src/, server/ or shared/. | grep `/login` (no hits outside the network-password routes) | major | Intercept `/login`: open a terminal panel running `claude /login` (or `codex login`, `copilot` → `/login`). Or show a copyable command. (M) |
| 3.3 | `create-and-send` (the external session API) starts Claude with `--permission-mode=default`, while the UI's stored default is `bypassPermissions` (see 5.1). The same first task behaves differently depending on the entry point. | sandbox process list: `claude … --permission-mode=default`; src/lib/permissions.ts:23-24 | minor | Document or unify. (S) |
| 3.4 | **Desktop with no Claude Code: a developer-only error, shown only after Send.** The packaged app deliberately drops the SDK's bundled binary. Nothing checks for a CLI before Send. The spawn then fails with the SDK's own text in an 8-second toast: `Native CLI binary for darwin-arm64 not found. Reinstall @anthropic-ai/claude-agent-sdk without --omit=optional, or set options.pathToClaudeCodeExecutable.` That advice is wrong for an end user. Cogpit's friendly helper (`"Claude Code is not installed or not found in PATH. Install it with: npm install -g @anthropic-ai/claude-code"`) exists but is **never called for Claude**; only codexRuntime uses it. | electron-builder.yml:37-38; node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs (string verified); server/agents/spawnError.ts:4-22; callers only at server/agents/codexRuntime.ts:384, :464; src/hooks/useNewSession.ts:361 → src/components/AppStatusToasts.tsx:29-34 | **blocker** | Check for the CLI before Send, and on agent select, using the existing `/api/provider-updates` `installed` flag. Route Claude spawn failures through `friendlySpawnError`. Make the toast persistent, with "How to install" linking to the CLI's install page. (S) |
| 3.5 | **Codex and Copilot "missing" messages have no next step.** Codex: `Codex is not installed or not found in PATH.` (`INSTALL_COMMAND` has only Claude). Copilot: `Failed to start Copilot CLI: copilot was not found on PATH`. In an existing session, errors show as a banner under the composer, with "(details)" opening an "Error details" dialog. | server/agents/spawnError.ts:4-6; server/agents/copilotTransport.ts:896-903; src/components/ChatInput/index.tsx:674-678 (ErrorBanner) | major | Add install commands for every agent from the descriptor's `packageName` (`@openai/codex`, `@github/copilot` are already known to provider-updates). (S) |
| 3.6 | **The provider picker lists every provider whether installed or not,** including "ACP". Uninstalled CLIs still get a hard-coded model list (`/api/models` returns `null` → client fallback), with no "not installed" state. A newcomer can pick Codex, type a task, and only learn on Send that it isn't there. | src/components/ChatInput/settings/ModelPicker.tsx:133-141; src/lib/agents/presentation.ts:160-183; server/routes/models.ts:5-9; src/lib/agents/models.ts:3-6 | major | Grey out uninstalled providers with "Not installed · How to install". Hide ACP unless configured. (S/M) |
| 3.7 | **Sign-in state is never detected.** The runtimes already read account info (Claude `accountInfo()`, Codex `account/read`), but the UI uses them only for the usage meter, which silently disappears when unavailable. `/api/usage` can return "Claude Code credentials not found", but only as a usage-meter fallback, and it's never shown. | server/agents/claudeRuntime.ts:225-232; server/agents/codexRuntime.ts:717; src/lib/agents/quota.ts:98-113; server/routes/usage.ts:193-198 | major | Expose `signedIn: boolean \| unknown` per agent and surface it in the environment check (top 10 #3). (M) |
| 3.8 | **Raw material for an environment check already exists but is unused or buried.** `GET /api/provider-updates` (installed, version, binaryPath, packageName); `GET /api/agent-executable/claude` (its Settings section has the app's only "Not found on this machine." / "No launchable binary for the saved choice — sessions cannot start." copy); `GET /api/{kind}/runtime` (`available`, account). `providerSetupCommand` builds a login command for provider instances but is never shown. There's no `/api/health`, `/api/agents` or doctor endpoint. | server/routes/provider-updates.ts:23-33; src/components/config/ExecutableSection.tsx:49, :116; server/agents/instanceConfigurations.ts:11-18 | n/a | Build the onboarding check on these. Patterns to copy already in-app: ``GitHubPanel.tsx:63 "Run `gh auth login` on the Cogpit host, then refresh."`` and the install command in `BrowserPanel/BrowserEmptyState.tsx:23`. |

## Stage 4: Choosing a folder and starting the first session

**What a newcomer sees first** after setup is **Mission Control** (the home screen). The initial `mainView: "sessions"` resolves to `"dashboard"` → MissionHome (src/hooks/useSessionState.ts:89, src/components/AppShell/desktopView.ts:35).

With zero history it shows:
- an h1 "Mission Control" (MissionHome.tsx:129)
- a composer with placeholder "Pick a project, then describe the task" (HomeComposer.tsx:130)
- a "Choose a project" outline button (HomeComposer.tsx:179)
- a disabled send button titled "Start session (Enter)" (HomeComposer.tsx:146)
- "Nothing is waiting on you." (MissionHome.tsx:146)
- "Your sessions 0" with the empty line "Start a session and it shows up here, with every session it starts." (MissionHome.tsx:329-361)

| # | Finding | Evidence | Sev | Fix (size) |
|---|---|---|---|---|
| 4.1 | **The home composer is the best path and is visible.** "Choose a project" opens the project switcher, and with zero projects it says "No projects found / Try another name, paste an absolute path, or browse the folders." with a sticky "Browse folders…". It works, but it's two clicks deep, and the empty state wording ("No projects found") reads like an error on first launch. | HomeComposer.tsx:130, :179; ProjectSwitcherList.tsx:141, :150-151, :210 | major | On first run (zero projects), make the home's primary button **"Open a folder…"** and go straight to the folder browser, or a native picker in Electron. Replace "No projects found" with "No projects yet — pick any folder to start". (S) |
| 4.2 | **The sidebar is not rendered on home.** `sidebarRendered = showSidebar && mainView !== "config" && !isHome`. The "Show sidebar" pill appears only when the setting is off, which it isn't by default. So on first launch the sidebar's new-session controls and its only visible ⌘K button ("Search (⌘K)") are absent. | src/components/AppShell/DesktopWorkspace.tsx:301; src/components/FloatingChrome.tsx:163-165; src/components/SidebarHeader.tsx:31 | major | Keep a visible ⌘K/search affordance on home. (S) |
| 4.3 | **Sidebar "All projects": no visible new-session button** (known; another session is fixing it). The only control is an icon-only `FolderSearch` button labeled through `title`/`aria-label` "Start a session in a folder". The `+` exists only when focused on a project, and has an `aria-label` but **no `title`**, so hovering shows nothing. | src/components/LiveSessions/ProjectScopePicker.tsx:218-246 | major | Related: add `title` to the `+` button, and use a text label ("New session") at least while the user has fewer than N sessions. (S) |
| 4.4 | **Empty states send the user outside Cogpit.** Sidebar: "No sessions yet / Start Claude Code, Codex, or Copilot to see recent work here." (no button). Projects: "No projects yet / Start Claude Code, Codex, or Copilot and its project will appear here." (it does have "Start in a folder"). Sidebar focused-project empty state: "Start a new session here, or look across every project.", but it offers only "All projects" and "Show archived", with no start button. | src/components/LiveSessions/LiveSessionsChrome.tsx:236-240, :213-224, :289; src/components/Dashboard/ProjectsView.tsx:130-143 | major | Rewrite them as "Start your first session" with a primary "Open a folder…" button. Drop the implication that you must start the CLI elsewhere. (S) |
| 4.5 | **Path entry is strict.** The project switcher accepts only absolute paths (`/`, `C:\`, `\\`), so `~/code/app` silently offers nothing. The folder browser's filter matches names only, so you can't type a path there. Creating a folder works ("New folder", placeholder "New folder name"). "Start session here" has a ⌘↵ shortcut that is declared only in `aria-keyshortcuts`. | ProjectSwitcherList.tsx:103, :164; FolderBrowser.tsx:180, :238, :265, :275 | minor | Accept `~` paths. Allow typing a path in the folder browser. Show the shortcut. (S) |
| 4.6 | **The command palette helps only if you know ⌘K.** "Start a new session" opens the project switcher. The "Projects" group opens dashboards, not sessions. There's no "Browse folders" or "Start in a folder" action. The new-session shortcut is ⌃⌘N on Mac or Ctrl+Alt+N elsewhere, and it appears on screen only in the NewSessionHero popover footer. | src/components/CommandPalette.tsx:197; src/App.tsx:626-631; src/lib/keybindings.ts:87; src/components/AppShell/NewSessionHero.tsx:100-101 | minor | Add a "Start in a folder…" palette action. Show ⌃⌘N in the home composer tooltip. (S) |
| 4.7 | **Projects exist only as agent history.** `/api/projects` lists stores only, so a folder you pick but never send from doesn't stick around as a project. Nothing explains this. | server/routes/projects/projectList.ts:28-35 | minor | Remember recently opened folders client-side or server-side as "Recent folders". (M) |
| 4.8 | **The pending session screen is friendly.** "What should we build in {name}?", with "Switch project" on the project name. It's a good model for the rest of the copy. | src/components/AppShell/NewSessionHero.tsx:38, :73 | ok | n/a |

## Stage 5: Defaults and jargon that can scare a beginner

| # | Finding | Evidence | Sev | Fix (size) |
|---|---|---|---|---|
| 5.1 | **"Full access" is the default for every agent, and the home composer hides it.** `DEFAULT_PERMISSIONS.mode = "bypassPermissions"`. The labels are "Full access": "Skip permission checks" (Claude), "No sandbox or approval checks" (Codex) and "Allow tools, paths, and URLs without asking" (Copilot). That overrides Codex's own safe default ("Workspace"). The home composer renders model and provider settings but **no permission picker**, yet it starts with the stored mode. There's no warning, colour or first-run notice. usage.md states it plainly: "Full access is the default permission mode." | src/lib/permissions.ts:23-24; src/lib/agents/presentation.ts:98-116; src/components/home/HomeComposer.tsx:135-144 (no `permissionMode`); src/App.tsx:490, :529-532; docs/usage.md:42 | **major** (risk: a beginner's first prompt can run unreviewed shell commands and edits) | Default newcomers to each CLI's own ask/workspace mode ("Accept Edits" for Claude, "Workspace" for Codex, "Ask" for Copilot). Show the permission chip in the home composer. Give "Full access" a warning colour and a one-time explanation. Keep existing users' stored choice. (S/M) |
| 5.2 | **Model picker.** It defaults to "Default (recommended)", which is good. But the descriptions carry raw pricing like "Opus 5.5 · Best for everyday, complex tasks · $4/$20 per Mtok". "Mtok" and input/output pricing mean nothing to a subscription user, who pays nothing per token. Effort labels are "Light / Medium / High / Extra High / Max", plus "Fast", described as "Lower latency with increased usage". | sandbox `/api/models` response; src/components/ChatInput/settings/ModelPicker.tsx:85-111 | minor | Hide per-token prices unless the account is API-billed. Add a one-line hint for effort ("higher = slower, more thorough"). (S) |
| 5.3 | **Cost and quota show as bare percentages.** The top bar shows "NN%" (quota) and the session pill shows "NN%" (context). The meaning lives only in hover tooltips ("5-hour", "Resets in…", "Context: … left before compact"). The "API usage" dialog ("What this machine's agent usage would cost at raw API prices.") sits in an overflow menu. | src/components/TokenUsageWidget.tsx:113; src/components/SessionPill.tsx:112, :180-182; src/components/UsageCostDialog.tsx:389-391 | minor | Label the numbers ("Plan 42%", "Context 18%"). (S) |
| 5.4 | **Jargon on common screens.** See the next table. | | major (cumulative) | A copy pass on these strings. (S/M) |

### Internal terms visible on first-hour screens

| Term | Where a newcomer meets it | Evidence | Suggested copy |
|---|---|---|---|
| **Mission Control** | The home screen h1, palette items "Go to Mission Control" / "Open/Exit Mission Control", the loading text "Loading Mission Control…", the mobile tab, the back button | MissionHome.tsx:129; CommandPalette.tsx:185-188; SharedAppViews.tsx:110, :116; MobileWorkspace.tsx:119; DesktopWorkspace.tsx:393 | "Home" (keep "Mission Control" as a subtitle, if at all) |
| **Steer** | The composer placeholder while an agent runs: "Steer the active turn… (Enter to send)" / "Steer…"; the submit label "Steer active turn"; the queued-turn tooltip | src/components/ChatInput/index.tsx:113-114, :670; QueuedTurns.tsx:145 | "Add to the current task… (Enter)" |
| **turn** | "Steer the active turn", "Add this to the current turn", "Stop the current turn…", "turns" on session cards, "Filter by turn" | ChatInput/index.tsx:114; QueuedTurns.tsx:145; docs/usage.md:26, :54 | "reply" / "step" |
| **Crew** | The workspace panel title "Crew", home "Show crew (n)" / "Hide crew", "Crew member", "Crew map" | builtInWorkspacePlugin.tsx:184; MissionHome.tsx:533-548; crew/CrewMap.tsx:480 | "Helper sessions" (only shown once one exists, so it's lower priority) |
| **Ultracode** | A model picker toggle with tooltip "Ultracode · Standing multi-agent orchestration at any effort" | ChatInput/settings/ModelPicker.tsx:171-182 | "Multi-agent mode: let Claude split work across helper agents" |
| **Worktree** | The Worktrees panel in the right rail, the worktree toggle in mobile settings | docs/usage.md:60; MobileChatInputSettings.tsx:240 | Add a tooltip: "Run in a separate copy of the repo (git worktree)" |
| **ACP agent** | Shows as a provider in `/api/provider-updates` (the update banner/executable picker) | sandbox `/api/provider-updates` | Hide uninstalled ACP from newcomers |
| **compact / context** | "Context: … left before compact" | SessionPill.tsx:180-182 | "…before older messages are summarized" |
| **Full access / Don't Ask / Auto** | The permission menu; "Don't Ask" actually *denies* actions, the opposite of what it sounds like | presentation.ts:98-103 | "Deny when unsure" |
| **dirName / instance / lease / orchestration** | No user-facing strings found on common screens (code identifiers only). "Hub" appears only in Devices. | grep of src/ string literals | n/a |

## Stage 6: Help inside the app

| # | Finding | Evidence | Sev | Fix (size) |
|---|---|---|---|---|
| 6.1 | **There's no help surface at all.** No Help menu (the Electron menu has App/File, Edit, View and Window only), no "?" button, no docs link, no "Learn more", no tour. src/ has no outbound links to github.com/gentritbiba or cogpit.dev. | electron/main.ts:180-207; grep src/ for docs, Learn more, help, cogpit.dev, github.com/gentritbiba, tour, welcome (no hits) | major | Add an Electron Help menu (Documentation, Keyboard shortcuts, Report an issue, Check environment) and a "?" item in the More-actions menu. (S) |
| 6.2 | **The keyboard shortcuts dialog is a customization screen, and it's hard to find.** It opens via `?` (not while typing) or the palette item "Customize keyboard shortcuts". Its description is "Click a shortcut, then press a new key combination…". Nothing on screen mentions `?`; a code comment admits it is "the only way in for someone who does not already know ⌘K". keybindings.ts mentions a "dashboard cheat sheet" that no longer exists. | src/components/KeyboardShortcutsDialog.tsx:99-102; src/lib/keybindings.ts:52, :76-80; src/components/AppShell/DesktopOverlays.tsx:47; CommandPalette.tsx:379 | minor | Show "Press ? for shortcuts · ⌘K for commands" in the home footer. Add a read-only cheat-sheet mode. (S) |
| 6.3 | **No panel explanations.** The More-actions menu has "Usage & cost…", "Server monitor…", "Settings" and "Stop all agent processes", with no description of what each panel is. Empty panels (Crew, Worktrees, Browser) explain little to a first-time user. The Browser panel is an exception, since it has an empty state with a skill dialog. | src/components/FloatingChrome.tsx:252-310; src/components/BrowserPanel/BrowserEmptyState.tsx | minor | Give each right-rail panel a one-sentence empty state plus a docs link. (S) |
| 6.4 | `docs/ui-simplification.md` already proposes a Help menu row and `?` binding (Phase 0.1/0.2). Part of it has landed (the palette now has Mission Control and `?` is bound), but the Help menu has not. | docs/ui-simplification.md:162-189 | n/a | Reuse that plan. |

## Stage 7: How comparable tools onboard (general knowledge)

- **Claude desktop app (Claude Code tab):**
  - Sign-in is the first screen, and the agent runtime is bundled, so there's no "install a CLI first" step.
  - Then a folder picker and a choice of where it runs.
  - Permission prompts default to asking.
  - *Copy:* in-app auth state, a native folder picker as the first action, safe defaults.
- **Cursor:**
  - A first-run wizard: import VS Code settings and extensions, keybindings, privacy mode, sign-in.
  - Then a welcome tab with Open project, Clone repo and Connect via SSH.
  - *Copy:* a short wizard that ends on one obvious "Open folder" button.
- **Conductor (parallel Claude Code agents on Mac):**
  - First run checks that Claude Code (and GitHub) are installed and logged in, then asks you to add a repository (local folder or clone URL).
  - It creates isolated workspaces for you without exposing the word "worktree" up front.
  - *Copy:* a dependency check with fix buttons; hiding git mechanics behind plain words.
- **Warp:**
  - An onboarding flow (theme, AI features), then suggested first commands and a "Getting started" checklist in the sidebar, with progress ticks.
  - *Copy:* a dismissible checklist that teaches by doing.
- **VS Code welcome page:**
  - A "Start" column (New file, Open folder, Clone repository) and "Recent".
  - Walkthroughs: step-by-step checklists with progress and media (choose theme, open folder, learn shortcuts).
  - A "Show welcome page on startup" toggle, plus a Help menu with a Keyboard Shortcuts Reference and docs links.
  - *Copy:* the walkthrough format and the Help menu.
- **GitHub Desktop:**
  - Sign-in, then configure your git identity, then "Create a tutorial repository" to learn on a safe sample.
  - *Copy:* a sample project, so the first task is risk-free.

**Patterns worth copying into Cogpit:**
1. An environment check screen (CLI found, version, signed in, with install and sign-in buttons) instead of "enter your data directory".
2. A first-run home with one primary "Open a folder…" button and three example prompts.
3. Inline empty-state guidance that ends with a button, never "go do it elsewhere".
4. Safe permission defaults with an explained opt-in.
5. A Help menu with docs and a shortcuts reference.
6. An optional sample project ("Try Cogpit on a demo repo").

---

## Prioritized top 10

| Rank | Fix | Findings | Sev | Size |
|---|---|---|---|---|
| 1 | **Unify bootstrap so desktop auto-detects Claude Code** (`~/.claude` exists, or `claude` on PATH, with lazy `projects/`), and expand `~` in path validation. Today the most common newcomer (desktop + Claude Code) hits a manual gate that rejects the very path it suggests. | 2.1, 2.3, 2.4 | blocker | S |
| 2 | **Plain errors with a next step for missing or signed-out CLIs.** (a) Check for the CLI before Send and on provider select, using `/api/provider-updates`. Grey out uninstalled providers. Route Claude through `friendlySpawnError` so desktop users stop seeing the SDK's "Reinstall @anthropic-ai/claude-agent-sdk…" text. (b) Detect `isApiErrorMessage` / `authentication_failed` / 401, mark the session `error`, and render "Claude Code isn't signed in — [Open terminal and sign in]" (`claude /login`, `codex login`, …). Intercept `/login`. | 3.1, 3.2, 3.4-3.6, 1.5 | blocker | M |
| 3 | **Replace SetupScreen with an environment check.** One row per CLI: found/version/signed in, an install link and command, "Check again". Make the data directory an optional advanced field with a native picker. Reuse the same check as a "Check environment" item in the Help menu and in the npx launcher output. | 2.2, 3.7, 3.8, 1.1, 1.3 | major | M |
| 4 | **Document the macOS Gatekeeper "Open Anyway" step** (then pursue Developer ID signing and notarization). | 0.4 | blocker (macOS) | S → M |
| 5 | **Safe permission default for new installs, visible on home.** Use each CLI's ask/workspace mode, show the permission chip in the home composer, give Full access a warning style and a one-time explainer. | 5.1, 3.3 | major | S/M |
| 6 | **First-run home: an "Open a folder…" primary action plus a 3-step checklist** (✓ agent connected · open a folder · send your first task), with example prompts. Rewrite the empty states that say "Start Claude Code… to see work here". | 4.1, 4.4, 1.11 | major | M |
| 7 | **Desktop startup robustness.** Reject on an early worker exit and show an error dialog with the log path. Add a timeout to the shell PATH probe. Show a splash window immediately. | 1.7, 1.8 | major | S |
| 8 | **Fix the docs.** Node 22.16 in README, prerequisites in the hero, a "run the CLI once" note (until #1 lands), Linux build tools for npx, a Bun link, and a new `docs/first-session.md`. | 0.1, 0.3, 0.5, 0.6, 1.4 | major | S |
| 9 | **Add a Help menu and visible shortcut hints.** Electron Help menu, "?" in More actions, a "? shortcuts · ⌘K commands" footer on home, ⌘K visible on home. | 6.1, 6.2, 4.2 | major | S |
| 10 | **Plain-language copy pass.** Mission Control → Home, Steer → "Add to current task", Ultracode tooltip, "Don't Ask" → "Deny when unsure", per-token prices hidden for subscription users, labeled percentages. Silence the SQLite ExperimentalWarning in the launcher. | 5.2-5.4, 1.1 | major | S/M |
