> Audit evidence for [the onboarding tracker](2026-11-04-beginner-onboarding.md). Screenshot and sandbox paths under /tmp/onboard-qa/ were temporary and no longer exist.

# Cogpit first-run audit: a complete beginner's view

**Date:** 2026-11-04
**Build:** HEAD `75b4104e` (v3.5.4), web bundle built from a clean detached worktree with no `editions/team`, so it behaves like a public clone.
**Persona:** someone who has just heard of Cogpit, has barely used Claude Code, Codex or Copilot CLI in a terminal, and wants an AI agent to change something in a project folder.

## How the test was run

- Each scenario ran on its own `startStandaloneServer` on `127.0.0.1:19393` (`publishPort:false`) with a fresh `dataDir` and an empty `HOME` under `/tmp/onboard-qa/`. Each was started with `env -i`, so this session's `CLAUDE_*` and `COGPIT_*` variables were not passed in. `lsof -p` confirmed that no server opened `~/Library/Application Support/cogpit`, `~/.claude`, `~/.codex`, `~/.copilot` or `~/.cogpit`.
- **Scenario 1 (nothing installed):** `PATH` contained only system directories plus a directory holding a `bun` symlink. `claude`, `codex` and `copilot` were not found.
- **Scenario 2 (installed, never signed in):** the real `PATH`, minus `~/.cogpit/bin`, with an empty HOME. `claude` 2.1.318, `codex` 0.166.0 and `copilot` 1.0.105 were all found, and none had a login.
- **Scenario 3:** a quick check of whether Cogpit notices an agent that is installed while it is running.
- Everything ran in the private `agent-browser --session tmp-onboard-firstrun` browser at 1440×900 and at 390×844 for the phone view. The browser was closed, the servers stopped and the worktree removed afterwards.
- No account was signed in. The bundled Claude binary reported `loggedIn:false` under the empty HOME, so no real credentials leaked in through the Keychain.

**Caveats:**
- These are web-build results. The desktop app uses the same renderer. Electron starts from the login shell's `PATH` (`electron/main.ts:12-18`), so CLI detection there should match scenario 2.
- The leak-monitor badge and the "4 agents running on this machine" line reflect other processes on this Mac. A real beginner sees them only if other agent or node processes are running.
- Scenario 1 stops at step 1. To audit the rest, I created `home-s1/.claude/projects` by hand, the way a determined user might.

## Five things that shape the whole journey

1. **Cogpit already includes Claude Code.** It ships the agent SDK's Claude binary (`…/claude-agent-sdk-darwin-arm64/claude`), which Settings lists as "Bundled with Cogpit". So the "nothing installed" user really has an agent available but not signed in. Even so, the UI blocks them at setup, sends them to a `/login` command that doesn't work in Cogpit, and the built-in terminal reports `claude: command not found`.
2. **No sign-in path exists in the UI for any agent.** No screen, setting or error offers to sign in. Each CLI's not-signed-in failure appears in that CLI's own raw wording, and two of them look like success.
3. **The first session starts in "Full access – Skip permission checks"** (`src/lib/permissions.ts:23-24`). The Mission Control composer, where the first message is typed, has no access control at all.
4. **Failures are silent outside the UI.** In every scenario the server log contained only my own READY line. The Claude auth failure, the Codex 401, the Copilot auth failure and the missing-binary errors were never logged.
5. **Nothing in the app explains what Cogpit is, and nothing links to help.** No link points at docs or cogpit.dev anywhere in `src/`, and searching ⌘K for "help" returns only sessions.

---

## Journey

Severity ratings: **blocker** (the user cannot continue without outside knowledge), **major** (confusing, scary or loses work), **minor** (polish or jargon).

### Scenario 1: nothing installed, empty HOME

#### 1. First screen: "Connect your coding agent"
- **Sees:** a single card titled "Connect your coding agent". It says Cogpit "detects Codex and GitHub Copilot CLI automatically", although neither is installed. It then asks for the "Claude Code data directory", with the placeholder `/Users/you/.claude` and a greyed-out "Connect Claude Code" button.
  - `/tmp/onboard-qa/shots/s1-01-first-screen.png`
