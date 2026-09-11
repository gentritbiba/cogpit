import { describe, expect, it } from "vitest"
import { render, screen } from "@testing-library/react"
import { SessionPreview } from "../SessionPreview"
import type { ActiveSessionInfo } from "../types"

function makeSession(overrides: Partial<ActiveSessionInfo> = {}): ActiveSessionInfo {
  return {
    dirName: "test-dir",
    projectShortName: "Test Project",
    fileName: "session.jsonl",
    sessionId: "preview-session-id",
    lastModified: new Date().toISOString(),
    size: 1024,
    ...overrides,
  }
}

const pullRequest = {
  url: "https://github.com/o/r/pull/13",
  number: 13,
  repo: "o/r",
  title: "Team Edition",
  isDraft: false,
  toolCallId: "t13",
  timestamp: "2026-08-14T10:00:00.000Z",
}

describe("SessionPreview", () => {
  it("shows the turn count that the row no longer displays", () => {
    render(<SessionPreview session={makeSession({ turnCount: 42 })} />)
    expect(screen.getByText("42 turns")).toBeInTheDocument()
  })

  it("uses the singular for a one-turn session", () => {
    render(<SessionPreview session={makeSession({ turnCount: 1 })} />)
    expect(screen.getByText("1 turn")).toBeInTheDocument()
  })

  it("omits the turn count for a session with no turns", () => {
    render(<SessionPreview session={makeSession({ turnCount: 0 })} />)
    expect(screen.queryByText(/turns/)).toBeNull()
  })

  it("lists pull requests with their titles", () => {
    render(<SessionPreview session={makeSession({ pullRequests: [pullRequest] })} />)
    expect(screen.getByText("#13")).toBeInTheDocument()
    expect(screen.getByText("Team Edition")).toBeInTheDocument()
  })

  it("links each pull request out to GitHub", () => {
    render(<SessionPreview session={makeSession({ pullRequests: [pullRequest] })} />)
    const link = screen.getByRole("link", { name: "Pull request #13" })
    expect(link).toHaveAttribute("href", pullRequest.url)
    expect(link).toHaveAttribute("target", "_blank")
  })

  it("uses the draft icon only for a draft pull request", () => {
    const solid = render(<SessionPreview session={makeSession({ pullRequests: [pullRequest] })} />)
    expect(solid.container.querySelector(".lucide-git-pull-request-draft")).toBeNull()
    solid.unmount()

    const draft = render(<SessionPreview session={makeSession({
      pullRequests: [{ ...pullRequest, isDraft: true }],
    })} />)
    expect(draft.container.querySelector(".lucide-git-pull-request-draft")).toBeInTheDocument()
  })

  it("lists every pull request, not just the newest", () => {
    render(<SessionPreview session={makeSession({
      pullRequests: [pullRequest, { ...pullRequest, url: "https://github.com/o/r/pull/14", number: 14, title: "Second" }],
    })} />)
    expect(screen.getByText("#13")).toBeInTheDocument()
    expect(screen.getByText("#14")).toBeInTheDocument()
  })

  it("renders nothing about pull requests when there are none", () => {
    render(<SessionPreview session={makeSession()} />)
    expect(screen.queryByText(/^#\d+$/)).toBeNull()
  })
})

describe("SessionPreview prompts and project", () => {
  it("shows how the session started and, when different, where it is now", () => {
    render(<SessionPreview session={makeSession({ firstUserMessage: "first ask", lastUserMessage: "latest ask" })} />)

    expect(screen.getByText("first ask")).toBeInTheDocument()
    expect(screen.getByText("Started with")).toBeInTheDocument()
    expect(screen.getByText("latest ask")).toBeInTheDocument()
    expect(screen.getByText("Latest")).toBeInTheDocument()
  })

  it("shows a single prompt once, without labels", () => {
    render(<SessionPreview session={makeSession({ firstUserMessage: "only ask", lastUserMessage: "only ask" })} />)

    expect(screen.getAllByText("only ask")).toHaveLength(1)
    expect(screen.queryByText("Started with")).not.toBeInTheDocument()
    expect(screen.queryByText("Latest")).not.toBeInTheDocument()
  })

  it("names the project when the list around it does not", () => {
    render(<SessionPreview session={makeSession()} projectLabel="me/app" />)
    expect(screen.getByText("me/app")).toBeInTheDocument()
  })
})
