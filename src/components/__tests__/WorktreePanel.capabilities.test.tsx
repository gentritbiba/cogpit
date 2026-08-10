import type { ReactNode } from "react"
import { render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

import { __resetCapabilitiesForTest, setMe } from "@/lib/capabilities"
import { MEMBER_CAPABILITIES } from "../../../shared/contracts/team"
import { WorktreePanel } from "../WorktreePanel"

const mocks = vi.hoisted(() => ({ authFetch: vi.fn() }))
vi.mock("@/lib/auth", () => ({ authFetch: mocks.authFetch }))
vi.mock("@/components/ui/sheet", () => ({
  Sheet: ({ children, open }: { children: ReactNode; open: boolean }) => open ? <div>{children}</div> : null,
  SheetContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  SheetHeader: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  SheetTitle: ({ children }: { children: ReactNode }) => <h2>{children}</h2>,
}))
vi.mock("@/components/ui/collapsible", () => ({
  Collapsible: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  CollapsibleTrigger: ({ children }: { children: ReactNode }) => <button>{children}</button>,
  CollapsibleContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}))

afterEach(() => {
  mocks.authFetch.mockReset()
  __resetCapabilitiesForTest()
})

describe("WorktreePanel capability gating", () => {
  it("keeps member worktree listing useful without mutation actions", () => {
    setMe({
      authenticated: true,
      edition: "team",
      user: { id: "u_member", username: "member", displayName: "Member", role: "member", createdAt: 1 },
      capabilities: MEMBER_CAPABILITIES,
    })

    render(<WorktreePanel
      open
      onOpenChange={vi.fn()}
      worktrees={[{
        name: "feature",
        path: "/srv/project/.claude/worktrees/feature",
        branch: "worktree-feature",
        head: "abc1234",
        headMessage: "Feature work",
        isDirty: false,
        commitsAhead: 1,
        linkedSessions: ["session-1"],
        createdAt: "2026-08-10T00:00:00.000Z",
        changedFiles: [],
      }]}
      loading={false}
      dirName="project"
      onRefetch={vi.fn()}
      onOpenSession={vi.fn()}
    />)

    expect(screen.getByText("feature")).toBeInTheDocument()
    expect(screen.getByTitle("Open session")).toBeInTheDocument()
    expect(screen.queryByTitle("Cleanup stale worktrees")).not.toBeInTheDocument()
    expect(screen.queryByTitle("Create PR")).not.toBeInTheDocument()
    expect(screen.queryByTitle("Delete worktree")).not.toBeInTheDocument()
    expect(mocks.authFetch).not.toHaveBeenCalled()
  })
})