- **Must know:** what Cogpit is, that it needs an agent CLI, which one to install, and that "data directory" means `~/.claude` with a `projects/` folder inside it, which only exists after Claude Code has run once.
- **Friction: BLOCKER.**
  - Nothing says what Cogpit is.
  - There is no install link, no "I don't have any of these" option and no skip.
  - The copy claims detection that found nothing.
  - The bundled Claude binary is never mentioned.
- **Fix:** replace this gate with an "Agents" checklist that shows, for each agent, whether it is installed and signed in, with Install and Sign-in actions. Let the user continue with the bundled Claude.
  - Card copy and form: `src/components/SetupScreen.tsx:94-100`, `:117`.
  - Gate: `src/App.tsx:1053-1054`.
  - Bootstrap only looks for Codex and Copilot: `server/config.ts:221-241`.

#### 2. Following the hint: typing `~/.claude`
- **Sees:** "Path does not exist", in red.
  - `/tmp/onboard-qa/shots/s1-02-tilde-claude.png`
  - `/tmp/onboard-qa/shots/s1-03-abs-claude-missing.png`
- **Cause:** the server calls `resolve(dirPath)` without expanding `~` (`server/config.ts:342`). `~/.cogpit` failed with "Path does not exist" while the absolute path to the same folder got the `projects` error, so `~` is never expanded.
- **If the path does exist but Claude has never run:** the error reads `Directory does not contain a "projects" subdirectory. This does not appear to be a valid .claude directory.` (`server/config.ts:356-361`).
  - `/tmp/onboard-qa/shots/s1-04-not-claude-dir.png`
- **Friction: MAJOR** (`~` not expanded, plus jargon). It becomes a **blocker** for anyone who has installed Claude Code but never run it.
- **Fix:** expand `~`, accept a `.claude` folder without `projects/`, and say in plain words: "Run Claude Code once, or sign in below."

#### 3. Code reading: the desktop app shows this gate even to existing Claude users
- **Not run in Electron; this comes from reading the code.** Only the standalone server auto-creates a config when `~/.claude/projects` exists (`server/standalone-runtime.ts:96-102`). The desktop path (`server/app-server.ts:105`) only calls `loadConfig()`, and bootstrap fires only when the Codex or Copilot CLI or its history is found.
- So a desktop user who has only Claude Code, the most common case, lands on step 1 and has to type an absolute path.
- **Friction: MAJOR.**
- **Fix:** run the same `~/.claude/projects` auto-detection in `loadConfig()` for every shell.

#### 4. Installing an agent while Cogpit is open does nothing until a restart
- **Sees:** I created `~/.codex/sessions` while the server was running. `/api/config` stayed `null` and the setup screen stayed up. After a restart it bootstrapped straight to Codex mode (scenario 3).
- **Friction: MAJOR.** The user does the right thing and nothing changes.
- **Fix:** re-run `detectBootstrapConfig()` when `cachedConfig` is null on `/api/config`, or add a "Check again" button (`server/config.ts:252-261`).

#### 5. Phone first screen
- **Sees:** the same card. The layout fits.
  - `/tmp/onboard-qa/shots/s1-05-phone-first-screen.png`
- **Friction: minor**, beyond the blocker in step 1.

> To keep auditing, I created `home-s1/.claude/projects` by hand. The setup screen accepted it ("Claude Code history found") and connected.
> `/tmp/onboard-qa/shots/s1-06-valid-claude-dir.png`

#### 6. Home screen ("Mission Control")
- **Sees** (`/tmp/onboard-qa/shots/s1-07-after-connect.png`):
  - An amber banner: **"Claude Code v2.1.306 → v2.1.318. Update it with whatever installed it — Cogpit could not tell."** The user installed nothing. This is Cogpit's own bundled copy.
  - A red flame badge "1" with no label.
  - The heading "Mission Control".
  - "Nothing is waiting on you."
  - "Your sessions 0".
  - "Start a session and it shows up here, with every session it starts."
  - Six right-rail icons with no labels.
