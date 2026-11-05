import { act, cleanup, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("@/lib/auth", () => ({ authFetch: vi.fn() }))

import { authFetch } from "@/lib/auth"
import { __resetCapabilitiesForTest } from "@/lib/capabilities"
import { formatMinorUnits } from "@/lib/localCommandReports"
import { TokenUsageIndicator } from "@/components/TokenUsageWidget"

const usd = (minor: number) => formatMinorUnits(minor, "USD")

function claudeRuntime(rateLimits: Record<string, unknown>, subscriptionType: string | null = null) {
  vi.mocked(authFetch).mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => ({
      available: true,
      account: subscriptionType ? { subscriptionType } : {},
      usage: { subscription_type: subscriptionType, rate_limits: rateLimits },
    }),
  } as Response)
}

async function openTooltip(button: HTMLElement): Promise<HTMLElement> {
  await userEvent.setup().hover(button)
  return waitFor(() => {
    const popup = document.querySelector<HTMLElement>('[data-slot="tooltip-content"]')
    if (!popup) throw new Error("tooltip did not open")
    return popup
  })
}

describe("TokenUsageIndicator", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    __resetCapabilitiesForTest()
  })

  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  it("shows credits spent for an account without plan windows, with the limit on hover", async () => {
    claudeRuntime({
      five_hour: null,
      seven_day: null,
      extra_usage: { is_enabled: true, used_credits: 1240, monthly_limit: 5000, utilization: 24.8, currency: "USD" },
    })

    render(<TokenUsageIndicator agentKind="claude" />)
    const button = await screen.findByRole("button", { name: /usage/i })
    expect(button).toHaveTextContent(usd(1240))
    expect(button).not.toHaveTextContent("%")

    const tooltip = await openTooltip(button)
    expect(tooltip).toHaveTextContent(`${usd(1240)} spent`)
    expect(tooltip).toHaveTextContent(`${usd(5000)} monthly limit`)
    expect(tooltip).toHaveTextContent("24.8% used")
  })

  it("says when the credits have no monthly limit", async () => {
    claudeRuntime({
      extra_usage: { is_enabled: true, used_credits: 300, monthly_limit: null, utilization: null },
    })

    render(<TokenUsageIndicator agentKind="claude" />)
    const button = await screen.findByRole("button", { name: /usage/i })
    expect(button).toHaveTextContent(usd(300))

    const tooltip = await openTooltip(button)
    expect(tooltip).toHaveTextContent("No monthly limit")
    expect(tooltip).not.toHaveTextContent("% used")
  })

  it("keeps the plan percentage for subscribers and lists their credits in minor units", async () => {
    claudeRuntime({
      seven_day: { utilization: 74, resets_at: null },
      extra_usage: { is_enabled: true, used_credits: 850, monthly_limit: 2000, utilization: 42.5 },
    }, "max")

    render(<TokenUsageIndicator agentKind="claude" />)
    const button = await screen.findByRole("button", { name: /usage/i })
    expect(button).toHaveTextContent("74%")

    const tooltip = await openTooltip(button)
    expect(tooltip).toHaveTextContent(`${usd(850)} spent`)
    expect(tooltip).toHaveTextContent(`${usd(2000)} monthly limit`)
  })

  it("renders nothing for an account with neither plan windows nor credits", async () => {
    claudeRuntime({ extra_usage: { is_enabled: false, used_credits: null, monthly_limit: null } })

    render(<TokenUsageIndicator agentKind="claude" />)
    await waitFor(() => expect(authFetch).toHaveBeenCalled())
    await act(async () => {})
    expect(screen.queryByRole("button", { name: /usage/i })).not.toBeInTheDocument()
  })
})
