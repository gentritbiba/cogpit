# Making Cogpit's desktop UI dramatically cleaner

Scope: desktop only. Nothing here touches `MobileAppShell`, `Mobile*.tsx` or `ios/`.
Every file path below was verified to exist on `master` at v1.4.0.

---

## The diagnosis

1. **Four horizontal bars stack before the first word of the conversation.** `DesktopHeader`
   (h-8) → `SessionInfoBar` (h-8) → `SessionStatusBar` (py-1.5) → the sticky prompt banner,
   mounted in that order in `src/components/AppShell/DesktopWorkspace.tsx:56-72`. That is
   ~116px of chrome; with a team session and an update banner it is six bands and ~200px.
   `SessionStatusBar.tsx` is 60 lines with **zero interactive elements**, and two of its four
   render branches (`effort`, `worktreePath`) are dead — its only call site
   (`DesktopWorkspace.tsx:69-72`) passes neither.

2. **~140 discrete controls, badges and labels render at rest**, before the user does
   anything. `DesktopHeader.tsx` alone renders 19 elements / 17 interactive, and **9 of the
   14 right-cluster items are already in ⌘K**. Meanwhile `CommandPalette.tsx` contains zero
   matches for "mission" and zero for "kill" — so the palette is *not* a complete index, which
   is precisely why no button can be deleted yet. The native Electron menu
   (`electron/main.ts:189-216`) contains **zero Cogpit actions** — only `appMenu`, `editMenu`,
   reload/zoom/window roles. The free discovery surface is empty and the expensive one is full.

3. **Colour means nothing.** 1,000+ hardcoded Tailwind palette utilities across 123 of 128
   component files, 18 hues, ~314 colour+opacity combinations — outvoting the real token system
   in `src/index.css` roughly 3:1. `TOOL_TEXT_STYLES` (`src/components/timeline/ToolCallCard.tsx:36-70`)
   maps ~30 tools onto **13 hues at 4 opacities**. Green simultaneously means live, network-ok,
   copied, context-healthy, quota-healthy, the Write tool, and lines added. Red is permanently
   assigned to `Bash` — the same red as a failed call. Two unlabelled green percentages sit 32px
   apart in the top 64px meaning entirely different things (5-hour quota vs context remaining).

4. **The transcript is set like a dashboard.** One tool call costs two rows, ~48px, four icons,
   **three disclosure triangles** and a wall-clock timestamp to say four content words. A green
   `CheckCircle` is drawn on the 98% case (`ToolCallCard.tsx` `StatusIcon`). The same timestamp
   is printed up to seven times per turn from five code paths — `TurnSection.tsx:244` and
   `UserMessage.tsx:376` emit the *identical string* 40px apart. Three boundary cues stack per
   turn (separator + numbered circle + blue bubble). 499 arbitrary `text-[Npx]` declarations
   across 12 sizes from 7px to 13.5px, 58% under 12px — propped up by a global
   `.dark body { font-weight: 430 }` hack at `src/index.css:230`.

5. **Six parallel UIs answer "which session", and none of the user's tidying survives a relaunch.**
   `LiveSessions`, `session-browser/BrowseTab`, `Dashboard/ProjectsView`, `Dashboard/SessionsView`,
   `MissionControl`, and the palette's recent-sessions group — two of which hit the identical
   `/api/projects` → `/api/sessions/:dirName?page&limit=20` pair. And every panel flag in
   `src/hooks/usePanelState.ts:36-46` is plain `useState` with `showFileChanges` defaulting to
   `true`, so **the app re-clutters itself on every launch** while `ScriptsDock.tsx` already
   demonstrates the `useLocalStorage` pattern in the same repo.

---

## The principle

> **A pixel earns its place only if it changes what you would do next.**
>
> Testable form, apply to any control before adding or keeping it:
> 1. **Is its resting value actionable?** If the normal value is "0", "off", "fine" or "✓", it
>    renders **nothing** at rest and appears on the exception. (`🔥 0`, `Network off`,
>    `This machine ▾`, the green success check.)
> 2. **Is it in ⌘K, the native menu, or a context menu?** If yes, it does not also get permanent
>    chrome — *unless* it carries information the palette cannot (Mission Control's amber
>    needs-you count qualifies; a Search icon meaning "press ⌘K" does not).
> 3. **Is the fact already on screen?** If yes, delete this instance. Never render the same fact
>    twice in one viewport.
> 4. **Does colour here encode state or identity?** Colour is only for state. Red = failed.
>    Amber = needs you. Everything else is neutral.
>
> Corollary grammar, stolen verbatim from the Command Line concept:
> **`/` acts on the agent. `⌘K` acts on Cogpit.** That one sentence resolves every future
> "where does this setting live" argument.

