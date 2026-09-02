import type { ReactNode } from "react"
import { act, cleanup, render, screen, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  authFetch: vi.fn(),
  respondToPermission: vi.fn(),
  submitUserQuestionAnswers: vi.fn(),
  submitElicitationAnswer: vi.fn(),
  submitUserDialogChoice: vi.fn(),
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
vi.mock("@/lib/agentPromptsApi", () => ({
  submitElicitationAnswer: mocks.submitElicitationAnswer,
  submitUserDialogChoice: mocks.submitUserDialogChoice,
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

const NO_PROMPTS = { elicitationsBySession: {}, dialogsBySession: {} }

/** Route each endpoint independently so one can change while the others are stable. */
function routeFetch(perms: unknown, questions: unknown, prompts: unknown = NO_PROMPTS) {
  mocks.authFetch.mockImplementation((url: string) => {
    if (url.includes("agent-prompts")) return Promise.resolve(textResponse(prompts))
    return Promise.resolve(textResponse(url.includes("user-questions") ? questions : perms))
  })
}

const ONE_ELICITATION = {
  elicitationsBySession: {
    "sess-e": [{
      sessionId: "sess-e",
      requestId: "req-1",
      serverName: "github",
      message: "Enter your access token",
      mode: "form",
      askedAt: 1,
      fields: [{ name: "token", label: "Token", type: "string", required: true }],
    }],
  },
  dialogsBySession: {
    "sess-d": [{
      sessionId: "sess-d",
      requestId: "dlg-1",
      dialogKind: "refusal_fallback_prompt",
      askedAt: 2,
      originalModel: "claude-opus-5",
      fallbackModel: "claude-opus-4-8",
    }],
  },
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
    elicitationsBySession, dialogsBySession, awaitingElicitation, awaitingDialog,
    awaitingPlan,
    answerQuestion, answerElicitation, answerDialog, refresh,
  } = usePendingHumanInput()
  const question = [...questionsBySession.values()][0]?.[0]
  const elicitation = [...elicitationsBySession.values()][0]?.[0]
  const dialog = [...dialogsBySession.values()][0]?.[0]
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
      <span data-testid="elicitations">{[...awaitingElicitation].sort().join(",")}</span>
      <span data-testid="dialogs">{[...awaitingDialog].sort().join(",")}</span>
      <span data-testid="plans">{[...awaitingPlan].sort().join(",")}</span>
      <span data-testid="etext">{elicitation?.message ?? ""}</span>
      <span data-testid="dmodel">{dialog?.fallbackModel ?? ""}</span>
      <button
        type="button"
        onClick={() => elicitation && answerElicitation(
          elicitation.sessionId,
          elicitation.requestId,
          { action: "accept", content: { token: "ghp_x" } },
        )}
      >
        accept elicitation
      </button>
      <button
        type="button"
        onClick={() => dialog && answerDialog(dialog.sessionId, dialog.requestId, "retry_fallback")}
      >
        retry fallback
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
  mocks.submitElicitationAnswer.mockResolvedValue({ ok: true, gone: false })
  mocks.submitUserDialogChoice.mockResolvedValue({ ok: true, gone: false })
})

afterEach(cleanup)

describe("PendingHumanInputProvider", () => {
  it("polls both endpoints and exposes each blocker separately", async () => {
    routeFetch(
      {
        bySession: {
          // The server ships the card-ready summary; raw tool input is not sent.
          "sess-p": [{ sessionId: "sess-p", requestId: "r1", toolName: "Bash", summary: "rm -rf dist", timestamp: 1 }],
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

  it("exposes only the session ids that have pending plans", async () => {
    routeFetch({
      bySession: {},
      plansBySession: {
        "sess-plan": [{
          sessionId: "sess-plan",
          requestId: "plan-1",
          summary: "Implementation plan",
        }],
        empty: [],
      },
    }, { bySession: {} })

    renderProbe()

    await waitFor(() => {
      expect(screen.getByTestId("plans").textContent).toBe("sess-plan")
    })
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

  it("exposes elicitations and dialogs parked on the agent-prompts endpoint", async () => {
    routeFetch({ bySession: {} }, { bySession: {} }, ONE_ELICITATION)

    renderProbe()

    await waitFor(() => {
      expect(screen.getByTestId("elicitations").textContent).toBe("sess-e")
    })
    expect(screen.getByTestId("dialogs").textContent).toBe("sess-d")
    expect(screen.getByTestId("etext").textContent).toBe("Enter your access token")
    expect(screen.getByTestId("dmodel").textContent).toBe("claude-opus-4-8")
  })

  it("drops an elicitation locally as soon as it is answered", async () => {
    routeFetch({ bySession: {} }, { bySession: {} }, ONE_ELICITATION)
    renderProbe()
    await waitFor(() => expect(screen.getByTestId("elicitations").textContent).toBe("sess-e"))

    routeFetch({ bySession: {} }, { bySession: {} })
    await act(async () => { screen.getByRole("button", { name: "accept elicitation" }).click() })

    await waitFor(() => expect(screen.getByTestId("elicitations").textContent).toBe(""))
    expect(mocks.submitElicitationAnswer).toHaveBeenCalledWith(
      "sess-e", "req-1", { action: "accept", content: { token: "ghp_x" } },
    )
  })

  it("keeps the elicitation when the server refuses the answer", async () => {
    routeFetch({ bySession: {} }, { bySession: {} }, ONE_ELICITATION)
    mocks.submitElicitationAnswer.mockResolvedValue({ ok: false, gone: true })
    renderProbe()
    await waitFor(() => expect(screen.getByTestId("elicitations").textContent).toBe("sess-e"))

    await act(async () => { screen.getByRole("button", { name: "accept elicitation" }).click() })

    expect(screen.getByTestId("elicitations").textContent).toBe("sess-e")
  })

  it("sends a dialog choice and drops the dialog", async () => {
    routeFetch({ bySession: {} }, { bySession: {} }, ONE_ELICITATION)
    renderProbe()
    await waitFor(() => expect(screen.getByTestId("dialogs").textContent).toBe("sess-d"))

    routeFetch({ bySession: {} }, { bySession: {} })
    await act(async () => { screen.getByRole("button", { name: "retry fallback" }).click() })

    await waitFor(() => expect(screen.getByTestId("dialogs").textContent).toBe(""))
    expect(mocks.submitUserDialogChoice).toHaveBeenCalledWith("sess-d", "dlg-1", "retry_fallback")
  })

  it("throws a clear error when used outside the provider", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {})
    expect(() => render(<Probe />)).toThrow(/PendingHumanInputProvider/)
    spy.mockRestore()
  })
})
