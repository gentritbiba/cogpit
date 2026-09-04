import { describe, expect, it } from "vitest"
import { parseCustomToolOutput as facadeParseCustomToolOutput } from "../../../shared/session/codex"
import {
  inferToolError,
  normalizeFunctionName,
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

describe("normalizeFunctionName", () => {
  it.each([
    ["functions.exec_command", "exec_command"],
    ["functions__update_plan", "update_plan"],
    ["functions/apply_patch", "apply_patch"],
    ["collaboration.spawnAgent", "spawn_agent"],
    ["collaboration:followupTask", "followup_task"],
  ])("normalizes %s to %s", (raw, expected) => {
    expect(normalizeFunctionName(raw)).toBe(expected)
  })

  it("preserves MCP names even when the leaf matches a native tool", () => {
    expect(normalizeFunctionName("mcp__server__exec_command")).toBe("mcp__server__exec_command")
    expect(normalizeFunctionName("mcp__server__spawnAgent")).toBe("mcp__server__spawnAgent")
    expect(normalizeFunctionName("custom.unknown_tool")).toBe("custom.unknown_tool")
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
    expect(parseCustomToolOutput({ output: "structured output" })).toEqual({
      text: "structured output",
      isError: false,
    })
    expect(parseCustomToolOutput(undefined)).toEqual({ text: "", isError: false })
  })

  it("preserves Claude, MCP, and data URL images without printing their payloads", () => {
    const images = [
      { type: "image", source: { type: "base64", media_type: "image/png", data: "claude-pixels" } },
      { type: "image", source: { type: "base64", media_type: "image/jpeg", data: "mcp-pixels" } },
      { type: "image", source: { type: "base64", media_type: "image/webp", data: "codex-pixels" } },
    ]
    expect(parseCustomToolOutput([
      { type: "text", text: "Preview" },
      images[0],
      { type: "image", mimeType: "image/jpeg", data: "mcp-pixels" },
      { type: "input_image", image_url: "data:image/webp;base64,codex-pixels" },
      { type: "image", source: { type: "base64", media_type: "image/png", data: "" } },
    ])).toEqual({ text: "Preview", images, isError: false })
  })

  it.each([false, true])("reads content envelopes serialized=%s", (serialized) => {
    const envelope = {
      content: [
        { type: "text", text: "Error-handling reference" },
        { type: "image", mimeType: "image/png", data: "pixels" },
      ],
      isError: false,
    }
    expect(parseCustomToolOutput(serialized ? JSON.stringify(envelope) : envelope)).toEqual({
      text: "Error-handling reference",
      images: [{ type: "image", source: { type: "base64", media_type: "image/png", data: "pixels" } }],
      isError: false,
    })
  })

  it("honors explicit errors and top-level exit codes", () => {
    expect(parseCustomToolOutput({ content: [], isError: true })).toEqual({ text: "", isError: true })
    expect(parseCustomToolOutput({ output: "No matching resource", is_error: true })).toEqual({ text: "No matching resource", isError: true })
    expect(parseCustomToolOutput({ output: "error in diagnostic sample", exit_code: 0 })).toEqual({ text: "error in diagnostic sample", isError: false })
    expect(parseCustomToolOutput({ output: "Stopped", exit_code: 2 })).toEqual({ text: "Stopped", isError: true })
  })

  it("keeps ordinary JSON results intact", () => {
    const output = JSON.stringify({ agent_id: "agent-1", nickname: "reviewer" })
    expect(parseCustomToolOutput(output)).toEqual({ text: output, isError: false })
  })
})