**The guardrail:** never solve clutter by moving a frequent control behind a hover strip, a
held modifier, or a typed mnemonic. Suppression is only legal where the value's *resting* state
is non-actionable. A number you sample every ninety seconds (context %) stays visible; a number
you act on twice a day (quota, leaks) goes dark and comes back on threshold.

---

## Before / after — the resting session view

```
BEFORE — v1.4.0, healthy live session, nothing wrong          ~140 objects at rest
┌──────────────────────────────────────────────────────────────────────────────────────┐
│ ◉ v1.4.0 11111111 ⧉        ●42% 🔥0 💻This machine⌄ ⌾Network off ∿ 🔍 ▦ ⚙ ☠ ⑂ ▤ ◧ ▥ │ bar 1 · 19 items
├──────────────┬────────────────────────────────────────────┬──────────────────────────┤
│Live│Browse│Tm│ 95%·919.0k      acme-dashboard  ＋⧉</>🔎▭🗀 │▤ File Changes  2 files   │ bar 2 · 11 items
│🔍 Search…  ↻ ├────────────────────────────────────────────┤ +3 −2  👥 🕐 Σ  ✕        │
│▾dev/acme   2 │ opus    ✳ thinking                  main   │ Showing: ‹ Last (T2) ›   │ bar 3 · 0 interactive
│  Fix flaky…  ├────────────────────────────────────────────┤──────────────────────────│
│  Add dark…   │ ⌃ Good. Do that, and make sure nothing…    │ ts E cart.ts       +2 −1 │ bar 4 · sticky banner
│▾dev/paym…  2 │                                            │  1 − pending: boolean    │
│  Trace the…  │ Found it. The spec asserts on the cart     │  1 + pending: Map<M…>    │ ← FIRST PROSE, y≈172
│▾dev/notes  1 │ badge right after clicking Add to cart…    │                          │
│              │  ▾ 4 tool calls                            │                          │
│              │  │ Edit src/stores/cart.ts 05:14:37 PM ✓  │  ← 3 triangles per call, │
│              │  │ › Diff  › Input  › Result              │     1 green check,       │
│              │  │ Bash bun test e2e/…     05:14:45 PM ✓  │     1 wall clock,        │
│              │  │ › Input  › Result                      │     13 tool hues         │
│▾SCRIPTS  ＋🔍 │  ┃ 📄 2 files changed +3 −2 ▮▮▮▯▯      ⌄ │  ← same 2 files, 3rd     │
│ ROOT/ build  │  ┃  ■ ✎ cart.ts        +2 −1 ▮▮▮          │     rendering            │
│ dev lint test│                            ＋ Set goal      │                          │
│ typecheck    ├────────────────────────────────────────────┤                          │
│ Show all(1)… │ Send a message… (Enter to send)         ➤ │                          │
│ API/         │ Opus⌄/High⌄/⛊Full access⌄/⚡Ultracode/MCPs 5/5⌄/Changes apply live     │
└──────────────┴────────────────────────────────────────────┴──────────────────────────┘
  4 stacked bars · ~116px to the first word · 5 hues in the top 64px
  2 unlabelled green % 32px apart · 7 timestamps in one turn


AFTER — same session, same moment                    ~15 objects at rest outside the list
┌──────────────────────────────────────────────────────────────────────────────────────┐
│ ◇  acme-dashboard / fix-flaky-checkout  ●   opus · main · ctx 95%     ⊞²  ⌘K   ⋯  ◨ │ ← ONE bar, 9 items
├──────────────┬───────────────────────────────────────────────────────────────────────┤
│Live│Browse│Tm│                                                                       │
│🔍 Search…    │  Found it. The spec asserts on the cart badge right after clicking     │ ← FIRST PROSE, y≈40
│▾dev/acme   2 │  Add to cart, but the badge is written by an optimistic update that    │
│  Fix flaky…  │  a GET /api/cart reconciles 40–90ms later. On CI it does not.          │
│  Add dark…   │                                                                       │
│▾dev/paym…  2 │  │ Searched 1 pattern, read 1 file, ran 1 command                      │
│  Trace the…  │  │ Grep   waitFor|sleep\(                            3 files          │
│▾dev/notes  1 │  │ Read   e2e/checkout.spec.ts                     240 lines          │
│              │  │ Bash   bun test e2e/checkout…        ✗ exit 1 · 3 failed           │
│              │                                                                       │
│              │  ▏2 · opus · 23s · 5:14pm                                        ↺    │
│              │  ▏Good. Do that, and make sure nothing else depended on the old timing.│
│              │                                                                       │
│              │  I'll key pending mutations in the store instead.                      │
│              │                                                                       │
│              │  │ Made 2 edits +5 −2, ran 1 agent                                     │
│              │  │ Edit   src/stores/cart.ts                            +2 −1          │
│              │  │ Edit   e2e/checkout.spec.ts                          +1 −1          │
│              │  │ Task   Audit other specs…                     4 tools · 18s         │
│              │  │ 2 files changed  +3 −2  →                                           │
│▸ SCRIPTS     │                                                                       │
│              │  ┌─────────────────────────────────────────────────────────────────┐  │
│              │  │ Send a message… (Enter to send)                              ➤  │  │
│              │  └─────────────────────────────────────────────────────────────────┘  │
│              │  Opus ⌄   ⛊ Full access ⌄                                        ⋯   │
└──────────────┴───────────────────────────────────────────────────────────────────────┘
  1 bar · ~40px to the first word · 1 percentage, labelled · 2 hues at rest
  ▏ = the human voice (accent rule)   │ = one neutral nesting rail (all kinds)
  ⊞² = exception chip: appears only when a turn lands changes / a session needs you
  red is the only saturated colour on screen, and it is on the row that failed
```

