import { fireEvent, render, screen } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { SessionUsageCostSummary } from "../../../../shared/contracts/usageCost"

const mocks = vi.hoisted(() => ({
  useSessionUsageCost: vi.fn(),
}))

vi.mock("@/hooks/useSessionUsageCost", () => ({
  useSessionUsageCost: mocks.useSessionUsageCost,
}))

import { SessionCostPanel } from "../SessionCostPanel"

const summary: SessionUsageCostSummary = {
  provider: "codex",
  sessionId: "session-1",
  totals: {
    uncachedInputTokens: 1_000,
    cachedInputTokens: 12_000,
    cacheCreationTokens: 0,
    cacheCreation1hTokens: 0,
    outputTokens: 2_000,
    reasoningTokens: 750,
  },
  costUsd: 1.234,
  cacheSavingsUsd: 2.5,
  breakdown: {
    uncachedInputUsd: 0.2,
    cachedInputUsd: 0.034,
    cacheCreationUsd: 0,
    outputUsd: 1,
    unallocatedUsd: 0,
  },
  models: [{
    model: "gpt-5.6-sol",
    totals: {
      uncachedInputTokens: 1_000,
      cachedInputTokens: 12_000,
      cacheCreationTokens: 0,
      cacheCreation1hTokens: 0,
      outputTokens: 2_000,
      reasoningTokens: 750,
    },
    costUsd: 1.234,
    cacheSavingsUsd: 2.5,
    costSource: "modelPriced",
    records: 2,
  }],
  calls: [
    {
      timestamp: "2026-09-04T10:00:00.000Z",
      model: "gpt-5.6-sol",
      totals: {
        uncachedInputTokens: 500,
        cachedInputTokens: 6_000,
        cacheCreationTokens: 0,
        cacheCreation1hTokens: 0,
        outputTokens: 500,
        reasoningTokens: 100,
      },
      costUsd: 0.3,
      costSource: "modelPriced",
      isSubagent: false,
    },
    {
      timestamp: "2026-09-04T10:01:00.000Z",
      model: "gpt-5.6-sol",
      totals: {
        uncachedInputTokens: 500,
        cachedInputTokens: 6_000,
        cacheCreationTokens: 0,
        cacheCreation1hTokens: 0,
        outputTokens: 1_500,
        reasoningTokens: 650,
      },
      costUsd: 0.934,
      costSource: "modelPriced",
      isSubagent: true,
    },
  ],
  records: 2,
  providerReportedRecords: 0,
  modelPricedRecords: 2,
  unpricedRecords: 0,
  includedFiles: 2,
  includedSubagents: 1,
  pricing: { status: "fresh", knownModels: 300, fetchedAt: "2026-09-04T09:00:00.000Z" },
  scanDurationMs: 4,
}

describe("SessionCostPanel", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.useSessionUsageCost.mockReturnValue({
      summary,
      loading: false,
      error: null,
      refresh: vi.fn(),
    })
  })

  it("shows a readable, reconciled session cost report", () => {
    render(<SessionCostPanel dirName="project" fileName="session.jsonl" revision="1" />)

    expect(screen.getByText("API equivalent")).toBeInTheDocument()
    expect(screen.getByText("Codex")).toBeInTheDocument()
    expect(screen.getAllByText("$1.23").length).toBeGreaterThan(0)
    expect(screen.getByText("15.0k")).toBeInTheDocument()
    expect(screen.getByText("$2.50")).toBeInTheDocument()
    expect(screen.getByText("New input")).toBeInTheDocument()
    expect(screen.getByText("Cache reads")).toBeInTheDocument()
    expect(screen.getByText("Output")).toBeInTheDocument()
    expect(screen.getByText("GPT-5.6 Sol")).toBeInTheDocument()
    expect(screen.getByText("Agent")).toBeInTheDocument()
    expect(screen.getByText(/not a subscription bill/i)).toBeInTheDocument()
  })

  it("keeps unpriced token usage visible without inventing a dollar value", () => {
    mocks.useSessionUsageCost.mockReturnValue({
      summary: {
        ...summary,
        costUsd: 0,
        models: [{ ...summary.models[0], costUsd: 0, costSource: "unpriced" }],
        calls: [{ ...summary.calls[0], costUsd: 0, costSource: "unpriced" }],
        providerReportedRecords: 0,
        modelPricedRecords: 0,
        unpricedRecords: 1,
        records: 1,
      },
      loading: false,
      error: null,
      refresh: vi.fn(),
    })

    render(<SessionCostPanel dirName="project" fileName="session.jsonl" revision="1" />)

    expect(screen.getByText("Rates unavailable")).toBeInTheDocument()
    expect(screen.getAllByText("—").length).toBeGreaterThan(0)
    expect(screen.getByText("Unpriced")).toBeInTheDocument()
    expect(screen.getByText("15.0k")).toBeInTheDocument()
  })

  it("offers a retry after a scan error", () => {
    const refresh = vi.fn()
    mocks.useSessionUsageCost.mockReturnValue({
      summary: null,
      loading: false,
      error: "Cost scan failed (500)",
      refresh,
    })

    render(<SessionCostPanel dirName="project" fileName="session.jsonl" revision="1" />)
    fireEvent.click(screen.getByRole("button", { name: "Retry" }))

    expect(screen.getByText("Cost scan failed (500)")).toBeInTheDocument()
    expect(refresh).toHaveBeenCalledOnce()
  })
})
