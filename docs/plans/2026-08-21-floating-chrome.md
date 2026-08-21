# Floating Chrome Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Remove the 48px desktop top bar and replace it with a sidebar header row plus transparent floating pills over the chat pane, ChatGPT-style.

**Architecture:** `DesktopHeader` is deleted. Its left half becomes `SessionPill` (one rounded pill with a rich hover tooltip) inside a new absolutely-positioned `FloatingChrome` overlay rendered in `<main>`; its right half becomes a small pill cluster plus an expanded `⋯` menu. Sidebar-level actions (home, search, collapse) move into a new `SidebarHeader` rendered through a `header` slot on `SessionBrowser`. `UsageCostDialog` and `PowerMonitor` become controlled dialogs opened from the `⋯` menu. Window dragging is an invisible strip at the top of the chat pane plus the sidebar header row.

**Tech Stack:** React 19, Tailwind v4, base-ui (Tooltip/DropdownMenu/ContextMenu via `@/components/ui/*`), vitest + Testing Library, Electron `hiddenInset` title bar. Design: `docs/plans/2026-08-21-floating-chrome-design.md`.

**Working directory:** `/Users/gentritbiba/agent-window/.worktrees/floating-chrome` (branch `floating-chrome`). All paths below are relative to it. Use `bun`, never `npm`.

**Conventions that apply to every task:**
- Run the named test file after each step with `bunx vitest run <path>`.
- Commit after each task. No `Co-Authored-By` lines. Never push.
- Delete code that the task makes unused — imports, components, CSS rules. Lint (`bun run lint`) flags unused imports; fix them in the same task.
- Do not touch `w-72` in `SessionBrowser.tsx`/`DesktopWorkspace.tsx` or `max-w-3xl` in `SessionInputFooter.tsx`: master has uncommitted edits to those exact lines and they must merge cleanly.

---

### Task 1: Drag-region and window-inset CSS

**Files:**
- Modify: `src/index.css:254-274`

**Step 1: Replace the drag/inset block**

Replace everything from `/* Electron window drag region */` through the `html.electron-win .electron-drag` rule with:

```css
/* Electron window drag regions. Chromium computes these geometrically, so a
   no-drag element wins over any drag region it overlaps regardless of z-order. */
.electron-drag {
  -webkit-app-region: drag;
}
.electron-drag button,
.electron-drag a,
.electron-drag input,
.electron-drag [role="button"],
.electron-no-drag {
  -webkit-app-region: no-drag;
}
/* Invisible strip along the top of the chat pane that stands in for the
   removed title bar. Inert outside Electron. */
.drag-strip {
  pointer-events: none;
}
html.electron .drag-strip {
  pointer-events: auto;
  -webkit-app-region: drag;
}

/* Native window control insets — only in Electron where the title bar is
   hidden. public/theme-bootstrap.js sets "electron"/"electron-win" on <html>
   from the user agent. */
html.electron:not(.electron-win) .window-inset-start {
  padding-left: 84px;
}
/* Windows draws its Window Controls Overlay (~138px) on the right. */
html.electron-win .window-inset-end {
  padding-right: 138px;
}
```

**Step 2: Verify nothing else used the old padding rule**

Run: `grep -rn "electron-drag" src --include='*.tsx' | grep -v __tests__`
Expected: only `src/components/DesktopHeader.tsx` (deleted in Task 6).

**Step 3: Commit**

```bash
git add src/index.css
git commit -m "style: split drag region from window-control insets"
```

---

### Task 2: `SidebarHeader` and the `SessionBrowser` header slot

**Files:**
- Create: `src/components/SidebarHeader.tsx`
- Create: `src/components/__tests__/SidebarHeader.test.tsx`
- Modify: `src/components/session-browser/types.ts`
- Modify: `src/components/session-browser/SessionBrowser.tsx`
- Modify: `src/components/session-browser/__tests__/SessionBrowser.test.tsx`
- Modify: `src/components/AppShell/SharedAppViews.tsx:38-78`

**Step 1: Write the failing SidebarHeader test**

`src/components/__tests__/SidebarHeader.test.tsx`:

```tsx
import { describe, expect, it, vi } from "vitest"
import { fireEvent, render, screen } from "@testing-library/react"
import { SidebarHeader } from "@/components/SidebarHeader"

describe("SidebarHeader", () => {
  it("exposes home, search, and collapse with their shortcuts", () => {
    const onToggleSidebar = vi.fn()
    const onGoHome = vi.fn()
    const onOpenCommandPalette = vi.fn()
    const { container } = render(
      <SidebarHeader
        onToggleSidebar={onToggleSidebar}
        onGoHome={onGoHome}
        onOpenCommandPalette={onOpenCommandPalette}
        sidebarShortcut="⌘B"
        commandPaletteShortcut="⌘K"
      />,
    )

    expect(container.firstElementChild).toHaveClass("electron-drag", "window-inset-start")

    fireEvent.click(screen.getByRole("button", { name: "Home" }))
    fireEvent.click(screen.getByRole("button", { name: "Search (⌘K)" }))
    fireEvent.click(screen.getByRole("button", { name: "Hide sidebar (⌘B)" }))

    expect(onGoHome).toHaveBeenCalledOnce()
    expect(onOpenCommandPalette).toHaveBeenCalledOnce()
    expect(onToggleSidebar).toHaveBeenCalledOnce()
  })
})
```

**Step 2: Run it to verify it fails**

Run: `bunx vitest run src/components/__tests__/SidebarHeader.test.tsx`
Expected: FAIL — cannot resolve `@/components/SidebarHeader`.

**Step 3: Create `SidebarHeader`**

`src/components/SidebarHeader.tsx`:

```tsx
import { memo } from "react"
import { Eye, PanelLeftClose, Search } from "lucide-react"
import { HeaderIconButton } from "@/components/header-shared"

interface SidebarHeaderProps {
  onToggleSidebar: () => void
  onGoHome: () => void
  onOpenCommandPalette: () => void
  sidebarShortcut: string
  commandPaletteShortcut: string
}

/**
 * With no title bar, the sidebar's top row owns the window's top-left corner:
 * traffic-light inset, home on the left, and the two actions that leave the
 * sidebar pinned to its right edge.
 */
export const SidebarHeader = memo(function SidebarHeader({
  onToggleSidebar,
  onGoHome,
  onOpenCommandPalette,
  sidebarShortcut,
  commandPaletteShortcut,
}: SidebarHeaderProps) {
  return (
    <div className="electron-drag window-inset-start flex h-12 shrink-0 items-center gap-1 px-2">
      <HeaderIconButton icon={Eye} label="Home" onClick={onGoHome} size="default" />
      <div className="flex-1" />
      <HeaderIconButton
        icon={Search}
        label={`Search (${commandPaletteShortcut})`}
        onClick={onOpenCommandPalette}
        size="default"
      />
      <HeaderIconButton
        icon={PanelLeftClose}
        label={`Hide sidebar (${sidebarShortcut})`}
        onClick={onToggleSidebar}
        size="default"
      />
    </div>
  )
})
```

**Step 4: Run the test to verify it passes**

Run: `bunx vitest run src/components/__tests__/SidebarHeader.test.tsx`
Expected: PASS.

**Step 5: Write the failing SessionBrowser slot test**

Append to the `describe("SessionBrowser")` block in `src/components/session-browser/__tests__/SessionBrowser.test.tsx`:

```tsx
  it("renders the header slot above the sessions list", () => {
    const { container } = render(
      <SessionBrowser
        activeSessionKey={null}
        onSelectSession={vi.fn()}
        header={<div data-testid="sidebar-header" />}
      />,
    )

    const aside = container.firstElementChild
    expect(aside?.firstElementChild).toBe(screen.getByTestId("sidebar-header"))
  })
```

**Step 6: Run it to verify it fails**

Run: `bunx vitest run src/components/session-browser`
Expected: FAIL — `header` is not a known prop / first child is the Live sessions button.

**Step 7: Add the slot**

`src/components/session-browser/types.ts` — add the import and the prop:

```ts
import type { ReactNode } from "react"
```

```ts
  onPrefetchSession?: (dirName: string, fileName: string) => void
  /** Desktop-only row above the session list (home, search, collapse). */
  header?: ReactNode
```

`src/components/session-browser/SessionBrowser.tsx` — destructure `header` and render it first inside `<aside>`:

```tsx
  onPrefetchSession,
  header,
}: SessionBrowserProps): React.ReactElement {
  return (
    <aside
      className={cn(
        "flex h-full shrink-0 flex-col bg-sidebar",
        isMobile ? "w-full" : "w-72",
      )}
      aria-label="Session browser"
    >
      {header}
      <LiveSessions
```

`src/components/AppShell/SharedAppViews.tsx` — thread it through `PrimarySessionBrowser`:

```tsx
import { lazy, Suspense, type MutableRefObject, type ReactNode } from "react"
```

```tsx
interface PrimarySessionBrowserProps {
  navigation: ShellNavigation
  mobile?: boolean
  header?: ReactNode
}

/** Canonical primary session navigation shared by desktop and mobile shells. */
export function PrimarySessionBrowser({
  navigation,
  mobile = false,
  header,
}: PrimarySessionBrowserProps) {
```

and pass `header={header}` to `<SessionBrowser>`.

**Step 8: Run tests**

Run: `bunx vitest run src/components/session-browser src/components/__tests__/SidebarHeader.test.tsx`
Expected: PASS (4 tests).

**Step 9: Commit**

```bash
git add src/components/SidebarHeader.tsx src/components/__tests__/SidebarHeader.test.tsx src/components/session-browser src/components/AppShell/SharedAppViews.tsx
git commit -m "feat: sidebar header row with home, search, and collapse"
```

---

### Task 3: Make `UsageCostDialog` and `PowerMonitor` controlled

**Files:**
- Modify: `src/components/UsageCostDialog.tsx:370-415`
- Modify: `src/components/PowerMonitor.tsx:213-305`
- Modify: `src/components/__tests__/PowerMonitor.test.tsx:65-85`

**Step 1: Update the PowerMonitor test to drive `open`**

Replace the test body in `src/components/__tests__/PowerMonitor.test.tsx`:

```tsx
  it("does not sample until opened, then identifies the busiest process and activity", async () => {
    const view = render(<PowerMonitor open={false} onOpenChange={vi.fn()} />)

    expect(mocks.authFetch).not.toHaveBeenCalled()
    expect(mocks.getElectronSnapshot).not.toHaveBeenCalled()

    view.rerender(<PowerMonitor open onOpenChange={vi.fn()} />)

    expect(await screen.findByRole("heading", { name: "Power & activity monitor" })).toBeInTheDocument()
    await waitFor(() => expect(mocks.authFetch).toHaveBeenCalledWith("/api/performance"))
    expect(await screen.findByText("The renderer is doing the most work, which points to repeated UI rendering, layout, or animation."))
      .toBeInTheDocument()
    expect(screen.getByText("Session file checks")).toBeInTheDocument()
    expect(screen.getByText("GET /api/permissions")).toBeInTheDocument()
    expect(screen.getByText("50% CPU")).toBeInTheDocument()

    view.unmount()
  })
```

Remove the now-unused `userEvent` import.

**Step 2: Run it to verify it fails**

Run: `bunx vitest run src/components/__tests__/PowerMonitor.test.tsx`
Expected: FAIL — heading never appears (component ignores `open`).

**Step 3: Make `PowerMonitor` controlled**

In `src/components/PowerMonitor.tsx`:

```tsx
interface PowerMonitorProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function PowerMonitor({ open, onOpenChange }: PowerMonitorProps) {
```

- Delete `const [open, setOpen] = useState(false)`.
- Replace the polling effect with one that also samples on open:

```tsx
  useEffect(() => {
    if (!open) return
    void refresh()
    const interval = window.setInterval(() => void refresh(), POLL_INTERVAL_MS)
    return () => window.clearInterval(interval)
  }, [open, refresh])
```

- In the return, delete the `<>` fragment and the `<HeaderIconButton … />` trigger; return `<Dialog open={open} onOpenChange={onOpenChange}>` directly.
- Remove the `HeaderIconButton` and `Activity` imports (verify `Activity` is not used elsewhere in the file first with `grep -n Activity src/components/PowerMonitor.tsx`).

**Step 4: Make `UsageCostDialog` controlled**

In `src/components/UsageCostDialog.tsx` replace the exported component:

```tsx
interface UsageCostDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

/** Raw API-equivalent spend across all sessions. Opened from the overflow menu. */
export function UsageCostDialog({ open, onOpenChange }: UsageCostDialogProps) {
  const [days, setDays] = useState<number>(30)

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* existing DialogContent unchanged */}
    </Dialog>
  )
}
```

Delete the `canViewUsage` gate (the menu item that opens it is gated instead, Task 5), the `<>` fragment, and the `HeaderIconButton` trigger. Remove the `HeaderIconButton`, `ChartColumn`, and `useCapability` imports if nothing else in the file uses them (`grep -n "useCapability\|ChartColumn" src/components/UsageCostDialog.tsx`).

**Step 5: Run tests and typecheck**

Run: `bunx vitest run src/components/__tests__/PowerMonitor.test.tsx && bun run typecheck:app`
Expected: test PASS; typecheck FAILS only in `src/components/DesktopHeader.tsx` (it still renders both without props). That is expected until Task 6 — confirm no other file is reported.

**Step 6: Commit**

```bash
git add src/components/UsageCostDialog.tsx src/components/PowerMonitor.tsx src/components/__tests__/PowerMonitor.test.tsx
git commit -m "refactor: usage and power dialogs take open state from their caller"
```

---

### Task 4: `SessionPill`

**Files:**
- Modify: `src/components/header-shared.tsx` (add `FLOATING_PILL`)
- Create: `src/components/SessionPill.tsx`

This task moves `SessionBreadcrumb` out of `DesktopHeader.tsx` unchanged and wraps it in the pill. It is covered by the `FloatingChrome` tests in Task 5; typecheck is the gate here.

**Step 1: Add the shared pill recipe**

In `src/components/header-shared.tsx`, after the imports:

```tsx
/**
 * The one surface for everything that floats over the chat pane now that
 * there is no top bar. Callers add their own height (`h-8` / `size-8`).
 */
export const FLOATING_PILL = "rounded-full border bg-background/80 shadow-sm backdrop-blur"
```

**Step 2: Create `SessionPill`**

`src/components/SessionPill.tsx`:

```tsx
import { memo, startTransition } from "react"
import {
  Check,
  Code2,
  Copy,
  FolderOpen,
  FolderSearch,
  Plus,
  TerminalSquare,
} from "lucide-react"
import type { ReactNode } from "react"
import { Spinner } from "@/components/ui/Spinner"
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { PullRequestChips } from "@/components/PullRequestChips"
import { ContextBadge, FLOATING_PILL, LiveIndicator } from "@/components/header-shared"
import { formatAgentLabel } from "@/components/timeline/agent-utils"
import { useAppContext } from "@/contexts/AppContext"
import type { SessionSource } from "@/hooks/useLiveSession"
import { authFetch } from "@/lib/auth"
import { can } from "@/lib/capabilities"
import { isRemoteDeviceActive } from "@/lib/device"
import {
  formatTokenCount,
  getContextUsage,
  parseSubAgentPath,
  projectName,
  shortenModel,
} from "@/lib/format"
import type { ParsedSession, RawMessage } from "@/lib/types"
import { cn } from "@/lib/utils"
import type { SessionPullRequest } from "../../shared/session/prLinks"

interface SessionPillProps {
  session: ParsedSession
  sessionSource: SessionSource | null
  isLive: boolean
  pullRequests: SessionPullRequest[]
  copied: boolean
  creatingSession: boolean
  onCopyResume: () => void
  onNewSession: (dirName: string, cwd?: string) => void
  onDuplicateSession?: () => void
  onOpenTerminal?: () => void
}

/**
 * `project / session · ● · model · 82%` as one floating pill. Click copies the
 * resume command, right-click opens the session menu, hover lists the rest of
 * the session state (branch, pull requests, agent, context detail).
 */
export const SessionPill = memo(function SessionPill({
  session,
  sessionSource,
  isLive,
  pullRequests,
  copied,
  creatingSession,
  onCopyResume,
  onNewSession,
  onDuplicateSession,
  onOpenTerminal,
}: SessionPillProps) {
  const subAgentInfo = sessionSource ? parseSubAgentPath(sessionSource.fileName) : null
  const subAgentLabel = subAgentInfo ? formatAgentLabel(subAgentInfo.agentId) : null
  const thinkingEnabled = session.turns.some((turn) => turn.thinking.length > 0)
  const rawMessages = (
    session.agentKind === "codex" ? [] : session.rawMessages
  ) as readonly RawMessage[]

  return (
    <Tooltip>
      <TooltipTrigger
        delay={200}
        render={<div className={cn(FLOATING_PILL, "flex h-8 min-w-0 items-center gap-2 pl-1 pr-3")} />}
      >
        {sessionSource ? (
          <SessionBreadcrumb
            session={session}
            sessionSource={sessionSource}
            copied={copied}
            creatingSession={creatingSession}
            onCopyResume={onCopyResume}
            onNewSession={onNewSession}
            onDuplicateSession={onDuplicateSession}
            onOpenTerminal={onOpenTerminal}
          />
        ) : (
          <button
            type="button"
            onClick={onCopyResume}
            className="truncate rounded-full px-1.5 py-1 text-sm font-medium text-foreground"
          >
            {copied ? "Copied" : session.slug || session.sessionId.slice(0, 8)}
          </button>
        )}
        {isLive && <LiveIndicator aria-label="Session is live" />}
        {session.model && (
          <span className="shrink-0 font-mono text-[11px] text-foreground/80">
            {shortenModel(session.model)}
          </span>
        )}
        <ContextBadge rawMessages={rawMessages} />
      </TooltipTrigger>
      <TooltipContent side="bottom" align="start" sideOffset={6} className="p-3">
        <SessionDetails
          session={session}
          thinkingEnabled={thinkingEnabled}
          subAgentLabel={subAgentLabel}
          pullRequests={pullRequests}
          rawMessages={rawMessages}
        />
      </TooltipContent>
    </Tooltip>
  )
})

interface SessionDetailsProps {
  session: ParsedSession
  thinkingEnabled: boolean
  subAgentLabel: string | null
  pullRequests: SessionPullRequest[]
  rawMessages: readonly RawMessage[]
}

function DetailRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex gap-3">
      <span className="w-24 shrink-0 text-muted-foreground">{label}</span>
      <span className="flex min-w-0 flex-1 flex-wrap items-center gap-1">{children}</span>
    </div>
  )
}

function SessionDetails({
  session,
  thinkingEnabled,
  subAgentLabel,
  pullRequests,
  rawMessages,
}: SessionDetailsProps) {
  const ctx = getContextUsage(rawMessages)
  const duplicatedFrom = session.branchedFrom
  return (
    <div className="flex min-w-64 max-w-96 flex-col gap-1.5 text-xs">
      {session.model && (
        <DetailRow label="Model">
          <span>{shortenModel(session.model)}</span>
          {thinkingEnabled && <span className="text-muted-foreground">· thinking</span>}
        </DetailRow>
      )}
      {session.gitBranch && (
        <DetailRow label="Branch">
          <span className="truncate font-mono">{session.gitBranch}</span>
        </DetailRow>
      )}
      {pullRequests.length > 0 && (
        <DetailRow label="Pull requests">
          <PullRequestChips pullRequests={pullRequests} />
        </DetailRow>
      )}
      {subAgentLabel && <DetailRow label="Agent">{subAgentLabel}</DetailRow>}
      {duplicatedFrom && (
        <DetailRow label="Duplicated from">
          {duplicatedFrom.sessionId.slice(0, 8)}
          {duplicatedFrom.turnIndex != null ? ` at turn ${duplicatedFrom.turnIndex + 1}` : ""}
        </DetailRow>
      )}
      {ctx && (
        <DetailRow label="Context">
          {formatTokenCount(Math.max(0, ctx.compactAt - ctx.used))} left before compact ·{" "}
          {formatTokenCount(ctx.used)} / {formatTokenCount(ctx.limit)}
        </DetailRow>
      )}
    </div>
  )
}

interface SessionBreadcrumbProps {
  session: ParsedSession
  sessionSource: SessionSource
  copied: boolean
  creatingSession: boolean
  onCopyResume: () => void
  onNewSession: (dirName: string, cwd?: string) => void
  onDuplicateSession?: () => void
  onOpenTerminal?: () => void
}

function SessionBreadcrumb({
  session,
  sessionSource,
  copied,
  creatingSession,
  onCopyResume,
  onNewSession,
  onDuplicateSession,
  onOpenTerminal,
}: SessionBreadcrumbProps) {
  // ── copy verbatim from DesktopHeader.tsx lines 370-466 (body unchanged) ──
}
```

For `SessionBreadcrumb`, copy the function body from `src/components/DesktopHeader.tsx` exactly — it already has the `useAppContext` dispatch, `postAction`, `handleViewProjectSessions`, the `ContextMenu` with six items, and the `hover:bg-accent rounded-sm` trigger. Change only the trigger's `rounded-sm` to `rounded-full`.

**Step 3: Typecheck**

Run: `bun run typecheck:app`
Expected: no errors in `SessionPill.tsx` or `header-shared.tsx` (errors in `DesktopHeader.tsx` from Task 3 remain until Task 6).

**Step 4: Commit**

```bash
git add src/components/SessionPill.tsx src/components/header-shared.tsx
git commit -m "feat: session pill with hover details"
```

---

### Task 5: `FloatingChrome` and its tests

**Files:**
- Create: `src/components/FloatingChrome.tsx`
- Move: `src/components/__tests__/DesktopHeader.test.tsx` → `src/components/__tests__/FloatingChrome.test.tsx` (use `git mv`)