**Counts.** Header 19 → 9. Bars 4 → 1. Composer settings row 14 objects → 3.
Per tool call: 2 rows → 1, 3 triangles → 0, 1 green check → 0, 1 timestamp → 0, and a
result digest that is *more* information than what it replaced. Total resting objects
outside the sidebar list: ~140 → ~15. Hues at rest: 5 → 2.

---

## Where to start: Phase 0 (this week)

Eight changes. Every one is a deletion or a guard clause. **None touches
`useSessionState.ts`, `useUrlSync.ts`, the navigation model, or mobile.** Each is an
independent PR against a 14-second test suite. Ordered best-first.

### 0.1 — Populate the native Electron menu from the keybinding registry
**This is the single best first move.** It is the only change that makes every later
deletion honest instead of a disappearance, and it costs zero pixels.
`electron/main.ts:189-216` currently ships `appMenu` / `editMenu` / reload / zoom / window
and **not one Cogpit action**. Generate File (New Session, New Terminal), View (Sidebar,
Stats, File Changes, Mission Control, Project Files, Preview, Expand/Collapse), Tools
(Command Palette, Config Browser, Theme, Keyboard Shortcuts, Kill All), with accelerators
from `getKeybinding()`.
**Files:** `electron/main.ts`, `electron/preload.ts`, `src/lib/keybindings.ts`.
**Effort:** M — budget the IPC bridge honestly. `electron/preload.ts` exposes only
`electronUpdater` and `electronPerformance` today; main-process menu items cannot reach
renderer commands without a new channel + a renderer-side dispatcher (~150 lines, three files).
It is *not* an array edit.
**Lost:** nothing.

### 0.2 — Complete the command palette, and fix the ⌘K catch-22
`grep -ic mission src/components/CommandPalette.tsx` → **0**. Same for kill-all. Also missing:
Duplicate session, Switch device, Restore to turn, Workflows, Set goal, Run script, Copy
resume command, Find in conversation. And `⌘F` is a raw window listener at
`src/components/ChatArea.tsx:52` — in no registry, no palette, no dialog, no button, therefore
invisible to `findKeybindingConflict`. Register it. Separately: `KeyboardShortcutsDialog` is
reachable **only from inside the palette** (`DesktopOverlays.tsx`), so you must already know
⌘K to learn ⌘K — bind `?` (no input focused) and add a Help menu row.
**Files:** `src/components/CommandPalette.tsx`, `src/components/AppShell/DesktopOverlays.tsx`,
`src/lib/keybindings.ts`, `src/components/ChatArea.tsx`.
**Effort:** M. Purely additive.
**Lost:** nothing.

