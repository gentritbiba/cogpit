import { describe, expect, it } from "vitest"
import { parseCustomToolOutput as facadeParseCustomToolOutput } from "../codex"
import {
  inferToolError,
  normalizePlanToTodos,
  parseCustomToolOutput,
} from "../../../shared/session/codex-tool-normalization"

describe("Codex tool-normalization facade", () => {
  it("preserves parseCustomToolOutput function identity and behavior", () => {
    expect(facadeParseCustomToolOutput).toBe(parseCustomToolOutput)
    const output = JSON.stringify({ output: "done", metadata: { exit_code: 0 } })
    expect(facadeParseCustomToolOutput(output)).toEqual(parseCustomToolOutput(output))
  })
})

describe("inferToolError", () => {
  it("honors explicit process exit codes", () => {
    expect(inferToolError("Process exited with code 0\nerror appears in a successful log")).toBe(false)
    expect(inferToolError("Process exited with code 17")).toBe(true)
  })

  it("ignores explicit zero-error summaries", () => {
    expect(inferToolError("0 failed, 0 errors, no failures and no errors")).toBe(false)
  })

  it("detects error terms and treats empty output as successful", () => {
    expect(inferToolError("Unhandled exception while applying change")).toBe(true)
    expect(inferToolError(null)).toBe(false)
    expect(inferToolError("")).toBe(false)
  })
})

describe("normalizePlanToTodos", () => {
  it("maps valid plan items and filters non-object entries", () => {
    expect(normalizePlanToTodos({
      plan: [
        { step: "Inspect", status: "completed" },
        null,
        "invalid",
        { step: 42, status: 7 },
      ],
    })).toEqual({
      todos: [
        { content: "Inspect", status: "completed", activeForm: "Inspect" },
        { content: "", status: "pending", activeForm: "" },
      ],
    })
  })

  it("returns an empty todo list for malformed plan input", () => {
    expect(normalizePlanToTodos({ plan: "not-an-array" })).toEqual({ todos: [] })
    expect(normalizePlanToTodos({})).toEqual({ todos: [] })
  })
})

describe("parseCustomToolOutput boundaries", () => {
  it("concatenates text from structured content and ignores malformed blocks", () => {
    expect(parseCustomToolOutput([
      { type: "text", text: "first " },
      null,
      { type: "image", source: "ignored" },
      { type: "text", text: "second" },
    ])).toEqual({ text: "first second", isError: false })
  })

  it("uses structured exit metadata instead of words in the output", () => {
    expect(parseCustomToolOutput(JSON.stringify({
      output: "error appears in a successful diagnostic",
      metadata: { exit_code: 0 },
    }))).toEqual({ text: "error appears in a successful diagnostic", isError: false })
    expect(parseCustomToolOutput(JSON.stringify({
      output: "no diagnostic text",
      metadata: { exit_code: 2 },
    }))).toEqual({ text: "no diagnostic text", isError: true })
  })

  it("falls back safely for malformed JSON and unsupported values", () => {
    expect(parseCustomToolOutput("{ malformed error")).toEqual({
      text: "{ malformed error",
      isError: true,
    })
    expect(parseCustomToolOutput({ output: "not directly supported" })).toEqual({
      text: "",
      isError: false,
    })
    expect(parseCustomToolOutput(undefined)).toEqual({ text: "", isError: false })
  })
})
