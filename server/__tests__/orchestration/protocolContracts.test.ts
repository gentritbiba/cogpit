// @vitest-environment node
import { describe, expect, it } from "vitest"
import { validateCodexRequest } from "../../agents/codexProtocolValidation"
describe("generated provider request contracts", () => {
  it("checks required fields and nested types while allowing additive provider fields", () => {
    expect(() => validateCodexRequest("turn/start", { threadId: "native-thread", input: [{ type: "text", text: "Hello", text_elements: [] }], futureProviderField: { additive: true } })).not.toThrow()
    expect(() => validateCodexRequest("turn/start", { input: [] })).toThrow("contract")
    expect(() => validateCodexRequest("turn/start", { threadId: "thread", input: [{ type: "text", text: 42 }] })).toThrow("contract")
    expect(() => validateCodexRequest("future/provider/method", { newField: true })).not.toThrow()
  })
})