### 0.3 — Fix the ⌘⇧1-9 double binding (a real bug, not a redesign)
`src/hooks/useKeyboardShortcuts.ts:166` registers `mod && shift && e.code.startsWith("Digit")`
→ jump to Nth live session. `src/components/DeviceRoot.tsx:99` registers
`matchDeviceSwitchIndex` on the same chord. Both bubble-phase on `window`, neither calls
`stopPropagation`. With ≥2 devices, one press switches device **and** clicks the Nth session.
**Keep session-jump on ⌘⇧digit and move device switching off it** — the chord maps 1:1 onto a
multi-session workflow and Mission Control is a mode you must enter and leave. While in there,
move ⌘⇧↑/↓, Ctrl+Tab, Space and Escape into `KEYBINDING_DEFINITIONS` so conflict detection can
see them.
**Files:** `src/hooks/useKeyboardShortcuts.ts`, `src/components/DeviceRoot.tsx`,
`src/lib/keybindings.ts`.
**Effort:** S. **Lost:** nothing — it is a correctness fix.

### 0.4 — Persist the panel flags (do **not** change their defaults yet)
`src/hooks/usePanelState.ts:36-46` holds all seven flags in plain `useState`. Every tidy-up the
user performs is discarded on relaunch. Route them through `useLocalStorage` — the pattern
already exists in `src/components/ScriptsDock.tsx`. Highest perceived-cleanliness per line in
the repo, and there is no dedicated test file to break.
Ship the persistence and the default change (`showFileChanges: false`) as **two separate PRs**,
a release apart. Changing the default in the same commit means a user's first launch after
updating is strictly worse.
**Files:** `src/hooks/usePanelState.ts`. **Effort:** S. **Lost:** nothing.

### 0.5 — The zero-argument deletions (one PR)
- Duplicate copy-resume button: `src/components/DesktopHeader.tsx:123` and `:146` call the
  identical `handleCopyResumeCmd` ~8px apart, sharing `cmdCopied` state. Delete the icon button,
  keep the clickable slug, add "Copy resume command" to ⌘K.
- `TokenUsageBadge` + the `tokenUsage` prop: `TurnSection.tsx:378` is the only call site and
  passes `null`. ~35 lines of Tooltip that has **never rendered on desktop**.
- Duplicate timestamp: `UserMessage.tsx:376` prints the same string as `TurnSection.tsx:244`.
- Dead `animate-ping` spans: `src/index.css:481-483` sets `animation: none !important`. Seven
  components still render an absolutely-positioned green disc that only ever sits static:
  `header-shared.tsx`, `ChatInput/InputToolbar.tsx`, `WorkflowsPanel.tsx`, `TeamsDashboard.tsx`,
  `session-browser/SessionsList.tsx`, `Dashboard/DashboardWidgets.tsx`,
  `workflows/WorkflowAgentCard.tsx`.
- The lying cheatsheet: `src/components/Dashboard/ProjectsView.tsx:226` advertises
  "Toggle voice input · Ctrl+Shift+M". `grep -rn voice src/` returns that one line — the feature
  does not exist, and the shortcut now opens Mission Control. None of its 13 rows call
  `getKeybinding()`, so user rebinds are ignored. Regenerate from `KEYBINDING_DEFINITIONS`
  through `shortcutLabel()`, or delete.
- The six literal `<span>/</span>` separators and the "Changes apply live" caption in
  `src/components/ChatInput/settings/DesktopChatInputSettings.tsx`.
- The idle `Set goal` chip in `src/components/goal/index.tsx` (keep the active-goal card).

**Effort:** S. **Lost:** discoverability of the clickable slug (mitigated by its tooltip and the
new palette entry) and of the goal feature (mitigated by `/goal`, which already works, plus the
slash-suggestion popup).

