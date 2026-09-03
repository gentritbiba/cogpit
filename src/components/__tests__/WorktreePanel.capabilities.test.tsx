import type { ReactNode } from "react"
import { render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, describe, expect, it, vi } from "vitest"

import { __resetCapabilitiesForTest, setMe } from "@/lib/capabilities"
import { MEMBER_CAPABILITIES } from "../../../shared/contracts/team"
import { WorktreePanel } from "../WorktreePanel"

const mocks = vi.hoisted(() => ({ authFetch: vi.fn() }))
vi.mock("@/lib/auth", () => ({ authFetch: mocks.authFetch }))
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
      onClose={vi.fn()}
    />)

    expect(screen.getByText("feature")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Open session" })).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "Cleanup stale worktrees" })).not.toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "Create PR" })).not.toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "Delete worktree" })).not.toBeInTheDocument()
    expect(mocks.authFetch).not.toHaveBeenCalled()
  })

  it("keeps dirty and unpushed safeguards in sequence before deletion", async () => {
    const user = userEvent.setup()
    const onRefetch = vi.fn()
    mocks.authFetch.mockResolvedValue({ ok: true })

    render(<WorktreePanel
      worktrees={[{
        name: "feature",
        path: "/srv/project/.claude/worktrees/feature",
        branch: "worktree-feature",
        head: "abc1234",
        headMessage: "Feature work",
        isDirty: true,
        commitsAhead: 2,
        linkedSessions: [],
        createdAt: "2026-08-10T00:00:00.000Z",
        changedFiles: [],
      }]}
      loading={false}
      dirName="project"
      onRefetch={onRefetch}
      onOpenSession={vi.fn()}
      onClose={vi.fn()}
    />)

    await user.click(screen.getByRole("button", { name: "Delete worktree" }))
    let dialog = await screen.findByRole("alertdialog")
    expect(within(dialog).getByText("Delete worktree with uncommitted changes?")).toBeInTheDocument()
    expect(mocks.authFetch).not.toHaveBeenCalled()

    await user.click(within(dialog).getByRole("button", { name: "Continue" }))
    dialog = await screen.findByRole("alertdialog")
    expect(within(dialog).getByText("Delete worktree with unpushed commits?")).toBeInTheDocument()
    expect(mocks.authFetch).not.toHaveBeenCalled()

    await user.click(within(dialog).getByRole("button", { name: "Delete worktree" }))
    await waitFor(() => {
      expect(mocks.authFetch).toHaveBeenCalledWith(
        "/api/worktrees/project/feature",
        expect.objectContaining({
          method: "DELETE",
          body: JSON.stringify({ force: true }),
        }),
      )
    })
    expect(onRefetch).toHaveBeenCalledOnce()
  })
})
