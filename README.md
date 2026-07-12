<p align="center">
  <img width="2098" height="1289" alt="Screenshot 2026-03-11 at 4 31 18 AM" src="https://github.com/user-attachments/assets/22f4858d-2b17-4f1b-8cd7-f5d07dacd620" />
</p>

<h1 align="center">Cogpit</h1>

<p align="center">
  <em>A real-time control center for <a href="https://docs.anthropic.com/en/docs/claude-code">Claude Code</a> and <a href="https://github.com/openai/codex">Codex</a> sessions.</em>
</p>

<p align="center">
  <a href="https://cogpit.dev">Website</a> · <a href="https://github.com/gentritbiba/cogpit/releases">Download</a>
</p>

---

Cogpit turns Claude Code and Codex into one live, interactive control center. It uses provider-native control APIs for active work and the CLIs' on-disk history for restoration, so you can watch, steer, approve, and debug agents without leaving your workflow.

Available as a **desktop app** (macOS, Linux) or a **browser-based** dev server.

## Download

| Platform | File |
|----------|------|
| macOS (Apple Silicon) | `Cogpit-x.x.x-arm64.dmg` |
| macOS (Intel) | `Cogpit-x.x.x.dmg` |
| Linux (AppImage) | `Cogpit-x.x.x.AppImage` |
| Linux (Debian/Ubuntu) | `Cogpit-x.x.x.deb` |
| Linux (Arch) | `Cogpit-x.x.x.pacman` |

> **Prerequisite:** [Claude Code](https://docs.anthropic.com/en/docs/claude-code) and/or [Codex](https://github.com/openai/codex) must be installed. Cogpit uses your existing CLIs — no API keys or separate login needed.

## Why Cogpit

Claude Code and Codex are powerful, but the terminal gives you a narrow view. Cogpit gives you the full picture:

- **See everything at once** — live sessions, token costs, file changes, and agent activity in one screen
- **Talk to your agents** — send messages, approve plans, answer questions, interrupt or branch at any point
- **Understand usage** — per-turn token/cache breakdowns, published-price estimates, and provider-native plan, credit, and rate-limit monitoring
- **Debug faster** — color-coded tool calls, expandable thinking blocks, line-by-line edit diffs, and complete session history
- **Manage multi-agent workflows** — team dashboards with kanban boards, inter-agent messaging, and per-member session navigation
- **Undo anything** — rewind sessions to any turn with full branching support and file operation reversal

## Features

### Multi-Provider Support
Start sessions with Claude Code or Codex from the same interface. Model settings come from the installed CLIs, including descriptions, recommended and supported reasoning levels, image support, personality support, and speed tiers. GPT-5.6 Sol, Terra, and Luna are supported, with Ultra and Fast shown only when the selected model and account advertise them. If a Codex model is unavailable, Cogpit visibly reports the fallback and retries with the provider default.

### Live Session Monitoring
Stream active sessions via SSE. Watch Claude or Codex think, call tools, edit files, and coordinate subagents in real time. Codex live work uses its persistent app-server control plane for native threads, turns, steering, interruption, goals, and approvals, with a legacy CLI fallback for older installations.

### Interactive Chat
Send or steer messages with a model and effort override, toggle Fast where supported, and choose Read only, Workspace, or explicitly confirmed Full access. Slash command autocomplete comes from project skills and commands. Image drag-and-drop, paste, and conversion are enabled only for models that accept images.

### Long-Running Goals
Create persistent goals above the composer and monitor status, tokens, elapsed time, and provider-native evaluator feedback. Codex goals can optionally use token budgets and explicit pause/resume controls; Claude goals follow Claude Code's native goal lifecycle.

### Conversation Timeline
Structured view of every turn: user messages, thinking blocks, assistant text with syntax-highlighted Markdown, color-coded tool call badges, LCS-based edit diffs, and compaction markers. Virtualized for smooth scrolling across long sessions.

### Sub-Agent Viewer
When Claude or Codex spawns subagents, Cogpit correlates spawn, lifecycle, messages, waits, and final results into one activity record per agent. Color-coded panels show each result within the parent timeline, and full agent threads remain inspectable.

### Token Analytics & Cost Tracking
Per-turn token usage (uncached input, cached input, cache creation, and output), published model pricing, SVG charts, context usage, tool/error/duration breakdowns, and provider-native account limits. Cogpit leaves cost unavailable when a GPT model has no published USD price instead of inventing a fallback value.

### Undo / Redo with Branching
Rewind to any previous turn. Create branches, switch between them via an SVG graph modal. File operations (Edit/Write) are reversed on undo and replayed on redo. Ghost turns show archived content with hover-to-redo.

### File Changes
Track all modifications across a session. Net-diff view (aggregated) or per-edit view (chronological). Sub-agent attribution. Open files in your editor or view git diffs directly.

### Team Dashboards
Inspect multi-agent teams: member status cards, kanban task board, color-coded message timeline, team chat, and live SSE updates.

### Worktree Management
List active git worktrees with dirty/clean status, commits-ahead count, and linked sessions. Create PRs directly. Bulk cleanup of stale worktrees.

### Permissions & MCP Server Selector
Use provider-specific access profiles and tool-level policies. Workspace access is the default; Full access requires a separate warning dialog. Native Codex command, file, and network approval requests—including requests raised by nested subagents—appear in the composer, expose only decisions allowed by the runtime, and resume directly when answered. Choose which MCP servers to enable per session from a searchable selector.

### Agent Configuration Editor
Browse and edit your project's `.claude/` directory directly from the dashboard — skills, slash commands, CLAUDE.md, and MCP server configs. Changes are written to disk immediately, no terminal needed.

### Network Access
Access Cogpit from your phone or tablet on the same LAN. Password-protected with rate-limited auth. Full feature parity with the local client.

### Theming
Dark, Deep OLED, and Light themes with a Malewicz-inspired elevation system, glassmorphism effects, and gradient borders.

## Getting Started

### From Releases (recommended)

Download from the [Releases page](https://github.com/gentritbiba/cogpit/releases) and open.

### From Source

```bash
git clone https://github.com/gentritbiba/cogpit.git
cd cogpit
bun install

# Browser
bun run dev

# Electron
bun run electron:dev
```

### Build

```bash
# Web
bun run build && bun run preview

# Desktop (DMG on macOS, AppImage + deb on Linux)
bun run electron:package
```

## Tech Stack

React 19 · TypeScript · Vite 6 · Electron 40 · Tailwind CSS 4 · Radix UI · Express 5 · SSE + WebSocket · Shiki · Vitest

## License

MIT