### 0.6 — Go dark on nominal telemetry (four guard clauses)
- `LeakIndicator` returns `null` when `leaks.length === 0`. Safe: the guard sits after
  `useLeakMonitor()`, so the 60s poll keeps running and the flame appears the instant a leak
  exists — a hazard light that only lights when there is fire.
- `DeviceSwitcher` returns `null` when `devices.length === 0`. Move "Add device…" to Settings.
- `NetworkStatus` drops the `Network off` branch — a config choice is not an event.
- Desktop `ContextBadge` **stays visible** (see "Explicitly NOT doing"), but drops its
  border+bg pill and becomes plain `ctx 95%` tabular-nums text in a single neutral meta run.
- `TokenUsageIndicator` renders nothing below 70% utilisation.

**Files:** `src/components/LeakIndicator.tsx`, `src/components/DeviceSwitcher.tsx`,
`src/components/DesktopHeader.tsx`, `src/components/header-shared.tsx`,
`src/components/TokenUsageWidget.tsx`.
**Effort:** S. **Lost:** ambient reassurance that the leak monitor is alive and what your
5-hour quota is. Given this project's battery-drain history that is real — keep the flame
pinned for 60s after a Kill All, keep the count in the Power dialog, and see the quota
question in "Open questions".

### 0.7 — Transcript ink pass 1
- `StatusIcon` returns `null` on success; keep `XCircle` and `Loader2`
  (`src/components/timeline/ToolCallCard.tsx`).
- Delete the per-call `toLocaleTimeString()` into the row's `title` attribute.
- Collapse `TOOL_TEXT_STYLES` from 13 hues to 3 tiers: mutating (Write/Edit/Bash/exec) =
  `text-foreground`, read-only = `text-muted-foreground`, failed = `destructive`. It is a data
  map, so revert is one paste — the ideal A/B candidate.
- Collapse the four `border-l-2` rail colours (`border-border/40`, `green-500/30`,
  `indigo-500/30`, `violet-500/30`) to one neutral 1px rail; keep indigo for sub-agents only.
- One neutral hover for `HeaderIconButton`; strip the five per-button accent colours in
  `SessionInfoBar.tsx`.

**Files:** `ToolCallCard.tsx`, `TurnSection.tsx`, `TurnChangedFiles.tsx`, `header-shared.tsx`,
`SessionInfoBar.tsx`. **Effort:** M.
**Test impact, known:** `ToolCallCard.test.tsx` asserts on the literal strings "Input"/"Result";
`AssistantText.test.tsx` needs a pass. Budget the updates in the same PR — repo policy.
**Lost:** pre-attentive tool recognition by hue (the four-letter word is still right there),
and explicit per-call completion confirmation.

### 0.8 — Ship `summarizeResult()` additively
A right-aligned dim digest on the collapsed tool row: `240 lines`, `3 files`, `+2 −1`,
`✗ exit 1 · 3 failed`, `4 tools · 18s`. It goes beside the existing `getToolPresentation` /
`getToolSummary` in `shared/session/toolSummary.ts` (already unit-tested).
**Ship it for one release with the Diff/Input/Result chevrons still present**, so it can be
judged on its own. A wrong digest is worse than a chevron, because a digest is trusted and an
unopened panel is not: memoise by `toolCall.id`, cap parsing to the first and last 2KB, and
return `null` rather than guess.
**Effort:** M. **Lost:** nothing — it is the only change in this whole document that removes a
control while *adding* information.

---

## Phase 1 (the real work)

1. **Split `SessionInfoBar.tsx` into `SessionInfoBar.mobile.tsx` as a pure no-op refactor first.**
   The mobile branch is a self-contained `if (isMobile) { … return }` early return; the lift is
   mechanical. Doing this before any deletion is the only way not to silently break the mobile
   and iOS clients, which desktop QA will not catch.
2. **Delete `SessionStatusBar.tsx`** (60 lines, zero interactive elements, two dead branches).
   One thing must *move*, not die: its `useSessionInventoryOptional()` +
   `mergePullRequests(extractPullRequests(...), scanned)` memo, which backfills PRs for sessions
   where only the tail is loaded. Re-home it in the merged bar.
