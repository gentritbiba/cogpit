import { describe, expect, it, vi } from "vitest"
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { MobileSessionInfoBar } from "../SessionInfoBar.mobile"
import { computeSessionDigest, type SessionView } from "../../../shared/session/sessionDigest"
import type { RawMessage } from "../../../shared/session/types"

vi.mock("../DeviceSwitcher", () => ({ DeviceSwitcher: () => null }))
vi.mock("@/hooks/useSessionArchive", () => ({ useSessionArchiveToggle: () => null }))

type BarProps = Partial<Parameters<typeof MobileSessionInfoBar>[0]>

function header(isLive: boolean, props: BarProps = {}) {
  return <MobileSessionInfoBar session={{ sessionId: "s1", cwd: "/work/cogpit", turns: [] } as unknown as SessionView} sessionSource={null} isSubAgentView={false} isLive={isLive} canArchive={false} contextUsage={null} creatingSession={false} onNewSession={vi.fn()} {...props} />
}

/** opus-4-5 is a 200k model: 65k used of the 167k usable leaves 61%. */
const healthyUsage = computeSessionDigest([{
  type: "assistant",
  message: { model: "claude-opus-4-5", usage: { input_tokens: 50_000, output_tokens: 1_000, cache_creation_input_tokens: 10_000, cache_read_input_tokens: 5_000 } },
} as RawMessage]).contextUsage

describe("MobileSessionInfoBar", () => {
  it("shows the live dot in the header, where desktop shows it", () => {
    const { rerender } = render(header(true))
    expect(screen.getByText("cogpit")).toBeInTheDocument()
    expect(screen.getByLabelText("Session is live")).toBeInTheDocument()

    rerender(header(false))
    expect(screen.queryByLabelText("Session is live")).not.toBeInTheDocument()
  })

  it("keeps the context left in view while there is plenty of it", () => {
    render(header(false, { contextUsage: healthyUsage }))
    expect(screen.getByLabelText("61% of context left")).toBeInTheDocument()
  })

  it("offers Stop session in the session menu when there is a process to stop", async () => {
    const user = userEvent.setup()
    const onStopSession = vi.fn()
    render(header(true, { onStopSession }))

    await user.click(screen.getByRole("button", { name: "Session actions" }))
    await user.click(await screen.findByRole("menuitem", { name: "Stop session" }))

    expect(onStopSession).toHaveBeenCalledOnce()
  })

  it("has no Stop session without a process to stop", async () => {
    const user = userEvent.setup()
    render(header(false))

    await user.click(screen.getByRole("button", { name: "Session actions" }))

    expect(await screen.findByRole("menu")).toBeInTheDocument()
    expect(screen.queryByRole("menuitem", { name: "Stop session" })).not.toBeInTheDocument()
  })
})
