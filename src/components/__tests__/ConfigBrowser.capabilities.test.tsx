import type { ReactNode } from "react"
import { act, render, screen, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { __resetCapabilitiesForTest, setMe } from "@/lib/capabilities"
import { MEMBER_CAPABILITIES } from "../../../shared/contracts/team"
import { ConfigBrowser } from "../ConfigBrowser"

const mocks = vi.hoisted(() => ({ authFetch: vi.fn() }))

vi.mock("@/lib/auth", () => ({ authFetch: mocks.authFetch }))
vi.mock("@/components/ui/scroll-area", () => ({
  ScrollArea: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}))
vi.mock("@/components/config/CategorySection", () => ({
  CategorySection: (props: {
    items: Array<{ name: string }>
    onSelect: (item: never) => void
    onNewFile?: () => void
    onDeleteItem?: () => void
    onRenameItem?: () => void
  }) => (
    <div>
      {props.items[0] && (
        <button onClick={() => props.onSelect(props.items[0] as never)}>Open {props.items[0].name}</button>
      )}
      {props.onNewFile && <button>New config</button>}
      {props.onDeleteItem && <button>Delete config</button>}
      {props.onRenameItem && <button>Rename config</button>}
    </div>
  ),
}))
vi.mock("@/components/config/ConfigEditor", () => ({
  ConfigEditor: ({ readOnly }: { readOnly?: boolean }) => (
    <div data-testid="config-editor-mode">{readOnly ? "read-only" : "editable"}</div>
  ),
}))
vi.mock("@/components/config/EmptyState", () => ({ EmptyState: () => <div>Empty</div> }))

describe("ConfigBrowser capability gating", () => {
  beforeEach(() => {
    __resetCapabilitiesForTest()
    mocks.authFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        sections: [{
          label: "Global",
          scope: "global",
          baseDir: "/home/member/.claude",
          items: [{
            name: "example.md",
            path: "/home/member/.claude/commands/example.md",
            type: "file",
            fileType: "command",
          }],
        }],
      }),
    })
  })

  afterEach(() => __resetCapabilitiesForTest())

  it("does not fetch or expose raw configuration to members", async () => {
    setMe({
      authenticated: true,
      edition: "team",
      user: { id: "u_member", username: "member", displayName: "Member", role: "member", createdAt: 1 },
      capabilities: MEMBER_CAPABILITIES,
    })

    render(<ConfigBrowser projectPath={null} />)
    expect(await screen.findByText("Server configuration is available to administrators only.")).toBeInTheDocument()
    expect(mocks.authFetch).not.toHaveBeenCalled()
    expect(screen.queryByRole("button", { name: "New config" })).not.toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "Rename config" })).not.toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "Delete config" })).not.toBeInTheDocument()
  })

  it("reacts to a capability downgrade through the memo boundary", async () => {
    render(<ConfigBrowser projectPath={null} />)
    expect(await screen.findAllByRole("button", { name: "New config" })).not.toHaveLength(0)
    const initialFetchCount = mocks.authFetch.mock.calls.length

    await act(async () => {
      setMe({
        authenticated: true,
        edition: "team",
        user: { id: "u_member", username: "member", displayName: "Member", role: "member", createdAt: 1 },
        capabilities: MEMBER_CAPABILITIES,
      })
    })

    await waitFor(() => {
      expect(screen.getByText("Server configuration is available to administrators only.")).toBeInTheDocument()
      expect(screen.queryAllByRole("button", { name: "New config" })).toHaveLength(0)
      expect(screen.queryAllByRole("button", { name: "Rename config" })).toHaveLength(0)
      expect(screen.queryAllByRole("button", { name: "Delete config" })).toHaveLength(0)
    })
    expect(mocks.authFetch).toHaveBeenCalledTimes(initialFetchCount)
  })
})
