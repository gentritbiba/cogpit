import { describe, it, expect } from "vitest"
import { isTerminalAgentState } from "../../../shared/contracts/workflows"

// WorkflowAgentCard uses this twice: to decide whether an agent still shows a
// spinner, and to decide whether expanding the card should fetch its result.
// Getting it wrong either spins forever or fetches a result that isn't written
// yet, so the whole terminal set is pinned here.
describe("isTerminalAgentState", () => {
  it.each(["done", "error", "skipped"])("treats %s as terminal", (state) => {
    expect(isTerminalAgentState(state)).toBe(true)
  })

  it.each([
    "queued",
    "running",
    "pending",
    "retrying",
  ])("treats %s as still in flight", (state) => {
    expect(isTerminalAgentState(state)).toBe(false)
  })

  it("does not treat unknown or malformed states as terminal", () => {
    // An unrecognised state means the run is still being reported on; assuming
    // it finished would stop the card from updating.
    expect(isTerminalAgentState("")).toBe(false)
    expect(isTerminalAgentState("completed")).toBe(false)
    expect(isTerminalAgentState("failed")).toBe(false)
    expect(isTerminalAgentState("cancelled")).toBe(false)
  })

  it("matches exactly, without case folding or trimming", () => {
    expect(isTerminalAgentState("Done")).toBe(false)
    expect(isTerminalAgentState("DONE")).toBe(false)
    expect(isTerminalAgentState("done ")).toBe(false)
    expect(isTerminalAgentState(" error")).toBe(false)
  })
})
