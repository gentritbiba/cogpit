import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import type { DelegatedRequest } from "../../../shared/contracts/delegatedRequests"

const mocks = vi.hoisted(() => ({
  authFetch: vi.fn(),
  jsonFetch: vi.fn(),
  revealSessionPath: vi.fn(),
}))

vi.mock("@/lib/auth", () => ({ authFetch: mocks.authFetch, jsonFetch: mocks.jsonFetch }))
vi.mock("@/lib/revealSession", () => ({ revealSessionPath: mocks.revealSessionPath }))

import { DelegatedRequests } from "../DelegatedRequests"

const remoteQuestion: DelegatedRequest = {
  sessionId: "child-1",
  address: { dirName: "-home-dev-app", fileName: "child-1.jsonl" },
  parentSessionId: "parent-1",
  device: { id: "dev_1", name: "agentbox" },
  waiting: [{
    kind: "question",
    requestId: "toolu_q",
    questions: [{ question: "Which database?", multiSelect: false, options: ["Postgres", "SQLite"] }],
  }],
}

const localPermission: DelegatedRequest = {
  sessionId: "child-2",
  address: null,
  parentSessionId: "parent-1",
  device: null,
  waiting: [{ kind: "permission", requestId: "perm-1", toolName: "Bash", summary: "rm -rf build", availableDecisions: ["allow", "deny"] }],
}

function serve(requests: DelegatedRequest[]) {
  mocks.authFetch.mockResolvedValue(new Response(JSON.stringify({ requests })))
}

beforeEach(() => {
  mocks.jsonFetch.mockResolvedValue(new Response("{}"))
})

afterEach(() => {
  vi.clearAllMocks()
})

describe("DelegatedRequests", () => {
  it("renders nothing while no delegated session is waiting", async () => {
    serve([])
    const { container } = render(<DelegatedRequests sessionId="parent-1" />)
    await waitFor(() => expect(mocks.authFetch).toHaveBeenCalledWith("/api/session-requests?parent=parent-1"))
    expect(container).toBeEmptyDOMElement()
  })

  it("answers a remote session's question and opens it on its device", async () => {
    const user = userEvent.setup()
    serve([remoteQuestion])
    render(<DelegatedRequests sessionId="parent-1" />)

    expect(await screen.findByText("Delegated session on agentbox")).toBeInTheDocument()
    await user.click(screen.getByText("Postgres"))
    expect(mocks.jsonFetch).toHaveBeenCalledWith("/api/session-respond", {
      sessionId: "child-1",
      requestId: "toolu_q",
      answers: { "Which database?": "Postgres" },
    })
    await waitFor(() => expect(screen.queryByText("Which database?")).not.toBeInTheDocument())
  })

  it("links to the session on its device", async () => {
    const user = userEvent.setup()
    serve([remoteQuestion])
    render(<DelegatedRequests sessionId="parent-1" />)
    await user.click(await screen.findByRole("button", { name: "Open" }))
    expect(mocks.revealSessionPath).toHaveBeenCalledWith("/d/dev_1/-home-dev-app/child-1")
  })

  it("approves a local session's permission prompt", async () => {
    const user = userEvent.setup()
    serve([localPermission])
    render(<DelegatedRequests sessionId="parent-1" />)
    await user.click(await screen.findByRole("button", { name: "Allow" }))
    expect(mocks.jsonFetch).toHaveBeenCalledWith("/api/session-respond", {
      sessionId: "child-2",
      requestId: "perm-1",
      decision: "allow",
    })
  })
})