**Step 1: Rewrite the test file for `FloatingChrome`**

`git mv src/components/__tests__/DesktopHeader.test.tsx src/components/__tests__/FloatingChrome.test.tsx`, then edit:

Imports and mocks (replace the top of the file down to `const PROPS`):

```tsx
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { FloatingChrome } from "@/components/FloatingChrome"
import { getResumeCommand } from "@/lib/sessionSource"
import type { ActiveSessionInfo } from "@/components/LiveSessions/types"
import type { ParsedSession, Turn } from "@/lib/types"

const mocks = vi.hoisted(() => ({
  config: { networkUrl: null as string | null, defaultAgentKind: "claude" as const },
  session: null as ParsedSession | null,
  sessionSource: null as {
    dirName: string
    fileName: string
    rawText: string
    agentKind?: "claude" | "codex"
  } | null,
  isLive: false,
  copy: vi.fn(),
  copyToClipboard: vi.fn(),
  dispatch: vi.fn(),
  authFetch: vi.fn(),
  toastSuccess: vi.fn(),
  inventorySessions: [] as ActiveSessionInfo[],
}))

vi.mock("@/contexts/AppContext", () => ({
  useAppContext: () => ({ config: mocks.config, dispatch: mocks.dispatch }),
}))
vi.mock("@/contexts/SessionContext", () => ({
  useSessionContext: () => ({
    session: mocks.session,
    sessionSource: mocks.sessionSource,
    isLive: mocks.isLive,
  }),
}))
vi.mock("@/contexts/SessionInventoryContext", () => ({
  useSessionInventoryOptional: () => ({ sessions: mocks.inventorySessions }),
}))
vi.mock("@/hooks/useCopyWithFeedback", () => ({
  useCopyWithFeedback: () => [false, mocks.copy],
}))
vi.mock("@/hooks/useCapability", () => ({ useCapability: () => true }))
vi.mock("@/lib/auth", () => ({ authFetch: mocks.authFetch }))
vi.mock("@/lib/utils", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/utils")>()),
  copyToClipboard: mocks.copyToClipboard,
}))
vi.mock("sonner", () => ({ toast: { success: mocks.toastSuccess } }))
vi.mock("@/components/TokenUsageWidget", () => ({ TokenUsageIndicator: () => null }))
vi.mock("@/components/LeakIndicator", () => ({ LeakIndicator: () => null }))
vi.mock("@/components/DeviceSwitcher", () => ({ DeviceSwitcher: () => null }))
vi.mock("@/components/NotificationsBell", () => ({ NotificationsBell: () => null }))
vi.mock("@/components/PowerMonitor", () => ({
  PowerMonitor: ({ open }: { open: boolean }) => (open ? <div data-testid="power-monitor" /> : null),
}))
vi.mock("@/components/UsageCostDialog", () => ({
  UsageCostDialog: ({ open }: { open: boolean }) => (open ? <div data-testid="usage-dialog" /> : null),
}))

const PROPS = {
  showSidebar: true,
  sidebarShortcut: "⌘B",
  showStats: false,
  killing: false,
  creatingSession: false,
  onNewSession: vi.fn(),
  onDuplicateSession: vi.fn(),
  onOpenTerminal: vi.fn(),
  onBackToMain: vi.fn(),
  onShowWorkflows: vi.fn(),
  workflowCount: 0,
  onToggleSidebar: vi.fn(),
  onToggleStats: vi.fn(),
  onKillAll: vi.fn(),
  onOpenSettings: vi.fn(),
}
```

Keep `prTurn`, `makeSession`, `withScannedSession` as they are. Replace `renderHeader` with:

```tsx
function renderChrome(overrides: Partial<typeof PROPS> = {}): ReturnType<typeof render> {
  return render(<FloatingChrome {...PROPS} {...overrides} />)
}

function sessionPill(): HTMLElement {
  return screen.getByRole("button", { name: /my-session/ })
}

async function openSessionDetails(user: ReturnType<typeof userEvent.setup>): Promise<HTMLElement> {
  await user.hover(sessionPill())
  return screen.findByRole("tooltip")
}
```

Rename both `describe` blocks to `"FloatingChrome"` / `"FloatingChrome pull requests"`, and change every `renderHeader()` to `renderChrome()` and `render(<DesktopHeader …/>)` to `renderChrome({...})`. Then update these cases:

```tsx
  it("shows the session state that used to occupy the two lower bars", async () => {
    const user = userEvent.setup()
    const thinkingTurn = prTurn("thinking", "echo ok", "ok")
    thinkingTurn.thinking = [{ type: "thinking", thinking: "Working", signature: "sig" }]
    mocks.session = makeSession({
      model: "claude-opus-4-5",
      gitBranch: "feat/clean-header",
      turns: [thinkingTurn],
      branchedFrom: { sessionId: "parent-session", turnIndex: 2 },
      rawMessages: [{
        type: "assistant",
        message: {
          model: "claude-opus-4-5",
          usage: {
            input_tokens: 50_000,
            output_tokens: 1_000,
            cache_creation_input_tokens: 10_000,
            cache_read_input_tokens: 5_000,
          },
        },
      }],
    })
    mocks.isLive = true

    renderChrome({ workflowCount: 2 })

    expect(screen.getByText("opus")).toBeInTheDocument()
    expect(screen.getByLabelText("Session is live")).toBeInTheDocument()
    expect(screen.getByText(/93%/)).toBeInTheDocument()
    expect(screen.getByRole("button", { name: /Workflows/ })).toHaveTextContent("2")
    expect(screen.queryByText("feat/clean-header")).not.toBeInTheDocument()

    const details = await openSessionDetails(user)
    expect(details).toHaveTextContent("thinking")
    expect(details).toHaveTextContent("feat/clean-header")
    expect(details).toHaveTextContent("Duplicated from")
    expect(details).toHaveTextContent("parent-s at turn 3")
    expect(details).toHaveTextContent(/left before compact/)
  })

  it("preserves sub-agent navigation and identity", async () => {
    const user = userEvent.setup()
    mocks.sessionSource = {
      dirName: "-tmp-project",
      fileName: "parent/subagents/agent-a1b2c3d4e5.jsonl",
      rawText: "",
      agentKind: "claude",
    }

    renderChrome()

    fireEvent.click(screen.getByRole("button", { name: "Main" }))
    expect(PROPS.onBackToMain).toHaveBeenCalledOnce()

    const details = await openSessionDetails(user)
    expect(details).toHaveTextContent("Agent")
    expect(details).toHaveTextContent("a1b2c3d4")
  })

  it("offers the sidebar toggle only while the sidebar is hidden", () => {
    const { unmount } = renderChrome()
    expect(screen.queryByRole("button", { name: "Show sidebar (⌘B)" })).not.toBeInTheDocument()
    unmount()

    renderChrome({ showSidebar: false })
    fireEvent.click(screen.getByRole("button", { name: "Show sidebar (⌘B)" }))
    expect(PROPS.onToggleSidebar).toHaveBeenCalledOnce()
  })

  it("renders no network readout while network access is off", async () => {
    const user = userEvent.setup()
    renderChrome()

    await user.click(screen.getByRole("button", { name: "More actions" }))
    await screen.findByRole("menuitem", { name: "Settings" })

    expect(screen.queryByRole("menuitem", { name: /Copy network URL/ })).not.toBeInTheDocument()
  })

  it("copies the connection URL from the overflow menu while reachable on the network", async () => {
    const user = userEvent.setup()
    mocks.config = { networkUrl: "http://10.0.0.4:19384", defaultAgentKind: "claude" }
    mocks.copyToClipboard.mockResolvedValue(true)
    renderChrome()

    await user.click(screen.getByRole("button", { name: "More actions" }))
    await user.click(await screen.findByRole("menuitem", { name: /10\.0\.0\.4/ }))

    expect(mocks.copyToClipboard).toHaveBeenCalledWith("http://10.0.0.4:19384")
    await vi.waitFor(() => expect(mocks.toastSuccess).toHaveBeenCalledWith("Copied network URL"))
  })

  it("keeps secondary workspace actions in the overflow menu", async () => {
    const user = userEvent.setup()
    renderChrome()

    expect(screen.queryByRole("menuitem", { name: "Settings" })).not.toBeInTheDocument()

    await user.click(screen.getByRole("button", { name: "More actions" }))
    await user.click(await screen.findByRole("menuitem", { name: "Settings" }))

    expect(PROPS.onOpenSettings).toHaveBeenCalledOnce()
  })

  it("opens usage and the server monitor from the overflow menu", async () => {
    const user = userEvent.setup()
    renderChrome()

    await user.click(screen.getByRole("button", { name: "More actions" }))
    await user.click(await screen.findByRole("menuitem", { name: "Usage & cost…" }))
    expect(screen.getByTestId("usage-dialog")).toBeInTheDocument()

    await user.click(screen.getByRole("button", { name: "More actions" }))
    await user.click(await screen.findByRole("menuitem", { name: "Server monitor…" }))
    expect(screen.getByTestId("power-monitor")).toBeInTheDocument()
  })
```

