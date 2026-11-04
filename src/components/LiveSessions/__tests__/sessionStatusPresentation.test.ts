import { describe, expect, it } from "vitest"
import { getStatusColor } from "../sessionStatusPresentation"

describe("getStatusColor", () => {
  it("reads a session that stopped for a reason as an error, not as done", () => {
    expect(getStatusColor("completed")).toBe("text-success")
    expect(getStatusColor("completed", "authentication_failed")).toBe("text-destructive")
  })

  it("keeps the working colours", () => {
    expect(getStatusColor("thinking")).toBe("text-warning")
    expect(getStatusColor("tool_use")).toBe("text-info")
  })
})
