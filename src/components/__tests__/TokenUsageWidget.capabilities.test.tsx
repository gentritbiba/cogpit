import { render, screen } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("@/lib/auth", () => ({ authFetch: vi.fn() }))

import { authFetch } from "@/lib/auth"
import { __resetCapabilitiesForTest, setMe } from "@/lib/capabilities"
import { TokenUsageIndicator } from "@/components/TokenUsageWidget"
import { MEMBER_CAPABILITIES } from "../../../shared/contracts/team"

describe("TokenUsageIndicator capabilities", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    __resetCapabilitiesForTest()
  })

  afterEach(() => {
    __resetCapabilitiesForTest()
    vi.restoreAllMocks()
  })

  it("renders no usage affordance and starts no provider requests or polling for members", async () => {
    setMe({
      authenticated: true,
      edition: "team",
      user: { id: "member-1", username: "bob", displayName: "Bob", role: "member", createdAt: 1 },
      capabilities: MEMBER_CAPABILITIES,
    })
    const intervalSpy = vi.spyOn(globalThis, "setInterval")

    render(<TokenUsageIndicator agentKind="codex" />)
    await Promise.resolve()

    expect(vi.mocked(authFetch)).not.toHaveBeenCalled()
    expect(intervalSpy).not.toHaveBeenCalled()
    expect(screen.queryByRole("button", { name: /usage/i })).not.toBeInTheDocument()
  })
})
