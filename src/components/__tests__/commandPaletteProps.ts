import { vi } from "vitest"

/**
 * Baseline props for the command palette, with every action wired to a spy.
 *
 * `CommandPaletteHost` renders the same palette — its props are
 * `Omit<CommandPaletteProps, …>` plus a few of its own — so both suites build
 * on this object instead of restating it and drifting apart.
 */
export function createCommandPaletteProps() {
  return {
    open: true,
    onOpenChange: vi.fn(),
    onGoHome: vi.fn(),
    onNewSession: vi.fn(),
    onToggleSidebar: vi.fn(),
    onToggleStats: vi.fn(),
    onToggleFileChanges: vi.fn(),
    onToggleWorktrees: vi.fn(),
    onToggleMissionControl: vi.fn(),
    onOpenConfig: vi.fn(),
    onOpenSettings: vi.fn(),
    onOpenTheme: vi.fn(),
    onOpenTerminal: vi.fn(),
    onFocusComposer: vi.fn(),
    onExpandAll: vi.fn(),
    onCollapseAll: vi.fn(),
    canFocusComposer: true,
    canOpenTerminal: true,
    hasSession: true,
    hasFileChanges: true,
    supportsWorktrees: true,
    showSidebar: true,
    showStats: false,
    showFileChanges: true,
    showWorktrees: false,
    showConfig: false,
    showMission: false,
  }
}
