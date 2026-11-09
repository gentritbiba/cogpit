import { describe, expect, it, vi } from "vitest"
import { render, screen } from "@testing-library/react"
import { showSession } from "./sessionContextMock"

vi.mock("@/contexts/SessionContext", async () => (await import("./sessionContextMock")).withSessionHooks({
  useSessionContext: () => ({ isLive: false }),
}))

import { useOpenSession, useSessionContext } from "@/contexts/SessionContext"

function Turns() {
  const { session } = useSessionContext()
  return <span data-testid="turns">{session?.turns.length}</span>
}

describe("withSessionHooks", () => {
  it("reaches mounted components through their subscriptions, with no re-render from the test", () => {
    function Selected() {
      return <span data-testid="id">{useOpenSession((open) => open?.sessionId)}</span>
    }
    showSession({ sessionId: "s1", turns: [] })
    render(<><Selected /><Turns /></>)

    showSession({ sessionId: "s2", turns: [{}, {}] })

    expect(screen.getByTestId("id")).toHaveTextContent("s2")
    expect(screen.getByTestId("turns")).toHaveTextContent("2")
  })

  it("refuses a session handed in through the mocked context", async () => {
    const { withSessionHooks } = await import("./sessionContextMock")
    const mock = withSessionHooks({ useSessionContext: () => ({ session: {} }) })
    expect(() => mock.useSessionControls()).toThrow(/showSession/)
  })
})
