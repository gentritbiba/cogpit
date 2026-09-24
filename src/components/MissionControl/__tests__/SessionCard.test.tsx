import { cleanup, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { __installEditionUiForTest, __resetEditionUiForTest } from "@/edition/registry"
import { SessionCard } from "../SessionCard"
import type { MissionCard } from "../missionControlView"
import type { ListedAccess } from "../../../../shared/contracts/sessionAccess"

afterEach(() => {
  cleanup()
  __resetEditionUiForTest()
})

function blockedCard(access?: ListedAccess, canAnswer = true): MissionCard {
  return {
    session: {
      dirName: "-work-app",
      projectShortName: "app",
      fileName: "s1.jsonl",
      sessionId: "s1",
      lastModified: new Date().toISOString(),
      size: 1,
      aiTitle: "Fix the build",
      access,
    },
    state: "awaiting_approval",
    summary: null,
    permissions: [{ sessionId: "s1", requestId: "r1", toolName: "Bash", summary: "rm -rf dist", timestamp: 1 }],
    questions: [],
    elicitations: [],
    dialogs: [],
    canAnswer,
  }
}

function renderCard(card: MissionCard) {
  render(
    <SessionCard
      card={card}
      projectLabel="app"
      responding={new Set()}
      goneQuestions={new Set()}
      onOpen={vi.fn()}
      onRespond={vi.fn()}
      onAnswerQuestion={vi.fn()}
      onAnswerElicitation={vi.fn()}
      onChooseDialog={vi.fn()}
    />,
  )
}

describe("Mission Control SessionCard", () => {
  it("lets the user answer a session they can interact with", () => {
    renderCard(blockedCard({ level: "interact", mine: false }))

    expect(screen.getByRole("button", { name: "Allow" })).toBeInTheDocument()
  })

  it("shows a viewer what the session waits on, read-only, with a view-only note", () => {
    renderCard(blockedCard({ level: "view", mine: false }, false))

    expect(screen.getByText("rm -rf dist")).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: /Allow|Deny|Always/ })).not.toBeInTheDocument()
    expect(screen.getByText(/View only/)).toBeInTheDocument()
    expect(screen.getByText("Waiting for approval")).toBeInTheDocument()
  })

  it("answers as before in personal edition, with no edition badges", () => {
    renderCard(blockedCard())

    expect(screen.getByRole("button", { name: "Allow" })).toBeInTheDocument()
    expect(screen.queryByText(/Badge:/)).not.toBeInTheDocument()
  })

  it("carries the edition's badges for the session, given the card's access", () => {
    __installEditionUiForTest({ SessionBadges: ({ access }) => <span>Badge: {access?.level}</span> })
    renderCard(blockedCard({ level: "interact", mine: false }))

    expect(screen.getByText("Badge: interact")).toBeInTheDocument()
  })
})