Delete the old `"shows the connection URL while the machine is reachable on the network"` case (replaced above).

In the pull-request `describe`, every case now hovers first. Pattern:

```tsx
  it("renders pull requests extracted from loaded turns", async () => {
    const user = userEvent.setup()
    mocks.session = makeSession({
      turns: [prTurn("1", 'gh pr create --title "Team Edition"', "https://github.com/o/r/pull/13")],
    })

    renderChrome()
    await openSessionDetails(user)

    const link = screen.getByRole("link", { name: "Pull request #13" })
    // …assertions unchanged
  })
```

Apply the same `const user = userEvent.setup()` / `renderChrome()` / `await openSessionDetails(user)` prelude to the other five PR cases; their assertions stay as they are (`getByText("+2")`, `queryByRole("link", …)`, `getAllByRole(…)`). Note `openSessionDetails` needs the `my-session` breadcrumb, which `makeSession()` always provides.

**Step 2: Run it to verify it fails**

Run: `bunx vitest run src/components/__tests__/FloatingChrome.test.tsx`
Expected: FAIL — cannot resolve `@/components/FloatingChrome`.

**Step 3: Create `FloatingChrome`**

`src/components/FloatingChrome.tsx`:

```tsx
import { memo, useMemo, useState } from "react"
import type { LucideIcon } from "lucide-react"
import {
  Activity,
  ChartColumn,
  Check,
  ChevronRight,
  FileCode2,
  GitBranch,
  Globe,
  LayoutGrid,
  MoreHorizontal,
  PanelLeftOpen,
  PanelRightClose,
  PanelRightOpen,
  Settings,
  Skull,
  SlidersHorizontal,
  Workflow as WorkflowIcon,
} from "lucide-react"
import { toast } from "sonner"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { DeviceSwitcher } from "@/components/DeviceSwitcher"
import { LeakIndicator } from "@/components/LeakIndicator"
import { NotificationsBell } from "@/components/NotificationsBell"
import { PowerMonitor } from "@/components/PowerMonitor"
import { SessionPill } from "@/components/SessionPill"
import { TokenUsageIndicator } from "@/components/TokenUsageWidget"
import { UsageCostDialog } from "@/components/UsageCostDialog"
import { FLOATING_PILL } from "@/components/header-shared"
import { useAppContext } from "@/contexts/AppContext"
import { useSessionContext } from "@/contexts/SessionContext"
import { useSessionInventoryOptional } from "@/contexts/SessionInventoryContext"
import { useCapability } from "@/hooks/useCapability"
import { useCopyWithFeedback } from "@/hooks/useCopyWithFeedback"
import { can } from "@/lib/capabilities"
import { parseSubAgentPath } from "@/lib/format"
import { agentKindFromDirName, getResumeCommand } from "@/lib/sessionSource"
import { cn, copyToClipboard } from "@/lib/utils"
import { extractPullRequests, mergePullRequests } from "../../shared/session/prLinks"

interface FloatingChromeProps {
  showSidebar: boolean
  sidebarShortcut: string
  showStats: boolean
  showWorktrees?: boolean
  showFileChanges?: boolean
  hasFileChanges?: boolean
  killing: boolean
  creatingSession: boolean
  onNewSession: (dirName: string, cwd?: string) => void
  onDuplicateSession?: () => void
  onOpenTerminal?: () => void
  onBackToMain?: () => void
  onShowWorkflows?: () => void
  workflowCount?: number
  onToggleSidebar: () => void
  onToggleStats: () => void
  onToggleWorktrees?: () => void
  onToggleFileChanges?: () => void
  onKillAll: () => void
  onOpenSettings: () => void
  showConfig?: boolean
  onToggleConfig?: () => void
  showMission?: boolean
  onToggleMission?: () => void
}

const PILL_ROW = "flex h-8 items-center px-0.5"

/**
 * Everything that used to live in the top bar, floating over the chat pane:
 * session pill on the left, status pills and the overflow menu on the right.
 * Content scrolls underneath; the pane reserves its own top padding.
 */
export const FloatingChrome = memo(function FloatingChrome({
  showSidebar,
  sidebarShortcut,
  showStats,
  showWorktrees,
  showFileChanges,
  hasFileChanges,
  killing,
  creatingSession,
  onNewSession,
  onDuplicateSession,
  onOpenTerminal,
  onBackToMain,
  onShowWorkflows,
  workflowCount,
  onToggleSidebar,
  onToggleStats,
  onToggleWorktrees,
  onToggleFileChanges,
  onKillAll,
  onOpenSettings,
  showConfig,
  onToggleConfig,
  showMission,
  onToggleMission,
}: FloatingChromeProps) {
  const { config: { networkUrl, defaultAgentKind } } = useAppContext()
  const { session, sessionSource, isLive } = useSessionContext()
  const inventory = useSessionInventoryOptional()
  const canViewUsage = useCapability("viewUsage")
  const [usageOpen, setUsageOpen] = useState(false)
  const [monitorOpen, setMonitorOpen] = useState(false)
  const [cmdCopied, copyCmd] = useCopyWithFeedback()

  const sessionTurns = session?.turns
  const scanned = inventory?.sessions.find(
    (candidate) => candidate.sessionId === session?.sessionId,
  )?.pullRequests
  const pullRequests = useMemo(
    () => mergePullRequests(extractPullRequests(sessionTurns ?? []), scanned),
    [sessionTurns, scanned],
  )
  const activeAgentKind = sessionSource
    ? sessionSource.agentKind ?? agentKindFromDirName(sessionSource.dirName)
    : defaultAgentKind
  const isSubAgent = sessionSource ? parseSubAgentPath(sessionSource.fileName) !== null : false

  function handleCopyResumeCmd(): void {
    if (!session) return
    const agentKind = sessionSource?.agentKind ?? agentKindFromDirName(sessionSource?.dirName ?? null)
    copyCmd(getResumeCommand(agentKind, session.sessionId, session.cwd))
  }

  function handleCopyNetworkUrl(): void {
    if (!networkUrl) return
    void copyToClipboard(networkUrl).then((ok) => {
      if (ok) toast.success("Copied network URL")
    })
  }

  return (
    <>
      <div className="pointer-events-none absolute inset-x-0 top-0 z-30 flex items-start justify-between gap-3 px-3 pt-2">
        <div
          className={cn(
            "electron-no-drag pointer-events-auto flex min-w-0 items-center gap-1.5",
            !showSidebar && "window-inset-start",
          )}
        >
          {!showSidebar && (
            <PillIconButton
              icon={PanelLeftOpen}
              label={`Show sidebar (${sidebarShortcut})`}
              onClick={onToggleSidebar}
            />
          )}

          {session && isSubAgent && onBackToMain && (
            <Button
              type="button"
              variant="ghost"
              size="xs"
              onClick={onBackToMain}
              className={cn(FLOATING_PILL, "h-8 shrink-0 px-2.5 text-xs text-muted-foreground")}
            >
              <ChevronRight className="size-3 rotate-180" />
              Main
            </Button>
          )}

          {session && (
            <SessionPill
              session={session}
              sessionSource={sessionSource}
              isLive={isLive}
              pullRequests={pullRequests}
              copied={cmdCopied}
              creatingSession={creatingSession}
              onCopyResume={handleCopyResumeCmd}
              onNewSession={onNewSession}
              onDuplicateSession={onDuplicateSession}
              onOpenTerminal={onOpenTerminal}
            />
          )}

          {session && onShowWorkflows && (workflowCount ?? 0) > 0 && (
            <Button
              variant="ghost"
              size="xs"
              className={cn(FLOATING_PILL, "h-8 shrink-0 gap-1 px-2.5 text-[11px] text-muted-foreground hover:text-foreground")}
              onClick={onShowWorkflows}
            >
              <WorkflowIcon className="size-3" />
              Workflows
              <Badge variant="outline" className="h-4 min-w-4 justify-center px-1 text-[9px] font-semibold">
                {workflowCount}
              </Badge>
            </Button>
          )}
        </div>

        <div className="electron-no-drag window-inset-end pointer-events-auto flex shrink-0 items-center gap-1.5">
          <div className={cn(FLOATING_PILL, PILL_ROW, "empty:hidden")}>
            <LeakIndicator />
          </div>
          <div className={cn(FLOATING_PILL, PILL_ROW, "empty:hidden")}>
            <NotificationsBell />
          </div>
          <div className={cn(FLOATING_PILL, PILL_ROW, "empty:hidden")}>
            <TokenUsageIndicator agentKind={activeAgentKind} />
          </div>
          <div className={cn(FLOATING_PILL, PILL_ROW, "empty:hidden")}>
            <DeviceSwitcher />
          </div>

          <div className={cn(FLOATING_PILL, PILL_ROW)}>
            <DropdownMenu>
              <DropdownMenuTrigger
                render={<Button variant="ghost" size="icon-sm" aria-label="More actions" />}
              >
                <MoreHorizontal data-icon="inline-start" />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" sideOffset={6} className="w-64">
                <DropdownMenuGroup>
                  <DropdownMenuLabel>Workspace</DropdownMenuLabel>
                  {onToggleMission && (
                    <DropdownMenuItem onClick={onToggleMission}>
                      <LayoutGrid />
                      Mission Control
                      {showMission && <Check className="ml-auto" />}
                    </DropdownMenuItem>
                  )}
                  {onToggleConfig && (
                    <DropdownMenuItem onClick={onToggleConfig}>
                      <SlidersHorizontal />
                      Config
                      {showConfig && <Check className="ml-auto" />}
                    </DropdownMenuItem>
                  )}
                  {onToggleWorktrees && (
                    <DropdownMenuItem onClick={onToggleWorktrees}>
                      <GitBranch />
                      Worktrees
                      {showWorktrees && <Check className="ml-auto" />}
                    </DropdownMenuItem>
                  )}
                  {hasFileChanges && onToggleFileChanges && (
                    <DropdownMenuItem onClick={onToggleFileChanges}>
                      <FileCode2 />
                      File changes
                      {showFileChanges && <Check className="ml-auto" />}
                    </DropdownMenuItem>
                  )}
                  {session && (
                    <DropdownMenuItem onClick={onToggleStats}>
                      {showStats ? <PanelRightClose /> : <PanelRightOpen />}
                      Session details
                      {showStats && <Check className="ml-auto" />}
                    </DropdownMenuItem>
                  )}
                </DropdownMenuGroup>
                <DropdownMenuSeparator />
                <DropdownMenuGroup>
                  {canViewUsage && (
                    <DropdownMenuItem onClick={() => setUsageOpen(true)}>
                      <ChartColumn />
                      Usage & cost…
                    </DropdownMenuItem>
                  )}
                  <DropdownMenuItem onClick={() => setMonitorOpen(true)}>
                    <Activity />
                    Server monitor…
                  </DropdownMenuItem>
                  {networkUrl && (
                    <DropdownMenuItem onClick={handleCopyNetworkUrl}>
                      <Globe className="text-success" />
                      Copy network URL
                      <span className="ml-auto truncate pl-2 font-mono text-[11px] text-muted-foreground">
                        {networkUrl}
                      </span>
                    </DropdownMenuItem>
                  )}
                </DropdownMenuGroup>
                <DropdownMenuSeparator />
                <DropdownMenuGroup>
                  <DropdownMenuItem onClick={onOpenSettings}>
                    <Settings />
                    Settings
                  </DropdownMenuItem>
                </DropdownMenuGroup>
                {can("killAny") && (
                  <>
                    <DropdownMenuSeparator />
                    <DropdownMenuGroup>
                      <DropdownMenuItem
                        variant="destructive"
                        onClick={onKillAll}
                        disabled={killing}
                      >
                        <Skull />
                        {killing ? "Stopping processes…" : "Stop all agent processes"}
                      </DropdownMenuItem>
                    </DropdownMenuGroup>
                  </>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>
      </div>

      {canViewUsage && <UsageCostDialog open={usageOpen} onOpenChange={setUsageOpen} />}
      <PowerMonitor open={monitorOpen} onOpenChange={setMonitorOpen} />
    </>
  )
})

interface PillIconButtonProps {
  icon: LucideIcon
  label: string
  onClick: () => void
}

function PillIconButton({ icon: Icon, label, onClick }: PillIconButtonProps) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={onClick}
            aria-label={label}
            className={cn(FLOATING_PILL, "size-8 shrink-0")}
          />
        }
      >
        <Icon data-icon="inline-start" />
      </TooltipTrigger>
      <TooltipContent side="bottom">{label}</TooltipContent>
    </Tooltip>
  )
}
```

