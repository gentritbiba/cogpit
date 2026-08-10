// @vitest-environment node
import { afterEach, describe, expect, it } from "vitest"
import {
  __resetBootstrapTokenForTest,
  consumeBootstrapToken,
  getBootstrapToken,
  initializeBootstrapToken,
  verifyBootstrapToken,
} from "../team/bootstrapToken"

afterEach(__resetBootstrapTokenForTest)

describe("founding-admin bootstrap token", () => {
  it("generates a high-entropy process-local token for an empty store", () => {
    const token = initializeBootstrapToken(0, {})
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(verifyBootstrapToken(token!)).toBe(true)
  })

  it("supports an operator-provided token for curl/headless setup", () => {
    const configured = "operator-bootstrap-token-at-least-32-chars"
    expect(initializeBootstrapToken(0, { COGPIT_BOOTSTRAP_TOKEN: configured })).toBe(configured)
    expect(verifyBootstrapToken(configured)).toBe(true)
    expect(verifyBootstrapToken("wrong")).toBe(false)
  })

  it("rejects weak configured tokens", () => {
    expect(() => initializeBootstrapToken(0, { COGPIT_BOOTSTRAP_TOKEN: "short" }))
      .toThrow("32–256")
    expect(() => initializeBootstrapToken(0, {
      COGPIT_BOOTSTRAP_TOKEN: "token-with-a-newline-is-not-safe-for-logs\n",
    })).toThrow("printable non-space ASCII")
  })

  it("treats an empty environment value as unset", () => {
    expect(initializeBootstrapToken(0, { COGPIT_BOOTSTRAP_TOKEN: "" }))
      .toMatch(/^[A-Za-z0-9_-]{43}$/)
  })

  it("has no bootstrap credential after setup or when users already exist", () => {
    const token = initializeBootstrapToken(0, {})!
    consumeBootstrapToken()
    expect(verifyBootstrapToken(token)).toBe(false)
    expect(getBootstrapToken()).toBeNull()

    expect(initializeBootstrapToken(1, {})).toBeNull()
  })
})