3. **Delete the desktop branch of `SessionInfoBar`** and merge everything into one 36-40px
   header row: `◇ · project / session · ● · opus · main · ctx 95% · [exception chips] · ⌘K · ⋯ · ◨`.
   The six `SessionActions` icons become a right-click menu on the breadcrumb — the mobile
   overflow menu in the same file is already the designed answer.
4. **Split `expandAll` into two levels.** Today `ToolCallCard.tsx:170-172` derives
   `showInput && showResult && showDiff` from one flag — ⌘E goes from one summary line to every
   raw JSON payload in the session. Level 1 (⌘E) opens collapsed *groups* so every call is a
   one-line row with its digest; level 2 (⌘⇧E) opens payloads. **This is the precondition** for
   step 5: people only leave per-row toggles clicked because the bulk control is nuclear.
5. **Delete the Diff/Input/Result toggle row.** The whole row becomes the disclosure target and
   opens exactly one panel chosen by tool (Edit→diff, Bash→command+output, Read/Grep→result,
   else→result). Raw input becomes a dim `input` link *inside* that panel.
6. **Unbox results.** Replace `CODE_BLOCK_CLASS` in `ToolCallResult.tsx` and the duplicated
   border+bg in `ToolCallCard.tsx` with `pl-3 border-l font-mono text-muted-foreground`.
   **The 8-line clamp + `+N lines` expander must land in the same commit as the removal of
   `max-h-96 overflow-y-auto`** — that height cap is currently the only thing bounding a result
   inside a virtualised list with measured-height placeholders, and this project has already
   paid for scroll-anchoring drift once.
7. **Composer: 14 objects → 3.** Keep Model and Permission mode inline (permission is the only
   setting with a blast radius). Effort, Fast/Standard, Worktree, Ultracode and MCP go into a
   popover — note Ultracode already sets `disabled={ultracodeEnabled}` on the effort dropdown
   beside it, i.e. two controls on one row currently fight each other.
8. **Colour + type tokens with a CI gate.** Four sizes (15/14/12/11), five colour roles
   (accent/danger/caution/diff-add/diff-del), three text tones. A ripgrep gate that fails
   **new** hardcoded hue utilities outside `src/components/ui/**` and `src/lib/fileTypeColors.ts`
   — without it this decays in two releases (`fileTypeColors.ts` is uncommitted in the working
   tree right now, adding 12 more hues). Migrate one size bucket per commit with screenshots.
   Evaluate removing `.dark body { font-weight: 430 }` (`src/index.css:230`) as a **separate**
   commit, verified in the real Electron renderer on Retina and non-Retina.
9. **Sidebar:** hide `ScriptsDock` when `projectDir` is null (it is mounted at
   `session-browser/SessionBrowser.tsx:187` *outside* the tab switch, so ~12 run-buttons render
   under Live, Browse, Teams and the empty dashboard alike) and default it collapsed — the
   `scripts-dock-collapsed` key already exists. Add `run: <script>` to the palette.
10. **Delete `src/components/SessionBrowser.tsx`** (3-line re-export shim, two import paths for
    one component) and `src/components/ProjectSwitcherModal.tsx` (255 lines — a second project
    picker over the same `/api/projects`, which ⌘K currently *chains into*). Fold its unique
    "paste an absolute path" capability into the palette as a synthesised `Open folder: <path>` row.

## Phase 2 (the bet)

1. **One right rail.** Replace `showFileChanges` / `showStats` and the hand-written exclusion
   expression in `DesktopWorkspace.tsx:274-275` with a single
   `rightRail: "changes" | "stats" | "preview" | "files" | null`.
   **Careful:** only two of those four booleans live in `usePanelState`. `showPreview` and
   `showProjectFiles` are *derived* in `src/hooks/useProjectWorkspace.ts` from a
   `rightWorkspace: {kind, cwd} | null` union with a `cwd === currentCwd` guard that silently
   self-closes the panel when you switch projects — load-bearing behaviour with its own tests.
   Also note `FileChangesPanel` is mounted *inside* the chat's `ResizablePanelGroup` while the
   other three are siblings of `<main>`. This is two-level tree surgery, not a re-parent.
   Add a **pin** toggle and a width-gated split rail above ~2200px.
