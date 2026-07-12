import { act, renderHook } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("@/lib/auth", () => ({
  authFetch: vi.fn(),
}))

import { authFetch } from "@/lib/auth"
import { mapClaudeRuntimeResponse, mapCodexRuntimeResponse, useTokenUsage } from "../useTokenUsage"

const mockedAuthFetch = vi.mocked(authFetch)

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

function jsonResponse(data: Record<string, unknown>): Response {
  return {
    ok: true,
    status: 200,
    json: async () => data,
  } as Response
}

describe("mapCodexRuntimeResponse", () => {
  it("maps native rate-limit windows, plan, credits, and token history", () => {
    const usage = mapCodexRuntimeResponse({
      available: true,
      account: { account: { type: "chatgpt", planType: "plus" } },
      usage: { summary: { lifetimeTokens: 1_234_567 } },
      rateLimits: {
        rateLimits: {
          planType: "plus",
          primary: { usedPercent: 42, windowDurationMins: 300, resetsAt: 1_800_000_000 },
          secondary: { usedPercent: 17, windowDurationMins: 10_080, resetsAt: 1_800_086_400 },
          credits: { hasCredits: true, unlimited: false, balance: "25.5" },
        },
      },
    })

    expect(usage).toMatchObject({
      providerName: "Codex",
      subscriptionType: "plus",
      lifetimeTokens: 1_234_567,
      creditBalance: "25.5",
      fiveHour: { utilization: 42, label: "5-hour" },
      sevenDay: { utilization: 17, label: "7-day" },
    })
    expect(usage?.fiveHour?.resetsAt).toBe("2027-01-15T08:00:00.000Z")
  })

  it("returns null when Codex is unavailable or has no usage information", () => {
    expect(mapCodexRuntimeResponse({ available: false })).toBeNull()
    expect(mapCodexRuntimeResponse({ available: true })).toBeNull()
  })
})

describe("mapClaudeRuntimeResponse", () => {
  it("maps SDK-backed plan windows and account information", () => {
    expect(mapClaudeRuntimeResponse({
      available: true,
      account: { subscriptionType: "max" },
      usage: {
        rate_limits: {
          five_hour: { utilization: 31, resets_at: "2027-01-01T00:00:00Z" },
          seven_day: { utilization: 12 },
          extra_usage: { is_enabled: true, monthly_limit: 100, used_credits: 8 },
        },
      },
    })).toMatchObject({
      providerName: "Claude",
      subscriptionType: "max",
      fiveHour: { utilization: 31 },
      sevenDay: { utilization: 12 },
      extraUsage: { isEnabled: true, monthlyLimit: 100, usedCredits: 8 },
    })
  })
})

describe("useTokenUsage", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("ignores a stale provider response after the selected agent changes", async () => {
    const claudeResponse = deferred<Response>()
    const codexResponse = deferred<Response>()

    mockedAuthFetch.mockImplementation((input) => {
      return String(input) === "/api/claude/runtime" ? claudeResponse.promise : codexResponse.promise
    })

    const { result, rerender } = renderHook(
      ({ agentKind }) => useTokenUsage(agentKind),
      { initialProps: { agentKind: "claude" as "claude" | "codex" } },
    )

    await vi.waitFor(() => {
      expect(mockedAuthFetch).toHaveBeenCalledWith(
        "/api/claude/runtime",
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      )
    })
    const claudeSignal = mockedAuthFetch.mock.calls[0][1]?.signal

    rerender({ agentKind: "codex" })

    await vi.waitFor(() => {
      expect(mockedAuthFetch).toHaveBeenCalledWith(
        "/api/codex/runtime",
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      )
    })
    expect(claudeSignal?.aborted).toBe(true)

    await act(async () => {
      codexResponse.resolve(jsonResponse({
        available: true,
        rateLimits: {
          rateLimits: {
            primary: { usedPercent: 12, windowDurationMins: 300 },
          },
        },
      }))
    })

    await vi.waitFor(() => {
      expect(result.current.usage?.providerName).toBe("Codex")
    })

    await act(async () => {
      claudeResponse.resolve(jsonResponse({
        available: true,
        usage: { rate_limits: { five_hour: { utilization: 99 } } },
      }))
      await Promise.resolve()
    })

    expect(result.current.usage?.providerName).toBe("Codex")
    expect(result.current.usage?.fiveHour?.utilization).toBe(12)
  })
})
