import type { ReactNode } from "react"
import { act, cleanup, render, screen, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  authFetch: vi.fn(),
  respondToPermission: vi.fn(),
  submitUserQuestionAnswers: vi.fn(),
}))

vi.mock("@/lib/auth", () => ({ authFetch: mocks.authFetch }))
vi.mock("@/lib/permissionApi", () => ({
  respondToPermission: mocks.respondToPermission,
  respondToAllPermissions: vi.fn(),
}))
vi.mock("@/lib/askUserApi", () => ({
  submitUserQuestionAnswers: mocks.submitUserQuestionAnswers,
  joinMultiSelect: (labels: Iterable<string>) => [...labels].join(", "),
}))

import {
  PendingHumanInputProvider,
  usePendingHumanInput,
} from "../PendingHumanInputContext"

function textResponse(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    text: vi.fn().mockResolvedValue(JSON.stringify(body)),
  } as unknown as Response
}

/** Route each endpoint independently so one can change while the other is stable. */
function routeFetch(perms: unknown, questions: unknown) {
  mocks.authFetch.mockImplementation((url: string) =>
    Promise.resolve(textResponse(url.includes("user-questions") ? questions : perms)),
  )
}

const ONE_QUESTION = {
  bySession: {
    "sess-q": [{
      sessionId: "sess-q",
      toolUseId: "toolu_1",
      askedAt: 1,
      questions: [{
        question: "Which language?",
        header: "Language",
        multiSelect: false,
        options: [{ label: "TypeScript", hasPreview: false }],
      }],
    }],
  },
}

function Probe() {
  const {
    permissionsBySession, questionsBySession, awaitingPermission, awaitingQuestion,
    answerQuestion, refresh,
  } = usePendingHumanInput()
  const question = [...questionsBySession.values()][0]?.[0]
  return (
    <div>
      <span data-testid="perms">{[...awaitingPermission].sort().join(",")}</span>
      <span data-testid="questions">{[...awaitingQuestion].sort().join(",")}</span>
      <span data-testid="permSummary">
        {[...permissionsBySession.values()][0]?.[0]?.summary ?? ""}
      </span>
      <span data-testid="qtext">{question?.questions[0]?.question ?? ""}</span>
      <button
        type="button"
        onClick={() => question && answerQuestion(question.sessionId, question.toolUseId, {
          "Which language?": "TypeScript",
        })}
      >
        answer
      </button>
      <button type="button" onClick={refresh}>refresh</button>
    </div>
  )
}

function renderProbe(ui: ReactNode = <Probe />) {
  return render(<PendingHumanInputProvider>{ui}</PendingHumanInputProvider>)
}

beforeEach(() => {
  vi.clearAllMocks()
  routeFetch({ bySession: {} }, { bySession: {} })
  mocks.respondToPermission.mockResolvedValue(true)
  mocks.submitUserQuestionAnswers.mockResolvedValue({ ok: true, gone: false })
})

afterEach(cleanup)

describe("PendingHumanInputProvider", () => {
  it("polls both endpoints and exposes each blocker separately", async () => {
    routeFetch(
      {
        bySession: {
          "sess-p": [{ requestId: "r1", toolName: "Bash", input: { command: "rm -rf dist" }, timestamp: 1 }],
        },
      },
      ONE_QUESTION,
    )

    renderProbe()

    await waitFor(() => {
      expect(screen.getByTestId("perms").textContent).toBe("sess-p")
    })
    expect(screen.getByTestId("questions").textContent).toBe("sess-q")
    expect(screen.getByTestId("permSummary").textContent).toBe("rm -rf dist")
    expect(screen.getByTestId("qtext").textContent).toBe("Which language?")
  })

  it("surfaces a new question even while the permissions payload is unchanged", async () => {
    // Regression: a single shared dedupe key let a stable permissions response
    // suppress a changed questions response, and the grid stopped updating.
    routeFetch({ bySession: {} }, { bySession: {} })
    renderProbe()
    await waitFor(() => expect(mocks.authFetch).toHaveBeenCalled())

    routeFetch({ bySession: {} }, ONE_QUESTION)
    await act(async () => { screen.getByRole("button", { name: "refresh" }).click() })

    await waitFor(() => {
      expect(screen.getByTestId("questions").textContent).toBe("sess-q")
    })
  })

  it("drops a question locally as soon as it is answered", async () => {
    routeFetch({ bySession: {} }, ONE_QUESTION)
    renderProbe()
    await waitFor(() => expect(screen.getByTestId("questions").textContent).toBe("sess-q"))

    routeFetch({ bySession: {} }, { bySession: {} })
    await act(async () => { screen.getByRole("button", { name: "answer" }).click() })

    await waitFor(() => expect(screen.getByTestId("questions").textContent).toBe(""))
    expect(mocks.submitUserQuestionAnswers).toHaveBeenCalledWith(
      "sess-q", "toolu_1", { "Which language?": "TypeScript" },
    )
  })

  it("keeps the question when the server refuses the answer", async () => {
    routeFetch({ bySession: {} }, ONE_QUESTION)
    mocks.submitUserQuestionAnswers.mockResolvedValue({ ok: false, gone: true })
    renderProbe()
    await waitFor(() => expect(screen.getByTestId("questions").textContent).toBe("sess-q"))

    await act(async () => { screen.getByRole("button", { name: "answer" }).click() })

    expect(screen.getByTestId("questions").textContent).toBe("sess-q")
  })

  it("keeps the previous lists when a poll fails", async () => {
    routeFetch({ bySession: {} }, ONE_QUESTION)
    renderProbe()
    await waitFor(() => expect(screen.getByTestId("questions").textContent).toBe("sess-q"))

    mocks.authFetch.mockRejectedValue(new Error("offline"))
    await act(async () => { await Promise.resolve() })

    expect(screen.getByTestId("questions").textContent).toBe("sess-q")
  })

  it("throws a clear error when used outside the provider", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {})
    expect(() => render(<Probe />)).toThrow(/PendingHumanInputProvider/)
    spy.mockRestore()
  })
})