**Step 4: Run the tests**

Run: `bunx vitest run src/components/__tests__/FloatingChrome.test.tsx`
Expected: PASS (16 tests). If a hover case times out, confirm `screen.findByRole("tooltip")` is what base-ui renders (`data-slot="tooltip-content"` has `role="tooltip"`); if the role is missing, switch `openSessionDetails` to `return screen.findByText("Model")` for cases with a model and `findByText("Pull requests")` for PR cases.

**Step 5: Commit**

```bash
git add src/components/FloatingChrome.tsx src/components/__tests__/FloatingChrome.test.tsx
git commit -m "feat: floating chrome replaces the desktop header contents"
```

---

### Task 6: Wire the shell, delete `DesktopHeader`

**Files:**
- Modify: `src/components/AppShell/DesktopAppShell.tsx`
- Modify: `src/components/AppShell/DesktopWorkspace.tsx`
- Modify: `src/components/AppShell/__tests__/DesktopWorkspace.test.tsx`
- Delete: `src/components/DesktopHeader.tsx`

**Step 1: Extend the DesktopWorkspace test**

In `src/components/AppShell/__tests__/DesktopWorkspace.test.tsx`:

Add mocks after the existing `vi.mock("@/components/session-browser", …)`:

```tsx
vi.mock("@/components/FloatingChrome", () => ({
  FloatingChrome: ({ showSidebar }: { showSidebar: boolean }) => (
    <div data-testid="floating-chrome">{showSidebar ? "sidebar-on" : "sidebar-off"}</div>
  ),
}))
```

