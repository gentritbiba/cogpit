import type { ReactNode } from "react"
import { act, render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
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
    onDeleteItem?: (item: never) => void
    onRenameItem?: () => void
  }) => (
    <div>
      {props.items[0] && (
        <>
          <button onClick={() => props.onSelect(props.items[0] as never)}>Open {props.items[0].name}</button>
          {props.onDeleteItem && (
            <button onClick={() => props.onDeleteItem?.(props.items[0] as never)}>Delete config</button>
          )}
          {props.onRenameItem && <button>Rename config</button>}
        </>
      )}
      {props.onNewFile && <button>New config</button>}
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

  it("confirms before deleting a configuration file", async () => {
    const user = userEvent.setup()
    render(<ConfigBrowser projectPath={null} />)

    await user.click(await screen.findByRole("button", { name: "Delete config" }))
    const dialog = await screen.findByRole("alertdialog", { name: "Delete configuration file?" })
    expect(within(dialog).getByText(/example\.md/)).toBeInTheDocument()
    expect(mocks.authFetch.mock.calls.some(([, init]) => (init as RequestInit | undefined)?.method === "DELETE")).toBe(false)

    await user.click(within(dialog).getByRole("button", { name: "Delete file" }))
    await waitFor(() => {
      expect(mocks.authFetch).toHaveBeenCalledWith(
        "/api/config-browser/file?path=%2Fhome%2Fmember%2F.claude%2Fcommands%2Fexample.md",
        { method: "DELETE" },
      )
    })
  })
})
