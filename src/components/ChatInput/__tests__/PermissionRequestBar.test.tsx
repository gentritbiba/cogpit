import { afterEach, describe, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { PermissionRequestBar } from "../PermissionRequestBar"
import type { PermissionRequest } from "@/hooks/usePermissionRequests"

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

function request(
  overrides: Partial<PermissionRequest> = {},
): PermissionRequest {
  return {
    requestId: "approval-1",
    toolName: "Bash",
    input: { command: "bun test" },
    toolUseId: "item-1",
    timestamp: 1,
    availableDecisions: ["allow", "allow_always", "deny"],
    ...overrides,
  }
}

describe("PermissionRequestBar", () => {
  it("only renders and shortcuts decisions offered by the request", () => {
    const onRespond = vi.fn()
    render(
      <PermissionRequestBar
        requests={[request({ availableDecisions: ["allow", "deny"] })]}
        responding={new Set()}
        onRespond={onRespond}
        onRespondAll={vi.fn()}
      />,
    )

    expect(screen.getByRole("button", { name: /Deny/ })).toBeInTheDocument()
    expect(screen.getByRole("button", { name: /^AllowA$/ })).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: /Session/ })).not.toBeInTheDocument()

    fireEvent.keyDown(window, { key: "s" })
    expect(onRespond).not.toHaveBeenCalled()
    fireEvent.keyDown(window, { key: "a" })
    expect(onRespond).toHaveBeenCalledWith("approval-1", "allow")
  })

  it("only offers allow-all when every pending request supports one-time allow", () => {
    const { rerender } = render(
      <PermissionRequestBar
        requests={[
          request(),
          request({
            requestId: "approval-2",
            availableDecisions: ["allow_always", "deny"],
          }),
        ]}
        responding={new Set()}
        onRespond={vi.fn()}
        onRespondAll={vi.fn()}
      />,
    )

    expect(screen.queryByRole("button", { name: /Allow all/ })).not.toBeInTheDocument()

    rerender(
      <PermissionRequestBar
        requests={[request(), request({ requestId: "approval-2" })]}
        responding={new Set()}
        onRespond={vi.fn()}
        onRespondAll={vi.fn()}
      />,
    )
    expect(screen.getByRole("button", { name: /Allow all/ })).toBeInTheDocument()
  })

  it("explains when the protocol only offers decisions Cogpit cannot express", () => {
    render(
      <PermissionRequestBar
        requests={[request({ availableDecisions: [] })]}
        responding={new Set()}
        onRespond={vi.fn()}
        onRespondAll={vi.fn()}
      />,
    )

    expect(screen.getByText("Resolve this approval in Codex")).toBeInTheDocument()
    expect(screen.queryAllByRole("button")).toHaveLength(0)
  })
})
