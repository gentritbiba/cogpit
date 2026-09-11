import { describe, it, expect, vi } from "vitest"
import { render, screen } from "@testing-library/react"
import type { ReactNode } from "react"
import { SessionContextMenu } from "../SessionContextMenu"
import { ProjectContextMenu } from "../ProjectContextMenu"

// Render the menu content inline so items can be asserted without opening a
// context menu through pointer events.
vi.mock("@/components/ui/context-menu", () => ({
  ContextMenu: ({ children }: { children: ReactNode }) => <>{children}</>,
  ContextMenuTrigger: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  ContextMenuContent: ({ children }: { children: ReactNode }) => <div role="menu">{children}</div>,
  ContextMenuGroup: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  ContextMenuSeparator: () => <hr />,
  ContextMenuItem: ({ children, onClick, disabled }: { children: ReactNode; onClick?: () => void; disabled?: boolean }) => (
    <button type="button" role="menuitem" onClick={onClick} disabled={disabled}>{children}</button>
  ),
}))

describe("SessionContextMenu — archiving", () => {
  it("offers Archive for an idle session", () => {
    const onArchive = vi.fn()
    render(
      <SessionContextMenu sessionLabel="fix login" onArchive={onArchive}>
        <span>row</span>
      </SessionContextMenu>,
    )
    const item = screen.getByRole("menuitem", { name: "Archive session" })
    expect(item).toBeEnabled()
    item.click()
    expect(onArchive).toHaveBeenCalledOnce()
  })

  it("disables Archive while the session is running and says why", () => {
    render(
      <SessionContextMenu sessionLabel="fix login" onArchive={vi.fn()} archiveDisabled>
        <span>row</span>
      </SessionContextMenu>,
    )
    expect(screen.getByRole("menuitem", { name: "Archive (stop the session first)" })).toBeDisabled()
  })

  it("offers Restore instead of Archive for an archived session", () => {
    const onUnarchive = vi.fn()
    render(
      <SessionContextMenu sessionLabel="fix login" onArchive={vi.fn()} onUnarchive={onUnarchive}>
        <span>row</span>
      </SessionContextMenu>,
    )
    expect(screen.queryByRole("menuitem", { name: "Archive session" })).not.toBeInTheDocument()
    screen.getByRole("menuitem", { name: "Restore from archive" }).click()
    expect(onUnarchive).toHaveBeenCalledOnce()
  })
})

describe("ProjectContextMenu — archive idle sessions", () => {
  it("archives a project's idle sessions with the count in the label", () => {
    const onArchiveIdle = vi.fn()
    render(
      <ProjectContextMenu projectLabel="cogpit" onRename={vi.fn()} archivableCount={3} onArchiveIdle={onArchiveIdle}>
        <span>header</span>
      </ProjectContextMenu>,
    )
    const item = screen.getByRole("menuitem", { name: "Archive 3 idle sessions" })
    item.click()
    expect(onArchiveIdle).toHaveBeenCalledOnce()
  })

  it("is disabled when nothing in the project can be archived", () => {
    render(
      <ProjectContextMenu projectLabel="cogpit" onRename={vi.fn()} archivableCount={0} onArchiveIdle={vi.fn()}>
        <span>header</span>
      </ProjectContextMenu>,
    )
    expect(screen.getByRole("menuitem", { name: "Archive idle sessions" })).toBeDisabled()
  })

  it("omits the item when archiving is not wired", () => {
    render(
      <ProjectContextMenu projectLabel="cogpit" onRename={vi.fn()}>
        <span>header</span>
      </ProjectContextMenu>,
    )
    expect(screen.queryByRole("menuitem", { name: /Archive/ })).not.toBeInTheDocument()
  })
})