2. **The rail defaults to the newest turn.** Stolen from FOCUS and worth having on its own:
   live-progress and review become the same view, so returning from an interruption requires no
   mode choice. Rule: **follow the latest turn until the user touches the rail, then stop.**
3. **Exception chips in the header** (Dark Cockpit's annunciator, de-scoped). Fixed priority,
   fixed slots, hard cap of three then `+N`, and one written admission rule: *a chip must be
   actionable and must clear itself.* Sources: leaks > 0, quota ≥ 80%, last-turn errors,
   needs-you count, "N files changed" on turn completion, update available.
   **Decide the scope question first** (see Open questions) — an unscoped chip is a
   false-negative machine across six sessions, and an all-sessions chip is the old header.
4. **One navigator instead of six list UIs.** The largest true simplification available, and the
   riskiest. Only attempt it assembled from the existing selectors (`LiveSessions/sessionListView.ts`,
   `attentionGroups.ts`, `MissionControl/missionControlView.ts`, `useSessionBrowser.ts`) — if
   they turn out to be entangled with their views, stop.
   **Do not do the `selection` reducer rewrite.** `useSessionState.ts` also drives `mobileTab`,
   and `useUrlSync.ts` serialises `mainView`/`selectedTeam`/`dashboardProject` into deep links.
   ~1,300 lines of tests key on those fields. A half-migrated dual-model reducer is worse than
   either model, and half-migrated is the realistic outcome.

---

## Explicitly NOT doing

- **Hiding `ctx %` behind a held modifier.** It is the number sampled most often inside a
  session and it drives compaction planning. `⌥` is a macOS dead-key and the user is in the
  composer most of the day. It stays permanently visible as neutral text, colouring only at
  the amber/red thresholds. (Rejecting Dark Cockpit's Preflight-for-context.)
- **Demoting Mission Control to "the stage when nothing is selected."** For a six-session
  operator it is a HUD you peek at, not the absence of a selection.
  `resolveDesktopMainView` deliberately ranks it above an open session and says so. It keeps its
  button, its amber count and double-tap Command shortcut.
- **Deleting ⌘⇧1-9 "jump to Nth live session."** Three concepts proposed dropping it. A chord is
  not a mode. Fix the conflict by moving device switching, and add visible 1-9 numbering to the
  sidebar so there is something to count against.
- **Deleting `--elevation-4`.** Every concept that proposed it verified `bg-elevation-4` (0 hits)
  instead of the bare `.elevation-4` class, which has **11 live call sites** —
  `ui/dialog.tsx:53`, `ui/sheet.tsx:52`, `ui/bottom-sheet.tsx:86`, `ProjectSwitcherModal.tsx:157`,
  `ThemeSelectorModal.tsx:73`, `SessionContextMenu.tsx:91` and `:125`, `ProjectContextMenu.tsx:65`,
  `UndoConfirmDialog.tsx:44`, `BranchModal/index.tsx:121`, `ConfigDialog/index.tsx:171`.
  Deleting it makes every dialog and sheet in the app transparent. Likewise **do not merge
  `--elevation-0` / `--elevation-1` globally** — they are identical in dark
  (`index.css:144-145`) and genuinely different in light (`:88-89`).
- **Deleting all three turn-boundary cues at once.** The separator, the numbered circle and the
  blue user bubble are how a 40-turn session is scroll-scrubbed. Keep exactly one — the
  recommendation is the accent rule on the user's message (it is also the strongest semantic:
  "this is the human voice"). Ship it as its own A/B.
- **Replacing `SessionContextMenu` / `ProjectContextMenu` / `TurnContextMenu` with a scoped
  palette.** A fixed-position menu shows every option at once; a filtered list must be read
  every time. And `SessionContextMenu.tsx` is not just a menu — it owns two `<Dialog>`s (rename
  at `:91`, delete-confirm at `:125`) that a palette has nowhere to put.
- **Solving anything with `HoverRevealPanel`.** A 6px trigger with a 200ms dwell trades visual
  noise for interaction cost. Do not extend it; if it stays, widen it and never put a
  first-class action behind it.
- **Keeping "quiet" without fixing the live signal.** `src/index.css:481-483` globally disables
  `animate-pulse`, and `LiveSessions/SessionRow.tsx:84` distinguishes "working" from "live but
  idle" *purely* by adding `animate-pulse` to the same green dot — so those two states have been
  pixel-identical for some time. Fix it with shape or brightness before removing any other
  liveness cue.

---

## Stolen from

| Pattern | Source | Cogpit file |
|---|---|---|
| Indicator renders nothing at its nominal value ("dark cockpit") | Airbus A310/A320, 1982 | `LeakIndicator.tsx`, `DeviceSwitcher.tsx`, `TokenUsageWidget.tsx` |
| Fixed-slot alert priority; position *is* the label | Boeing EICAS | new exception chips in `DesktopHeader.tsx` |
| Non-actionable alarms measurably cause suppression | ICU alarm-fatigue research (5-13% actionable) | `ToolCallCard.tsx` `StatusIcon` |
| Erase redundant data-ink; deletion test | Tufte, 1983 | `UserMessage.tsx:376`, `TurnSection.tsx:244` |
| Presets beat knobs (four modes, no model picker) | Amp | `ChatInput/settings/DesktopChatInputSettings.tsx` |
| Summon the diff viewer, don't station it (⌘⇧D) | Conductor | `hooks/usePanelState.ts`, `FileChangesPanel/` |
| One detail surface, contents = f(selection) | Figma inspector · Lightroom · Ableton | `AppShell/DesktopWorkspace.tsx:274-275` |
| One dim digest line per call (`Read 240 lines`) | Claude Code CLI | `shared/session/toolSummary.ts` |
| Collapsed headers carrying command / first line / output length | Zed agent panel | `timeline/ToolCallCard.tsx` |
| Density is earned by the keyboard, not by buttons | Bloomberg Terminal | `CommandPalette.tsx`, `lib/keybindings.ts` |
| The command menu *is* the product | Linear | `CommandPalette.tsx` |
| Configurable/removable toolbar, persisted | Warp | `hooks/usePanelState.ts` |
| Native menu bar as free discovery | macOS HIG | `electron/main.ts:189-216` |
| Hiding frequent controls has a measured cost (guardrail) | Euro NCAP 2026 vs Tesla | `HoverRevealPanel.tsx` |
| Solo mode — one accordion section open | Lightroom Classic | `StatsPanel.tsx` |
| As little design as possible; negative space is active | Rams · *ma* | `ChatArea.tsx` `max-w-3xl` |

---

## Open questions for the user

1. **The 5-hour quota: gauge or alarm?** Every concept hides it below a 70-80% threshold. But
   the information you actually use is the *slope* — "40% by noon, throttle the codex sessions" —
   and a chip that appears at 80% arrives after that decision was available. Options: (a) hide
   below threshold as proposed; (b) keep it always, as one neutral 11px number with no dot and no
   colour until 80%; (c) replace it with a per-session **burn rate** signal, which nobody
   designed and which may be the actually-useful number for a six-session operator.
   **My recommendation: (b) now, (c) as a Phase 2 experiment.**

2. **Whose numbers do the exception chips report?** With six sessions live, does `ctx 24%` mean
   the focused session or any session? Focused-only silently ignores the five you are not
   watching — the exact failure the chips exist to prevent. All-sessions guarantees three chips
   lit permanently — the old header. A third option: chips are focused-session only, *except*
   "N need you", which is fleet-wide. This decision determines whether the chips work at all.

3. **How often do you actually click Kill All, Open-in-editor, Reveal, and Open terminal?**
   These are the four one-click actions the redesign costs you. If any is above ~5 uses/session
   it earns its slot back in the header or the composer's `⋯`. Two weeks of click counting
   before Phase 1 step 3 would settle it — otherwise this is guesswork wearing a rationale.

4. **Do you review diffs and stats side by side on the wide monitor, or one at a time?**
   The single-rail move is the largest architectural simplification available and the only one
   that costs a workflow. If side-by-side is daily rather than occasional, the rail needs a
   width-gated split — which reintroduces exactly the exclusion logic the move exists to delete.

5. **Turn boundaries: which single cue survives?** The separator, the numbered circle, or the
   blue user bubble. The bubble is the strongest semantic and the best scroll landmark; the
   circle is the best click target for restore/jump. Pick one, and ship it as its own change
   so it can be reverted independently of the rest of the transcript work.
