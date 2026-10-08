import { describe, expect, it, vi } from "vitest"
import { render, screen } from "@testing-library/react"
import { MobileSessionInfoBar } from "../SessionInfoBar.mobile"
import type { ParsedSession } from "../../../shared/session/types"

vi.mock("../DeviceSwitcher", () => ({ DeviceSwitcher: () => null }))
vi.mock("@/hooks/useSessionArchive", () => ({ useSessionArchiveToggle: () => null }))

function header(isLive: boolean) {
  return <MobileSessionInfoBar session={{ sessionId: "s1", cwd: "/work/cogpit", turns: [] } as unknown as ParsedSession} sessionSource={null} isSubAgentView={false} isLive={isLive} canArchive={false} claudeRawMessages={[]} creatingSession={false} onNewSession={vi.fn()} />
}

describe("MobileSessionInfoBar", () => {
  it("shows the live dot in the header, where desktop shows it", () => {
    const { rerender } = render(header(true))
    expect(screen.getByText("cogpit")).toBeInTheDocument()
    expect(screen.getByLabelText("Session is live")).toBeInTheDocument()

    rerender(header(false))
    expect(screen.queryByLabelText("Session is live")).not.toBeInTheDocument()
  })
})
