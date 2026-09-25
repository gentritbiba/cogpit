// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  approvals: [] as Array<Record<string, unknown>>,
  questions: [] as Array<Record<string, unknown>>,
  plans: [] as Array<Record<string, unknown>>,
  respondToApproval: vi.fn(),
  answerQuestion: vi.fn(),
  answerExitPlan: vi.fn(),
}))

vi.mock("../../agents/runtimes", () => ({
  allRuntimes: () => [{
    listPendingApprovals: (id: string) => mocks.approvals.filter((a) => a.sessionId === id),
    listPendingQuestions: (id: string) => mocks.questions.filter((q) => q.sessionId === id),
    respondToApproval: mocks.respondToApproval,
    answerQuestion: mocks.answerQuestion,
  }],
}))

vi.mock("../../agents/copilotTransport", () => ({
  copilotRuntime: {
    getPendingExitPlans: (id: string) => mocks.plans.filter((p) => p.sessionId === id),
    answerExitPlan: mocks.answerExitPlan,
  },
}))

import { listPendingInput, respondToPendingInput } from "../../agents/pendingInput"
import { AgentRuntimeError } from "../../agents/runtimeTypes"

beforeEach(() => {
  mocks.approvals = [{
    sessionId: "s",
    requestId: "perm-1",
    toolName: "Bash",
    input: { command: "rm -rf build" },
    availableDecisions: ["allow", "deny"],
  }]
  mocks.questions = [{
    sessionId: "s",
    toolUseId: "q-1",
    askedAt: 1,
    questions: [{ question: "Color?", multiSelect: false, options: [{ label: "Red", hasPreview: false }] }],
  }]
  mocks.plans = [{ sessionId: "s", requestId: "plan-1", summary: "Plan", actions: ["a"], recommendedAction: "a" }]
  mocks.respondToApproval.mockReset().mockResolvedValue(true)
  mocks.answerQuestion.mockReset().mockResolvedValue(true)
  mocks.answerExitPlan.mockReset()
})

describe("listPendingInput", () => {
  it("normalizes approvals, questions and plans into one list", () => {
    expect(listPendingInput("s")).toEqual([
      {
        kind: "permission",
        requestId: "perm-1",
        toolName: "Bash",
        summary: "rm -rf build",
        availableDecisions: ["allow", "deny"],
      },
      {
        kind: "question",
        requestId: "q-1",
        questions: [{ question: "Color?", multiSelect: false, options: ["Red"] }],
      },
      { kind: "plan", requestId: "plan-1", summary: "Plan", actions: ["a"], recommendedAction: "a" },
    ])
    expect(listPendingInput("other")).toEqual([])
  })
})

describe("respondToPendingInput", () => {
  it("routes each kind of answer to the agent that asked", async () => {
    await respondToPendingInput("s", "perm-1", { decision: "deny" })
    expect(mocks.respondToApproval).toHaveBeenCalledWith("s", "perm-1", "deny")

    await respondToPendingInput("s", "q-1", { answers: "Red" })
    expect(mocks.answerQuestion).toHaveBeenCalledWith("s", "q-1", "Red")

    await respondToPendingInput("s", "plan-1", { approved: false, feedback: "smaller" })
    expect(mocks.answerExitPlan).toHaveBeenCalledWith("s", "plan-1", { approved: false, feedback: "smaller" })
  })

  it("refuses an answer of the wrong shape, an unknown id, and a rejected answer", async () => {
    await expect(respondToPendingInput("s", "perm-1", { answers: "Red" })).rejects.toMatchObject({ status: 400 })
    await expect(respondToPendingInput("s", "nope", { decision: "allow" })).rejects.toMatchObject({ status: 404 })

    mocks.respondToApproval.mockResolvedValue(false)
    await expect(respondToPendingInput("s", "perm-1", { decision: "allow" }))
      .rejects.toBeInstanceOf(AgentRuntimeError)
  })
})
