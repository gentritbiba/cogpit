# Floating chrome: remove the desktop top bar

Date: 2026-08-21

## Goal

Remove the 48px desktop header row. The window should read like ChatGPT: the
sidebar owns the top-left of the window (traffic lights, collapse, home,
search); the chat pane has no bar, only a transparent overlay with a few
rounded pills that content scrolls under.

## Layout

- `DesktopAppShell` no longer renders `DesktopHeader`. Update banners stay
  above the workspace.
- **Sidebar header row** (48px) above the "Filter sessions" input: macOS
  traffic-light inset, then ghost icon buttons for collapse sidebar, home
  (eye), and Search (⌘K). Lives in `LiveSessionsToolbar`.
- **`FloatingChrome`** renders inside `<main>` as `absolute inset-x-0 top-0
  pointer-events-none`, with two `pointer-events-auto` clusters:
  - Top-left: open-sidebar pill (only when sidebar hidden), `‹ Main` pill
    (sub-agent sessions only), session pill (only when a session is open),
    Workflows pill (only when `workflowCount > 0`).
  - Top-right: `LeakIndicator` (self-hides), `NotificationsBell`,
    `TokenUsageIndicator` (self-hides), `DeviceSwitcher` (self-hides), `⋯`.
- Pill recipe: `h-8 rounded-full border bg-background/80 backdrop-blur
  shadow-sm`.
- `ChatArea` desktop scroll container gets `pt-12` so the first turn is not
  hidden under a pill.
- Window drag: a 40px invisible `electron-drag` strip across the top of the
  window. Pills are `no-drag` via the existing CSS rule. The traffic-light
  padding rule moves off `.electron-drag` onto a `.window-inset` class used
  only by the sidebar header.
- Dashboard, Mission Control, Config: top-right cluster still renders; no
  session pill. Mission Control keeps its own content header.

## Session pill

`agent-window / acdf2f3f · ● · opus · 82%`

- Reuses `SessionBreadcrumb`: click copies the resume command, right-click
  opens the six-item session context menu.
- Context badge keeps its healthy/warning/critical colours.
- Hover shows a rich tooltip (the existing `Tooltip` primitive, no new
  dependency) listing only rows with values: model · thinking, branch, pull
  request chips, agent / duplicated badges, context detail
  (`remaining · % · used / limit`). The separate context-badge tooltip is
  dropped in favour of this single surface.
- Workflows is the one clickable thing that was in the bar; it stays a small
  ghost pill beside the session pill instead of living in the tooltip.

## Overflow menu (⋯)

```
Workspace
  Mission Control / Config / Worktrees / File changes / Session details
──────────
Usage & cost…        → UsageCostDialog
Server monitor…      → PowerMonitor
Copy network URL     → only when network access is on
──────────
Settings
──────────
Stop all agent processes
```

Search leaves the top-right. With the sidebar collapsed there is no visible
Search button; ⌘K still works because the shortcut is global.

## Files

- New `src/components/FloatingChrome.tsx` (replaces `DesktopHeader.tsx`,
  keeps `SessionBreadcrumb` and network-URL logic).
- New `src/components/SessionPill.tsx`.
- `LiveSessions/LiveSessionsChrome.tsx`: header row; props threaded through
  `SessionBrowser` / `PrimarySessionBrowser`.
- `DesktopAppShell.tsx`, `DesktopWorkspace.tsx`, `ChatArea.tsx`,
  `src/index.css`.
- Delete `DesktopHeader.tsx`. `header-shared.tsx` stays (other consumers).

## Tests

- `DesktopHeader.test.tsx` → `FloatingChrome.test.tsx`; all existing cases
  carry over (breadcrumb copy, context menu, sub-agent nav, network readout,
  overflow menu, pull-request chips now asserted in the tooltip).
- New: tooltip rows, ⋯ menu usage/monitor rows, open-sidebar pill visibility.
- `LiveSessions` tests: sidebar header buttons.
- Mobile shell untouched.
