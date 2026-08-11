import { describe, expect, it } from "vitest"
import { previewSessionIdFromPath } from "../previewMode"

describe("previewSessionIdFromPath", () => {
  it("reads encoded IDs from the preview route", () => {
    expect(previewSessionIdFromPath("/preview/session%3A123")).toBe("session:123")
  })

  it("allows a trailing slash", () => {
    expect(previewSessionIdFromPath("/preview/session-123/")).toBe("session-123")
  })

  it("does not claim normal Cogpit routes", () => {
    expect(previewSessionIdFromPath("/project/session-123")).toBeNull()
    expect(previewSessionIdFromPath("/preview/")).toBeNull()
  })
})