- **Must know:** what "session" and "Mission Control" mean. They also have to decide that an alarming update banner about software they never installed is safe to ignore.
- **Friction: MAJOR** (the banner is scary and nothing in it can be acted on); **minor** (jargon, unlabelled icons).
- **Fix:**
  - Classify the SDK-bundled path as "bundled". Say "Cogpit includes Claude Code; it updates with Cogpit", or hide the banner (`server/lib/providerUpdates.ts:112` returns `"unknown"`; copy at `src/components/ProviderUpdateBanner.tsx:86`).
  - Rename "Mission Control" to "Home". Add one line explaining what Cogpit does, with a "Start your first task" call to action (`src/components/home/MissionHome.tsx:129`, `:146`, `:361`).

#### 7. Red flame badge, the "Power & activity monitor"
- **Sees:** "1 process needs review". The list contains every agent and node process on the Mac, including processes Cogpit does not own. One unrelated `node cli.js` is marked "possible leak" next to a red **Stop** button.
  - `/tmp/onboard-qa/shots/s1-08-flagged-process.png`
- **Friction: MAJOR on any machine running other node or agent tools** (here, this Mac's other agent and node processes). A first-run user is alarmed and could stop another app's process.
- **Fix:** show the badge only for processes Cogpit started, or only after the user has run a session (`src/components/LeakIndicator.tsx:40`).

#### 8. "Choose a project"
- **Sees:** before typing anything, "No projects found — Try another name, paste an absolute path, or browse the folders."
  - `/tmp/onboard-qa/shots/s1-09-choose-project.png`
- **Friction: minor.** It reads as an error on first use.
- **Fix:** an empty-query state that says "Pick the folder your project lives in" and offers a prominent Browse button (`src/components/ProjectSwitcherList.tsx:150`).

#### 9. "Browse folders…"
- **Sees:** the browser opens at the home folder, with hidden folders hidden (good). The primary button **"Start session here"** is active at the home folder itself.
  - `/tmp/onboard-qa/shots/s1-10-browse-folders.png`
  - `/tmp/onboard-qa/shots/s1-11-in-my-site.png`
- In Mission Control the button only selects the folder and does not start anything (`/tmp/onboard-qa/shots/s1-12-project-picked.png`).
- Pasting a path works well. The "Start in this folder" item from scenario 2 is clear (`/tmp/onboard-qa/shots/s2-02-paste-path.png`).
- **Friction: MAJOR.** One click hands an agent with Full access the whole home directory. The label also misdescribes what happens.
- **Fix:** rename the button "Use this folder", and warn when the folder is `$HOME` or `/` (`src/components/FolderBrowser.tsx:275`; root at `server/config.ts:206-210`).

#### 10. The model chip ("Claude · Opus · High")
- **Sees:**
  - The providers Claude, **ACP**, Codex and Copilot, listed the same way whether or not they are installed or signed in.
  - Prices such as "$4/$20 per Mtok". A subscription user will read that as a charge per use.
  - A "Reasoning" slider, plus "Fast mode" and "Ultracode" icons.
  - `/tmp/onboard-qa/shots/s1-13-model-chip.png`
- **Friction: MAJOR.** Nothing tells the user which provider will actually work. "ACP" and "Mtok" are unexplained.
- **Fix:** add "Not installed · How to install" and "Not signed in · Sign in" states. Hide ACP unless it is configured. Explain that prices are API rates and don't apply on a subscription.

#### 11. Access level is invisible before the first send
- **Sees:** the Mission Control composer shows only the model chip (`/tmp/onboard-qa/shots/s1-14-typed-first-message.png`). The access level appears only after the first message, as "Full access – Skip permission checks", and it is checked by default.
  - `/tmp/onboard-qa/shots/s1-20-permission-menu.png`
- **Must know:** that the agent will run commands and edit files with no approval, and what "Plan", "Accept Edits", "Auto" and "Don't Ask" mean.
- **Friction: MAJOR** (safety and trust). This is the "scared" moment, but it only comes after the fact.
- **Fix:**
  - New installs should start on Ask (Claude), Workspace (Codex) or Ask (Copilot) (`src/lib/permissions.ts:24`).
  - Show the access chip in `HomeComposer`, next to the model chip (`src/components/home/HomeComposer.tsx:136`).
  - Explain Full access once, the first time it is chosen (`src/lib/agents/presentation.ts:102`).

#### 12. First message with Claude, not signed in
- **Sees:**
  - The reply bubble reads **"Not logged in · Please run /login"**, with the same text in red under the composer.
  - The model chip changes to **`<synthetic>`**.
  - The breadcrumb shows `my-site / 959a0da7 · 100%`.
  - `/tmp/onboard-qa/shots/s1-15-after-send.png`
- "Error details" just repeats the same line (`/tmp/onboard-qa/shots/s1-17-click-error.png`).
- **Friction: BLOCKER.**
- **Fix:**
  - Recognise `error: "authentication_failed"` / `isApiErrorMessage`, which the transcript records, and show a "Sign in to Claude" card. Its button should open the built-in terminal running the bundled binary's login.
  - Hide `<synthetic>` in the chip. `src/App.tsx:1172` passes `session.model` through as-is, while `src/components/timeline/AssistantText.tsx:83` already knows `<synthetic>` is not a model.

#### 13. Doing what the error says: typing `/login`
- **Sees:** `/login` is not among the slash suggestions (`/tmp/onboard-qa/shots/s1-18-slash-login-suggest.png`). Sending it anyway returns **"/login isn't available in this environment."** (`/tmp/onboard-qa/shots/s1-19-slash-login-sent.png`).
- **Friction: BLOCKER.** The error's instruction is a dead end.
- **Fix:** intercept `/login` in the composer and run the same sign-in action as step 12.

#### 14. Trying the built-in terminal
- **Sees:**
  - Terminal empty state: "Start a terminal here or run a project script from the left", but nothing is shown on the left (`/tmp/onboard-qa/shots/s1-26-terminal-panel.png`; `src/components/ProcessPanel.tsx:372`).
  - Running `claude /login` gives **`zsh: command not found: claude`** (`/tmp/onboard-qa/shots/s1-27-terminal-claude-login.png`).
- **Friction: BLOCKER** in scenario 1. The bundled Claude cannot be reached from Cogpit's own terminal.
- **Fix:** install a `claude` shim that points at the bundled binary in `~/.cogpit/bin`, which Cogpit already puts first on agent `PATH`s, and add that directory to the integrated terminal's `PATH`. Or simply provide the sign-in button from step 12.

#### 15. The failed session stays "Thinking…" forever
- **Sees:**
  - The sidebar keeps the session in "Working" with "Thinking…" and a "Kill process 48687" button.
  - The timeline shows "Thinking… 59s".
  - `/tmp/onboard-qa/shots/s1-16-after-wait.png`, `/tmp/onboard-qa/shots/s1-19-slash-login-sent.png`
- Meanwhile `/api/session-status` reports `outcome:"completed", running:false, status:"thinking"`.
- **Root cause:** the synthetic error record has `stop_reason:"stop_sequence"`, so the status walk falls through to `return result("thinking")` (`shared/session/claude.ts:426`). Any Claude API error (auth, rate limit, overload) will strand a session this way.
- **Friction: MAJOR.** The user waits for work that is never going to happen.
- **Fix:** treat `isApiErrorMessage`, `model === "<synthetic>"` or `stop_sequence` as the end of the turn, and set an error status.

#### 16. Settings and "Config"
- **Sees:**
  - The rail icon labelled **"Config"** opens agent files (Agents / Skills / Commands, all "None configured"), not app settings (`/tmp/onboard-qa/shots/s1-21-config-panel.png`).
  - The real Settings sit under ⋯ → "Settings" in a dialog titled "Configuration" (`/tmp/onboard-qa/shots/s1-22-more-actions.png`, `/tmp/onboard-qa/shots/s1-23-settings.png`).
  - The Settings dialog has no agent install or sign-in status.
  - "Claude Code executable" shows "Bundled with Cogpit v2.1.306", proving Cogpit has Claude, but offers no way to sign in to it (`/tmp/onboard-qa/shots/s1-24-claude-executable.png`; `src/components/ConfigDialog/ExecutableSection.tsx:132`).
- **Friction: MAJOR.**
- **Fix:**
  - Add an "Agents" section to Settings that shows each agent's status, with Sign in, Sign out and Install actions.
  - Rename the rail item "Config" to "Agent files" or "Instructions & skills" (`src/components/AppShell/DesktopWorkspace.tsx:406`).

#### 17. Help
- **Sees:** nothing. There is no Help item in ⋯ and no docs link anywhere in `src/`, and searching ⌘K for "help" lists sessions and projects (`/tmp/onboard-qa/shots/s2-12-palette-help.png`).
- **Friction: MAJOR.**
- **Fix:** add a "Help & docs" entry to the ⋯ menu and ⌘K, linking to `docs/usage.md` / cogpit.dev, and a "Getting started" checklist on Home.

#### 18. Browser panel
- **Sees:**
  - "Nothing to show yet. This panel streams a real browser the agent drives. That takes the `agent-browser` command, which is not on this machine yet."
  - A copy-only command, `npm i -g agent-browser && agent-browser install`.
  - An "Install the agent skill…" button.
  - `/tmp/onboard-qa/shots/s1-25-browser-panel.png`
- **Friction: minor/major.** It assumes Node/npm, which the desktop app otherwise doesn't need. "Agent skill" is jargon.
- **Fix:** an Install button that runs the setup through Cogpit's own runtime, and plain copy such as "Let the agent use a browser you can watch" (`src/components/BrowserPanel/BrowserEmptyState.tsx:23`, `:68`).

#### 19. Other panels
- **Project files:** clear. It lists `index.html` and `README.md`, then "Select a file" (`/tmp/onboard-qa/shots/s1-28-project-files.png`).
- **Worktrees:** "No worktrees — Create a new session with 'Isolate in worktree' enabled". No control by that name exists; the composer chip is just "Worktree", and the folder isn't a git repository anyway (`/tmp/onboard-qa/shots/s1-29-worktrees.png`; `src/components/WorktreePanel.tsx:258`). **Minor.**
- **Scheduled tasks:** understandable (`/tmp/onboard-qa/shots/s1-30-scheduled.png`).
- **Session details:** Activity / Agents / Cost / Issues (`/tmp/onboard-qa/shots/s1-31-session-details.png`).
- **Plugins:** "No installed plugins". The README's GitHub, Vercel, ClickUp and Cloudflare panels need an opt-in under Browse, and the copy talks about the "host" (`/tmp/onboard-qa/shots/s1-32-plugins.png`, `/tmp/onboard-qa/shots/s2-13-plugins-browse.png`). **Minor.**
- **Session chrome jargon (minor):**
  - The raw session id `959a0da7`.
  - A "100%" badge with no explanation.
  - "HEAD" shown as the branch of a folder that isn't a git repository.
  - "Restore", "Set goal" and "Copy resume command".
  - "Steer the active turn…" (`src/components/ChatInput/index.tsx:114`).
  - "Kill process 48687" (`src/components/LiveSessions/SessionCard.tsx:392`).
  - "List spawned sessions on their own".

#### 20. Trying Codex instead (not installed)
- **Sees:**
  - The **typed message disappears**.
  - The view switches to an empty "What should we build in my-site?" page.
  - A faint toast, **"Codex is not installed or not found in PATH."**, sits partly behind the terminal bar and fades.
  - Under the composer, Claude's old **"Not logged in · Please run /login"** still shows, although this is a different agent and session.
  - `/tmp/onboard-qa/shots/s1-33-codex-selected.png`, `/tmp/onboard-qa/shots/s1-34-codex-missing-send.png`
- **Friction: MAJOR.** The user loses their work, the toast is easy to miss, and it has no install link.
- **Fix:**
  - `HomeComposer` clears the text before it knows whether the start succeeded (`src/components/home/HomeComposer.tsx:72-74`). Keep the text until success and restore it on failure.
  - `friendlySpawnError` has an install command only for Claude (`server/agents/spawnError.ts:4-6`, `:21`). Its comment also says "Cogpit never vendors an agent", which is no longer true. Add install links for Codex and Copilot and show them inline, not in a toast.
  - Clear `turnError` when the session changes: the reset effect clears the prompt suggestion and rate limit but not `turnError` (`src/hooks/useLiveSession.ts:119-124`; set at `:349`).

#### 21. Trying Copilot (not installed)
- **Sees:** the same loss of the message, plus the toast "Failed to start Copilot CLI: copilot was not found on PATH" (`/tmp/onboard-qa/shots/s1-35-copilot-missing-toast.png`; `server/agents/copilotTransport.ts:900`). The stale Claude error is still shown.
- **Friction: MAJOR.**

#### 22. Phone (390×844)
- **Sees:**
  - With sessions: the update banner takes about 120 px, the bottom tabs are icons only, and there is no Mission Control (`/tmp/onboard-qa/shots/s1-36-phone-home.png`).
  - Starting a session is an unlabelled folder-search icon at the top right (`src/components/LiveSessions/ProjectScopePicker.tsx:243`), which opens the same folder browser (`/tmp/onboard-qa/shots/s1-37-phone-start-folder.png`).
  - The new-session page is clear: "What should we build in my-site?" (`/tmp/onboard-qa/shots/s1-38-phone-new-session.png`).
  - Access, "Ultracode", "Worktree", "Isolation" and "Workflow" are behind a sliders icon (`/tmp/onboard-qa/shots/s1-39-phone-session-controls.png`).
  - Fresh install (scenario 2): "No sessions yet — Start Claude Code, Codex, or Copilot to see recent work here." There is no button, and "Load older sessions" appears with zero sessions (`/tmp/onboard-qa/shots/s2-14-phone-first-screen.png`; `src/components/LiveSessions/LiveSessionsChrome.tsx:236-240`, `src/components/LiveSessions/SessionCardList.tsx:207`).
- **Friction: MAJOR** for starting the first session on a phone. The empty state tells the user to "start Claude Code" somewhere else.
- **Fix:** put a "Start a session" button in the empty state, hide "Load older sessions" when the list is empty, and shorten the update banner on narrow screens.

### Scenario 2: CLIs installed, never signed in

#### 23. First screen
- **Sees:**
  - No setup screen. It goes straight to Mission Control.
  - "4 agents running on this machine" alongside "Your sessions 0". That count includes other apps' agent processes (`src/components/home/MissionHome.tsx:112`, `:130`).
  - `/tmp/onboard-qa/shots/s2-01-first-screen.png`
- After the project is chosen, the provider defaults to **Codex · GPT-6.1 Sol** even though Claude Code is installed, because bootstrap only considers Codex and Copilot (`server/config.ts:221-241`, `/api/config` returns `mode:"codex"`). See `/tmp/onboard-qa/shots/s2-03-project-picked.png`.
- Nothing indicates which agents are signed in.
- **Friction: MAJOR** (an unexplained default and a misleading count).
- **Fix:** default to Claude when it is installed or bundled, show "Signed in as …" or "Not signed in" per agent on Home, and count only Cogpit's own sessions.

#### 24. First message with Codex, not signed in
- **Sees:**
  - For about 10 s, a red **"Reconnecting… 2/5"** (`/tmp/onboard-qa/shots/s2-04-codex-send-2s.png`, `/tmp/onboard-qa/shots/s2-05-codex-send-12s.png`).
  - Then the reply **"unexpected status 401 Unauthorized: Missing bearer or basic authentication in header, url: https://api.openai.com/v1/responses, cf-ray: …, request id: …"**.
  - Then a **green check, "Waiting for your input"** (`/tmp/onboard-qa/shots/s2-06-codex-final.png`; `src/components/timeline/AgentStatusIndicator.tsx:205`).
  - The sidebar card shows no error.
- Effort changed from High to **Light** without the user doing anything, and later carried over to the Claude chip (`/tmp/onboard-qa/shots/s2-07-provider-switch.png`).
- **Friction: BLOCKER.** The error is raw HTTP, and the green check suggests things are fine.
- **Fix:** turn a 401 into "Codex isn't signed in" with a Sign in button that runs `codex login` in the terminal. Show a red status for errored turns. Look into why the effort reset.

#### 25. First message with Claude (installed, not signed in)
- **Sees:** the same as steps 12–15: "Not logged in · Please run /login", `<synthetic>`, and "Thinking…" stuck in the sidebar (`/tmp/onboard-qa/shots/s2-08-claude-not-logged-in.png`). There is no update banner because the installed version is current.
- **Friction: BLOCKER.**

#### 26. First message with Copilot, not signed in
- **Sees:**
  - **The user's message is missing from the transcript.** The Turns list shows "(no message)" (`src/components/stats/TurnNavigator.tsx:53`).
  - A red "Error query — Failed" card.
  - **"Stopped — Execution failed: model resolution leaf failed: get model list: GenericFailure, Session was not created with authentication info or custom provider"**, next to a green check icon.
  - Claude's stale "Not logged in · Please run /login" under the composer.
  - `/tmp/onboard-qa/shots/s2-09-copilot-3s.png`, `/tmp/onboard-qa/shots/s2-10-copilot-15s.png`
- **Friction: BLOCKER.**
- **Fix:** match the "authentication info" error and show a Copilot sign-in card. Render the first prompt even when the session fails. Apply the `turnError` reset from step 20.

#### 27. What the server logged
- `server-s1.log`, `server-s2.log`, `server-s2b.log` and `server-s3.log` contain **only my own READY line**. No spawn failure (ENOENT), auth failure, 401 or Copilot error was ever logged.
- The browser console showed 84 "503 Service Unavailable" errors. None of the GET API paths the page used returned 503 when re-requested, so they were probably transient, but nothing reports them.
- **Friction: minor for the beginner, major for support.** When the UI is confusing there's no trail to follow.
- **Fix:** log agent start and turn failures on the server with the session id, agent and a classified reason (not_installed / not_signed_in / http_401 / …).

---

## Top 10 recommendations
Ordered by impact on a beginner, with cheap fixes first where the impact is similar.

1. **A "Sign in to <agent>" card for authentication failures** (steps 12, 13, 24–26). Recognise Claude's `authentication_failed` / `isApiErrorMessage`, Codex's HTTP 401 and Copilot's "authentication info" error. Show one plain sentence and a button that opens the built-in terminal running the CLI's login: the bundled `claude auth login`, `codex login`, or `copilot` then `/login`. Also intercept `/login` in the composer. *Medium cost; removes three blockers.*
2. **Stop the stuck "Thinking…" after error turns.** In `shared/session/claude.ts` (around `:399-426`), treat `isApiErrorMessage`, `<synthetic>` or `stop_sequence` as the end of the turn and set an error status. Make the timeline's status line red for errors instead of the green "Waiting for your input". *Cheap.*
3. **Don't lose the first message, and don't leak errors between sessions.** Keep `HomeComposer`'s text until `onStart` succeeds (`HomeComposer.tsx:72-74`), and reset `turnError` on session change (`useLiveSession.ts:119-124`). *Cheap.*
4. **Remove the Claude-directory gate.** Cogpit bundles Claude, so always bootstrap. Auto-detect `~/.claude/projects` in `loadConfig()` for desktop too. Expand `~` in `validateClaudeDir`. Re-detect agents without a restart. *Cheap to medium; removes the scenario-1 blocker and the step-3 desktop friction.*
5. **Safer, visible access by default.** New installs should start on Ask (Claude), Workspace (Codex) or Ask (Copilot) (`src/lib/permissions.ts:24`). Show the access chip in the Mission Control composer. Warn before a session starts in `$HOME`, and rename "Start session here" to "Use this folder". *Cheap code, but a product decision.*
6. **Agent status in the picker and in Settings.** Mark each provider "Not installed · How to install" or "Not signed in · Sign in", hide ACP unless it is configured, and default to Claude when it is installed or bundled. Add an "Agents" section to Settings. *Medium.*
7. **Fix the bundled-Claude update banner.** Classify the SDK-bundled path as "bundled" in `server/lib/providerUpdates.ts`. Never show "Cogpit could not tell" to someone who installed nothing. Shorten the banner on phones. *Cheap.*
8. **Make the bundled Claude usable from the terminal.** Add a `~/.cogpit/bin/claude` shim and put that directory on the integrated terminal's `PATH`. *Cheap.*
9. **Orientation and help.** Add one sentence on what Cogpit does plus a "Start your first task" checklist on Home, a "Help & docs" item in ⋯ and ⌘K, and plain labels: Mission Control → Home, Config → Agent files, Steer → "Add to the current task", Kill process → Stop. *Cheap.*
10. **Phone and empty states.** Add a "Start a session" button to the phone's "No sessions yet" state. Hide "Load older sessions" when there are none. Scope the leak badge and the "agents running" count to processes Cogpit started. Fix the "Isolate in worktree" and "from the left" copy. Log agent failures on the server. *Cheap.*