Change the `session-browser` mock so it exposes the header slot:

```tsx
vi.mock("@/components/session-browser", () => ({
  SessionBrowser: ({ activeSessionKey, header }: { activeSessionKey: string | null; header?: ReactNode }) => (
    <div data-testid="session-browser">
      {header}
      {activeSessionKey ?? "no-session"}
    </div>
  ),
}))
```

In `setContexts`, give the AppContext mock a `config`:

```tsx
  contextMocks.useAppContext.mockReturnValue({
    state: { /* unchanged */ },
    config: { openConfigDialog: vi.fn() },
  } as unknown as ReturnType<typeof useAppContext>)
```

In `makeProps`, widen the type and add `chrome`:

```tsx
function makeProps(
  overrides: Partial<DesktopAppShellProps> = {},
): DesktopAppShellProps {
  return {
    navigation: { /* unchanged */ },
    sessionView: { /* unchanged */ },
    project: { /* unchanged */ },
    chrome: {
      backgroundServers: null,
      processPanel: null,
      workflowsPanel: null,
      undoDialog: null,
      branchModal: null,
      killing: false,
      onKillAll: vi.fn(),
      commandPaletteOpen: false,
      onCommandPaletteOpenChange: vi.fn(),
      onOpenCommandPalette: vi.fn(),
      onFocusComposer: vi.fn(),
      onExpandAll: vi.fn(),
      onExpandToolPayloads: vi.fn(),
      onCollapseAll: vi.fn(),
      keyboardShortcutsOpen: false,
      onKeyboardShortcutsOpenChange: vi.fn(),
    },
    ...overrides,
  }
}
```

Add two cases:

```tsx
  it("floats the chrome over the main pane and puts the header row in the sidebar", () => {
    setContexts({ session: makeSession() })

    render(<DesktopWorkspace {...makeProps()} />)

    expect(screen.getByTestId("floating-chrome")).toHaveTextContent("sidebar-on")
    expect(screen.getByRole("button", { name: "Home" })).toBeInTheDocument()
    expect(screen.getByRole("button", { name: /Hide sidebar/ })).toBeInTheDocument()
  })

  it("tells the chrome when the sidebar is hidden", () => {
    setContexts()
    const props = makeProps()
    props.navigation.panels.showSidebar = false

    render(<DesktopWorkspace {...props} />)

    expect(screen.getByTestId("floating-chrome")).toHaveTextContent("sidebar-off")
    expect(screen.queryByRole("button", { name: "Home" })).not.toBeInTheDocument()
  })
```

**Step 2: Run it to verify it fails**

Run: `bunx vitest run src/components/AppShell/__tests__/DesktopWorkspace.test.tsx`
Expected: FAIL — `floating-chrome` test id not found.

**Step 3: Rewire `DesktopWorkspace`**

Imports to add at the top of `src/components/AppShell/DesktopWorkspace.tsx`:

```tsx
import { FloatingChrome } from "@/components/FloatingChrome"
import { SidebarHeader } from "@/components/SidebarHeader"
import { shortcutLabel } from "@/lib/keybindings"
```

Rename the existing prop alias and add a full-props one:

```tsx
type DesktopViewProps = Pick<
  DesktopAppShellProps,
  "navigation" | "sessionView" | "project"
>
```

`DesktopSessionContent` and `DesktopMainView` take `DesktopViewProps`. In `DesktopSessionContent`, offset the team bar so it clears the pills:

```tsx
          <div className="relative flex h-full min-h-0 flex-col">
            {sessionView.teamMembersBar && (
              <div className="pt-10">{sessionView.teamMembersBar}</div>
            )}
            <ChatArea
```

In `DesktopMainView`, give the two views that have their own headers room for the pills:

```tsx
  if (view === "config") {
    return (
      <Suspense fallback={<LazyViewFallback label="Loading configuration…" />}>
        <div className="motion-session-enter flex min-h-0 flex-1 pt-10">
```

```tsx
  if (view === "mission") {
    return (
      <div className="flex min-h-0 flex-1 flex-col pt-10">
        <MissionControlView navigation={navigation} />
      </div>
    )
  }
```

and in the pending branch change `"flex-1 overflow-y-auto px-4 py-6"` to `"flex-1 overflow-y-auto px-4 pb-6 pt-14"`.

Replace the exported component's signature and return:

```tsx
export function DesktopWorkspace({
  navigation,
  sessionView,
  project,
  chrome,
}: DesktopAppShellProps) {
  const { state, config } = useAppContext()
  const { session } = useSessionContext()

  // addProjectContext unchanged

  const sidebarHeader = (
    <SidebarHeader
      onToggleSidebar={navigation.panels.handleToggleSidebar}
      onGoHome={navigation.actions.handleGoHome}
      onOpenCommandPalette={chrome.onOpenCommandPalette}
      sidebarShortcut={shortcutLabel("toggleSidebar")}
      commandPaletteShortcut={shortcutLabel("commandPalette")}
    />
  )

  return (
    <div className="relative flex min-h-0 flex-1 overflow-hidden bg-background">
      {navigation.panels.showSidebar && state.mainView !== "config" && (
        <div className="view-transition-sidebar panel-enter w-72 shrink-0 border-r bg-sidebar text-sidebar-foreground">
          <PrimarySessionBrowser navigation={navigation} header={sidebarHeader} />
        </div>
      )}

      <main className="app-view-transition relative flex min-w-0 flex-1 flex-col overflow-hidden">
        <div aria-hidden className="drag-strip absolute inset-x-0 top-0 z-10 h-10" />
        <FloatingChrome
          showSidebar={navigation.panels.showSidebar}
          sidebarShortcut={shortcutLabel("toggleSidebar")}
          showStats={navigation.panels.showStats}
          showWorktrees={project.supportsWorktrees && navigation.panels.showWorktrees}
          showFileChanges={navigation.panels.showFileChanges}
          hasFileChanges={project.hasFileChanges}
          killing={chrome.killing}
          creatingSession={navigation.creatingSession}
          onNewSession={navigation.onStartNewSession}
          onDuplicateSession={navigation.handlers.handleDuplicateSession}
          onOpenTerminal={project.onOpenTerminal}
          onBackToMain={sessionView.onBackToMain}
          onShowWorkflows={sessionView.onShowWorkflows}
          workflowCount={sessionView.workflowCount}
          onToggleSidebar={navigation.panels.handleToggleSidebar}
          onToggleStats={navigation.panels.handleToggleStats}
          onToggleWorktrees={project.supportsWorktrees ? navigation.panels.handleToggleWorktrees : undefined}
          onToggleFileChanges={navigation.panels.handleToggleFileChanges}
          showConfig={state.mainView === "config"}
          onToggleConfig={can("configWrite") ? navigation.panels.handleToggleConfig : undefined}
          showMission={state.mainView === "mission"}
          onToggleMission={navigation.panels.handleToggleMission}
          onKillAll={chrome.onKillAll}
          onOpenSettings={config.openConfigDialog}
        />
        <DesktopMainView
          navigation={navigation}
          sessionView={sessionView}
          project={project}
        />
      </main>

      {/* HoverRevealPanel / PreviewPanel / ProjectFilesPanel unchanged */}
    </div>
  )
}
```

