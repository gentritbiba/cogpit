import { describe, expect, it } from "bun:test"
import { copilotSessionsDir } from "../../lib/dirs"

describe("copilotSessionsDir", () => {
  it("uses COPILOT_HOME when configured", () => {
    expect(copilotSessionsDir("/opt/copilot-data", "/Users/me")).toBe(
      "/opt/copilot-data/session-state",
    )
  })

  it("falls back to the user's Copilot home", () => {
    expect(copilotSessionsDir(undefined, "/Users/me")).toBe(
      "/Users/me/.copilot/session-state",
    )
  })
})
