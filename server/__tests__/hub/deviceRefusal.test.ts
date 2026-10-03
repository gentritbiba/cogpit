// @vitest-environment node
import { describe, expect, it } from "vitest"
import { readDeviceRefusal, relayedRefusalText, RELAYED_REFUSAL_MAX_CHARS } from "../../hub/deviceRefusal"

function forbidden(body: unknown): Response {
  return { ok: false, status: 403, json: async () => body } as unknown as Response
}

describe("readDeviceRefusal", () => {
  it("reads the code and text a device names", async () => {
    await expect(readDeviceRefusal(forbidden({ valid: false, error: "Account disabled", code: "ACCOUNT_OFF" })))
      .resolves.toEqual({ code: "ACCOUNT_OFF", error: "Account disabled" })
  })

  it("reads a refusal the device expects to lift as retryable", async () => {
    await expect(readDeviceRefusal(forbidden({ valid: false, error: "Not now", code: "PAUSED", retryable: true })))
      .resolves.toEqual({ code: "PAUSED", error: "Not now", retryable: true })
  })

  it("reads a refusal without text as an empty one", async () => {
    await expect(readDeviceRefusal(forbidden({ code: "PAUSED", retryable: "yes" }))).resolves.toEqual({ code: "PAUSED", error: "" })
  })

  it.each([
    ["a personal device's refusal", { valid: false, error: "Network access is disabled" }],
    ["an empty code", { error: "Refused", code: "" }],
    ["a code that is not a string", { error: "Refused", code: 7 }],
    ["a body that is not an object", "Forbidden"],
  ])("reads nothing from %s", async (_label, body) => {
    await expect(readDeviceRefusal(forbidden(body))).resolves.toBeNull()
  })

  it("reads nothing from a body that is not JSON", async () => {
    const response = { ok: false, status: 403, json: async () => { throw new SyntaxError("Unexpected token") } } as unknown as Response
    await expect(readDeviceRefusal(response)).resolves.toBeNull()
  })
})

describe("relayedRefusalText", () => {
  it("prefixes the device's text with its name", () => {
    expect(relayedRefusalText("Studio", "  Only admins can sign in.  ")).toBe("Studio: Only admins can sign in.")
  })

  it("relays text at the limit untouched", () => {
    const text = "a".repeat(RELAYED_REFUSAL_MAX_CHARS)
    expect(relayedRefusalText("Studio", text)).toBe(`Studio: ${text}`)
  })

  it("cuts longer text to the limit, ellipsis included", () => {
    const relayed = relayedRefusalText("Studio", "b".repeat(RELAYED_REFUSAL_MAX_CHARS + 1))
    expect(relayed).toBe(`Studio: ${"b".repeat(RELAYED_REFUSAL_MAX_CHARS - 1)}…`)
    expect(relayed.length - "Studio: ".length).toBe(RELAYED_REFUSAL_MAX_CHARS)
  })
})
