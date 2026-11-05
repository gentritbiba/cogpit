# Beginner onboarding: the starting steps

Goal: someone who has never driven an AI coding agent from a terminal can install
Cogpit, connect an agent and finish a first useful task without outside help.

Cogpit sends no usage data, so progress is tracked by walking these steps as a
newcomer, not by analytics. Re-run the walkthrough after each wave and update the
status column. Evidence for each finding (file:line, screenshots, sandbox output)
is in the audit reports listed at the end.

## The steps a newcomer takes

| # | Step | What goes wrong today | Fix | Status |
|---|------|------------------------|-----|--------|
| 1 | Learn what Cogpit needs | README hero never says an agent CLI must be installed and signed in; Node version wrong (20.11 vs 22.16) | Hero sentence, Node 22.16, CLI install/sign-in links | Done (wave 1) |
| 2 | Install and open it | macOS blocks the unnotarized app with no README guidance; Linux `npx` needs build tools; desktop shows no window for up to 15 s and hangs silently if the server dies | "Open Anyway" steps, Linux note, loading window, startup error dialog | Done (wave 1); notarization is an owner decision |
| 3 | First screen | Desktop never detects Claude Code, so a Claude user hits "Connect your coding agent", which rejects `~/.claude` and a never-run install; the npx build blocks even though it includes Claude; agents installed while Cogpit runs go unnoticed until restart; a scary update banner about the included Claude | Shared auto-detection, `~` expansion, agent check screen with "Check again", included Claude shown as ready to sign in | Done (wave 1) |
| 4 | Know whether the agent is ready | Nothing says whether a CLI is installed or signed in, in the picker or in Settings; launcher prints a scary SQLite warning and nothing else | Agent check and a Settings "Agents" section; picker marks agents not installed; launcher prints found CLIs | Done (wave 1) |
| 5 | Pick a project folder | Home's "Choose a project" says "No projects found" on first run; "Start session here" is active on the home folder; sidebar not shown on home; "All projects" and the phone's empty list have no visible New session | "Open a folder…" first-run action, "Use this folder" with a warning on the home folder, empty states with a button, sidebar New session picker | Done (sidebar New session wave 1; home, folder picker, empty states wave 2) |
| 6 | Send the first task | Starts in Full access with no visible permission control; missing CLI fails only after Send, wipes the typed message and leaves its error under other sessions; signed-out Claude says "run /login" (unavailable in Cogpit) and spins on "Thinking…" forever; Codex shows a raw 401 next to a green check; Copilot loses the message; the server logs none of it | Safe default for new installs + permission chip on home; pre-send install check; error card with a Sign in button that opens the terminal on the agent's login; error turns end with an error status; failures logged | Done (errors and sign-in wave 1; ask-first default for new installs and home access chip wave 2) |
| 7 | Understand what is happening | Jargon on common screens (Steer, turn, Ultracode, "Don't Ask", "Config", Kill process, bare percentages); the process-leak badge and "agents running" count include other apps' processes | Plain-language copy pass; keep Mission Control and Crew names, explain them; scope the badge and count to Cogpit's own processes | Partly: process badge hidden until the first session, "Config" renamed "Agent files" (wave 2); copy pass is wave 3 |
| 8 | Find help | No Help menu, docs links or visible shortcut hints | Help menu, `?` / ⌘K hints on home, docs/first-session.md | Done (Help menu, Help & docs wave 1; home hints, docs/first-session.md wave 2) |

## Decisions

- **No telemetry.** Cogpit promises not to upload usage; the walkthrough above is the tracking method.
- **Safe permissions for new installs only.** Brand-new installs start in each agent's ask-first mode and the home composer shows the permission control. Existing installs keep Full access, which current users rely on.
- **Keep product names.** Mission Control and Crew stay; plain-language subtitles and tooltips explain them.
- **macOS notarization** needs an Apple Developer ID (paid account): owner decision. Until then the README documents "Open Anyway".

## Waves

- **Wave 1 (landed 2026-11-05):** agent setup check with Settings → Agents (core + team edition policy); missing and signed-out agent errors with a Sign in action, failed turns that end, failure logging; desktop loading window, startup error dialog, Help menu, Help & docs in ⋯ and ⌘K; launcher output; README fixes; sidebar New session in every scope; `cogpit-session new --worktree` no longer hangs.
- **Wave 2 (landed 2026-11-05):** first-run home (Open a folder, getting-started checklist, example prompts, empty states with buttons, safe permission default, `?` / ⌘K hints) after the sidebar New session fix lands; docs/first-session.md with screenshots.
- **Wave 3 (next):** plain-language copy pass (Steer, turn, Ultracode, "Don't Ask", bare percentages, per-token prices for subscription users); re-run the full walkthrough on a fresh machine and update this table.

Shipped in v3.5.5.

## Walkthrough recipe

Build into a private folder and run an isolated standalone server with an empty
`HOME`, a reserved port (never 19384) and `env -u COGPIT_SESSION_ID -u COGPIT_ORCHESTRATION_ROOT -u COGPIT_PORT`.
Walk three machines: nothing installed (PATH with only system dirs and bun), a CLI
installed but never signed in, and a signed-out CLI (invalid `ANTHROPIC_API_KEY`).
Use a private `tmp-` browser and screenshot every step.

## Reports

- [Docs, installers and code paths](2026-11-04-onboarding-audit-docs.md) (2026-11-04, HEAD 75b4104e)
- [Live first-run walkthrough](2026-11-04-onboarding-audit-firstrun.md) (2026-11-04, HEAD 75b4104e)
