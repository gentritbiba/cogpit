import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { CrewFold } from "../CrewFold"
import type { MemberStatus } from "../crew"
import type { ActiveSessionInfo } from "../types"

const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString()

function row(sessionId: string, parentId: string, minutes: number): ActiveSessionInfo {
  return {
    sessionId, dirName: "-work", fileName: `${sessionId}.jsonl`, projectShortName: "work", size: 1,
    lastModified: minutesAgo(minutes), lastActivityAt: minutesAgo(minutes),
    crew: { rootId: "host", parentId, startedAt: 1, name: sessionId },
  }
}

const host: ActiveSessionInfo = { sessionId: "host", dirName: "-work", fileName: "host.jsonl", projectShortName: "work", size: 1, lastModified: minutesAgo(1) }

function renderFold(members: ActiveSessionInfo[], states: Record<string, MemberStatus>) {
  const statusOf = vi.fn((member: ActiveSessionInfo) => states[member.sessionId] ?? { state: "done" as const })
  render(
    <CrewFold
      host={host}
      members={members}
      counts={{ size: members.length, needsYou: 0, working: 0, done: 0 }}
      statusOf={statusOf}
      open
      onToggle={vi.fn()}
      sessionNames={{}}
      activeSessionKey={null}
      onSelectSession={vi.fn()}
    />,
  )
  return { statusOf }
}

const listed = () => [...document.querySelectorAll("[data-crew-member]")].map((element) => element.getAttribute("data-crew-member"))

afterEach(cleanup)

describe("CrewFold", () => {
  it("lists who needs someone, then who works, then the finished by latest activity, with a deeper waiting member via its parent", () => {
    const members = [
      row("old", "host", 50), row("lane", "host", 5), row("busy", "host", 20), row("recent", "host", 2),
      row("deep", "lane", 1), row("deep-done", "lane", 1),
    ]
    renderFold(members, { busy: { state: "working" }, deep: { state: "needs-you", need: "question" } })
    expect(listed()).toEqual(["deep", "busy", "recent", "lane", "old"])
    expect(screen.getByRole("button", { name: /^deep · via lane,/ })).toBeInTheDocument()
    expect(screen.getByRole("button", { name: /^lane · 2 sessions,/ })).toBeInTheDocument()
  })

  it("folds the finished beyond the first six into a link", () => {
    const members = Array.from({ length: 9 }, (_, index) => row(`done-${index}`, "host", index + 1))
    renderFold([row("busy", "host", 1), ...members], { busy: { state: "working" } })
    expect(listed()).toEqual(["busy", "done-0", "done-1", "done-2", "done-3", "done-4", "done-5"])
    fireEvent.click(screen.getByRole("button", { name: "Show 3 more done" }))
    expect(listed()).toHaveLength(10)
  })

  it("asks each member's status once however large the crew", () => {
    const members = Array.from({ length: 200 }, (_, index) => row(`m-${index}`, "host", index + 1))
    const { statusOf } = renderFold(members, {})
    expect(statusOf).toHaveBeenCalledTimes(200)
  })
})
