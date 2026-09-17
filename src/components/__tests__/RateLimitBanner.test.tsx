import { fireEvent, render, screen } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { RateLimitBlock } from "../../../shared/session/rateLimit"

const { mockOpenProjectTerminal, mockIsRemoteDeviceActive } = vi.hoisted(() => ({
  mockOpenProjectTerminal: vi.fn(),
  mockIsRemoteDeviceActive: vi.fn(),
}))
vi.mock("@/lib/openTerminal", () => ({ openProjectTerminal: mockOpenProjectTerminal }))
vi.mock("@/lib/device", () => ({ isRemoteDeviceActive: mockIsRemoteDeviceActive }))

const { RateLimitBanner } = await import("@/components/RateLimitBanner")

const SESSION = "11111111-2222-3333-4444-555555555555"
const CLAUDE_DIR = "-work-app"

const blocked: RateLimitBlock = { limit: "five_hour", resetsAt: 1_760_000_000, lowPriority: true }
const weekly: RateLimitBlock = { limit: "seven_day", resetsAt: 1_760_500_000, lowPriority: false }

function renderBanner(block: RateLimitBlock, dirName = CLAUDE_DIR) {
  return render(
    <RateLimitBanner
      block={block}
      dirName={dirName}
      fileName={`${SESSION}.jsonl`}
      cwd="/work/app"
    />,
  )
}

describe("RateLimitBanner", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockOpenProjectTerminal.mockReturnValue(true)
    mockIsRemoteDeviceActive.mockReturnValue(false)
  })

  it("names the agent and when the allowance returns", () => {
    renderBanner(blocked)
    expect(screen.getByRole("status")).toHaveTextContent(/Claude Code/)
    expect(screen.getByRole("status")).toHaveTextContent(/Resets/)
  })

  /**
   * The hand-off is the whole point of the banner: lower priority is reachable
   * only from the CLI's own terminal, so the button has to launch that CLI on
   * this exact session rather than anything Cogpit can do in-app.
   */
  it("hands the session to a terminal running the agent's own resume command", () => {
    renderBanner(blocked)
    fireEvent.click(screen.getByRole("button", { name: /terminal/i }))

    expect(mockOpenProjectTerminal).toHaveBeenCalledWith({
      path: "/work/app",
      dirName: CLAUDE_DIR,
      command: `claude --resume ${SESSION}`,
    })
  })

  it("says the mode spends the weekly allowance", () => {
    renderBanner(blocked)
    expect(screen.getByRole("status")).toHaveTextContent(/weekly/i)
  })

  /**
   * Lower priority spends the weekly allowance to get past the session one, so
   * on a weekly rejection the terminal would refuse too. Offering the button
   * there would be sending the user nowhere.
   */
  it("offers no hand-off when lower priority cannot help", () => {
    renderBanner(weekly)
    expect(screen.queryByRole("button", { name: /terminal/i })).toBeNull()
    expect(screen.getByRole("status")).toHaveTextContent(/Resets/)
  })

  it("still explains the block when the runtime named no reset time", () => {
    renderBanner({ limit: "five_hour", resetsAt: null, lowPriority: true })
    expect(screen.getByRole("status")).toHaveTextContent(/limit/i)
    expect(screen.getByRole("status")).not.toHaveTextContent(/Invalid Date/)
  })

  /**
   * A remote device cannot open a window on the machine running the session, so
   * the button would do nothing there. The command itself still has to be
   * readable — copying it is the only way through from a phone.
   */
  it("shows the command but no button while a remote device is active", () => {
    mockIsRemoteDeviceActive.mockReturnValue(true)
    renderBanner(blocked)

    expect(screen.queryByRole("button", { name: /terminal/i })).toBeNull()
    expect(screen.getByRole("status")).toHaveTextContent(`claude --resume ${SESSION}`)
  })

  /**
   * The server reads the same capability before publishing, so a true flag on
   * an agent without the mode should be impossible — but the promise in this
   * copy is only true if the mode exists, so the component checks too.
   */
  it("refuses to promise a hand-off an agent's CLI cannot honour", () => {
    renderBanner({ ...blocked, lowPriority: true }, "codex__-work-app")
    expect(screen.queryByRole("button", { name: /terminal/i })).toBeNull()
    expect(screen.getByRole("status")).not.toHaveTextContent(/lower priority/i)
  })
})