(`can` is already imported in this file.)

**Step 4: Slim `DesktopAppShell`**

Replace `src/components/AppShell/DesktopAppShell.tsx` with:

```tsx
import { ProviderUpdateBanner } from "@/components/ProviderUpdateBanner"
import { UpdateBanner } from "@/components/UpdateBanner"
import { useAppContext } from "@/contexts/AppContext"
import { DesktopOverlays } from "./DesktopOverlays"
import { DesktopWorkspace } from "./DesktopWorkspace"
import type { DesktopAppShellProps } from "./desktopTypes"

/** Desktop-only application composition: workspace and global overlays. */
export function DesktopAppShell({
  navigation,
  sessionView,
  project,
  chrome,
}: DesktopAppShellProps) {
  const { theme } = useAppContext()

  return (
    <div className={`${theme.themeClasses} flex h-dvh flex-col bg-background text-foreground`}>
      {chrome.backgroundServers}
      <UpdateBanner />
      <ProviderUpdateBanner />

      <DesktopWorkspace
        navigation={navigation}
        sessionView={sessionView}
        project={project}
        chrome={chrome}
      />

      <DesktopOverlays
        navigation={navigation}
        project={project}
        chrome={chrome}
      />
    </div>
  )
}
```

**Step 5: Delete the old header**

```bash
git rm src/components/DesktopHeader.tsx
grep -rn "DesktopHeader" src server electron --include='*.ts' --include='*.tsx'
```
Expected: no matches.

**Step 6: Tests and typecheck**

Run: `bunx vitest run src/components/AppShell src/components/__tests__/FloatingChrome.test.tsx && bun run typecheck:app && bun run typecheck:tests:app`
Expected: all PASS, zero type errors.

**Step 7: Commit**

```bash
git add -A src/components/AppShell src/components/DesktopHeader.tsx
git commit -m "feat: remove the desktop top bar"
```

---

### Task 7: Clear the pill row in the chat pane and dashboard

**Files:**
- Modify: `src/components/ChatArea.tsx:138`
- Modify: `src/components/StickyPromptBanner.tsx:152`
- Modify: `src/components/FindInSession.tsx:190`
- Modify: `src/components/timeline/TimelineMinimap.tsx:106`
- Modify: `src/components/Dashboard/ProjectsView.tsx:90`
- Modify: `src/components/Dashboard/SessionsView.tsx:125`
- Modify: `src/components/HoverRevealPanel.tsx:133`

No tests assert these class names (verified); this task is visual. Make each edit exactly:

1. `ChatArea.tsx`: `"mx-auto max-w-4xl px-6 pt-6"` → `"mx-auto max-w-4xl px-6 pt-14"`.
2. `StickyPromptBanner.tsx`: in the `className`, `top-2` → `top-12`.
3. `FindInSession.tsx`: `"motion-slide-down-in absolute right-4 top-0 z-30 flex items-center gap-1 rounded-b-lg border border-t-0 bg-popover p-2 text-popover-foreground shadow-sm"` → `"motion-slide-down-in absolute right-4 top-12 z-30 flex items-center gap-1 rounded-lg border bg-popover p-2 text-popover-foreground shadow-sm"`.
4. `TimelineMinimap.tsx`: `"justify-evenly overflow-y-auto py-6 pl-2"` → `"justify-evenly overflow-y-auto pb-6 pl-2 pt-14"`.
5. `ProjectsView.tsx` and `SessionsView.tsx`: `"mx-auto flex max-w-6xl flex-col gap-6 px-4 py-6 sm:px-6 sm:py-10"` → `"mx-auto flex max-w-6xl flex-col gap-6 px-4 py-6 sm:px-6 sm:pb-10 sm:pt-14"`.
6. `HoverRevealPanel.tsx`: `"absolute inset-y-0 z-40 bg-background shadow-sm"` → `"electron-no-drag absolute inset-y-0 z-40 bg-background shadow-sm"` (its header buttons sit inside the drag strip's band otherwise).

Run: `bunx vitest run src/components/__tests__/StickyPromptBanner.test.tsx src/components/timeline src/components/Dashboard src/components/__tests__/HoverRevealPanel.test.tsx`
Expected: PASS.

Commit:

```bash
git add src/components/ChatArea.tsx src/components/StickyPromptBanner.tsx src/components/FindInSession.tsx src/components/timeline/TimelineMinimap.tsx src/components/Dashboard/ProjectsView.tsx src/components/Dashboard/SessionsView.tsx src/components/HoverRevealPanel.tsx
git commit -m "style: keep chat and dashboard content clear of the floating pills"
```

---

### Task 8: Full verification and visual QA

**Step 1: Whole suite, lint, typecheck**

```bash
bun run test
bun run lint
bun run typecheck
```
Expected: 3932 + new tests passing, 0 lint errors, 0 type errors. Fix anything before moving on — unused imports left over from Tasks 3–6 show up here.

**Step 2: Visual QA in a browser**

Vite dev is blocked by CSP in a plain browser (see memory), so build and serve:

```bash
bun run build:web && bun run preview --port 4173
```

Use the `agent-browser` skill against `http://localhost:4173`. Check and screenshot:
- Dashboard: no bar; top-right shows bell + ⋯ pills; "Projects" heading clears the pills.
- Open a session: session pill top-left reads `project / name ● model NN%`; hover shows the details card; right-click opens the six-item menu; click flashes "Copied".
- Collapse the sidebar (⌘B or the sidebar's collapse button): "Show sidebar" pill appears at top-left; ⌘K still opens search.
- ⋯ menu: "Usage & cost…" opens the usage dialog; "Server monitor…" opens the monitor.
- Scroll a long session: first turn is not hidden under the pills; sticky prompt banner and Find (⌘F) appear below the pill row.
- Mission Control and Config: their headers sit below the pill row, no overlap with the right cluster.

Close the browser when done.

**Step 3: Electron drag check**

Run `bun run electron:dev` (or the project's Electron dev script from `package.json`) and confirm: the window drags from the empty strip above the transcript and from the sidebar header row; every pill and sidebar button is clickable; traffic lights do not overlap the home button or the "Show sidebar" pill.

**Step 4: Commit any QA fixes**

```bash
git add -A
git commit -m "fix: floating chrome QA adjustments"
```

Then report back with screenshots before merging — do not push or open a PR.
