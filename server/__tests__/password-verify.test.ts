// @vitest-environment node
import { describe, it, expect } from "vitest"
import { verifyRemotePassword, getDummyHash } from "../password-verify"
import { hashPassword } from "../password-utils"

describe("verifyRemotePassword", () => {
  it("accepts the right password", async () => {
    expect(await verifyRemotePassword("correct horse battery", hashPassword("correct horse battery"))).toBe("valid")
  })

  it("rejects the wrong one", async () => {
    expect(await verifyRemotePassword("nope", hashPassword("correct horse battery"))).toBe("invalid")
  })

  it("reports busy past the concurrency ceiling", async () => {
    const stored = hashPassword("correct horse battery")
    const results = await Promise.all(
      Array.from({ length: 8 }, () => verifyRemotePassword("correct horse battery", stored)),
    )
    expect(results).toContain("busy")
    expect(results.filter((r) => r !== "busy").every((r) => r === "valid")).toBe(true)
  })

  it("releases the slot again once verification settles", async () => {
    const stored = hashPassword("correct horse battery")
    await Promise.all(
      Array.from({ length: 8 }, () => verifyRemotePassword("correct horse battery", stored)),
    )
    expect(await verifyRemotePassword("correct horse battery", stored)).toBe("valid")
  })
})

describe("getDummyHash", () => {
  it("returns a stable dummy hash for timing padding", () => {
    expect(getDummyHash()).toBe(getDummyHash())
    expect(getDummyHash().startsWith("$scrypt$")).toBe(true)
  })
})
