import { afterEach, describe, expect, it, vi } from "vitest"
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"
import type { ParsedSession } from "../../../../shared/session/types"
import { TranscriptGoalProvider } from "@/components/goal/TranscriptGoalProvider"
import { GoalSection, GoalTrigger } from "@/components/goal"

function sessionWith(rawMessages: Array<Record<string, unknown>>): ParsedSession {
  return { rawMessages } as unknown as ParsedSession
}

const ACTIVE_GOAL = { type: "attachment", attachment: { type: "goal_status", condition: "Ship the release" } }

function deferred(): { promise: Promise<boolean>; resolve: (sent: boolean) => void } {
  let resolve!: (sent: boolean) => void
  const promise = new Promise<boolean>((settle) => { resolve = settle })
  return { promise, resolve }
}

function renderGoalUi(session: ParsedSession, onSendCommand: (command: string) => Promise<boolean>) {
  return render(
    <TranscriptGoalProvider agentKind="claude" session={session} onSendCommand={onSendCommand}>
      <GoalSection />
      <GoalTrigger />
    </TranscriptGoalProvider>,
  )
}

afterEach(cleanup)

describe("TranscriptGoalProvider", () => {
  it("shows a goal it sent before the agent echoes it back", async () => {
    const onSendCommand = vi.fn(() => Promise.resolve(true))
    renderGoalUi(sessionWith([]), onSendCommand)

    fireEvent.click(screen.getByRole("button", { name: /Set goal/i }))
    fireEvent.change(screen.getByLabelText("Goal condition"), { target: { value: "Ship the release" } })
    await act(async () => fireEvent.click(screen.getByRole("button", { name: /Start goal/i })))

    expect(onSendCommand).toHaveBeenCalledWith("/goal Ship the release")
    expect(screen.getByText("Ship the release")).toBeInTheDocument()
    expect(screen.getByText("Goal active")).toBeInTheDocument()
  })

  it("takes back a goal the server refused, keeping its condition in the editor", async () => {
    const sending = deferred()
    renderGoalUi(sessionWith([]), () => sending.promise)

    fireEvent.click(screen.getByRole("button", { name: /Set goal/i }))
    fireEvent.change(screen.getByLabelText("Goal condition"), { target: { value: "Ship the release" } })
    fireEvent.click(screen.getByRole("button", { name: /Start goal/i }))
    expect(screen.getByText("Goal active")).toBeInTheDocument()

    await act(async () => sending.resolve(false))

    expect(screen.queryByText("Goal active")).not.toBeInTheDocument()
    expect(screen.getByLabelText("Goal condition")).toHaveValue("Ship the release")
  })

  it("puts back a goal whose clearing the server refused", async () => {
    const sending = deferred()
    const onSendCommand = vi.fn(() => sending.promise)
    renderGoalUi(sessionWith([ACTIVE_GOAL]), onSendCommand)

    fireEvent.click(screen.getByRole("button", { name: /Clear goal/i }))
    expect(onSendCommand).toHaveBeenCalledWith("/goal clear")
    expect(screen.queryByText("Ship the release")).not.toBeInTheDocument()

    await act(async () => sending.resolve(false))

    expect(screen.getByText("Ship the release")).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: /Set goal/i })).not.toBeInTheDocument()
  })
})
