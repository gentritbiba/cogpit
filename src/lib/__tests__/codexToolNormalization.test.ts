import { describe, expect, it } from "vitest"
import { parseCustomToolOutput as facadeParseCustomToolOutput } from "../../../shared/session/codex"
import {
  hasFailedExit,
  isCodexQuestionTool,
  normalizeFunctionName,
  normalizePlanToTodos,
  normalizeQuestions,
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

describe("hasFailedExit", () => {
  it("honors explicit process exit codes", () => {
    expect(hasFailedExit("Process exited with code 0\nerror appears in a successful log")).toBe(false)
    expect(hasFailedExit("Process exited with code 17")).toBe(true)
  })

  it("ignores error words in whatever the command printed", () => {
    expect(hasFailedExit("throw new Error('Invalid tenant slug')")).toBe(false)
    expect(hasFailedExit("Unhandled exception while applying change")).toBe(false)
    expect(hasFailedExit(null)).toBe(false)
    expect(hasFailedExit("")).toBe(false)
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
      isError: false,
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

  it("reads exit codes out of chunked exec results", () => {
    const status = (text: string) => ({ type: "input_text", text })
    const chunk = (exit: number, output: string) =>
      status(JSON.stringify({ chunk_id: "4b6add", exit_code: exit, output }))

    expect(parseCustomToolOutput([
      status("Script completed\nWall time 0.1 seconds\nOutput:\n"),
      chunk(0, "throw new Error('Invalid tenant slug for preview URL')"),
    ]).isError).toBe(false)
    expect(parseCustomToolOutput([
      status("Script completed\nWall time 0.1 seconds\nOutput:\n"),
      chunk(0, "first chunk"),
      chunk(1, "zsh: no matches found: src/env*"),
    ]).isError).toBe(true)
    expect(parseCustomToolOutput([
      status("Script completed\nWall time 1.6 seconds\nOutput:\n"),
      status(JSON.stringify({ status: "fulfilled", value: { exit_code: 0, output: "ok" } })),
      status(JSON.stringify({ status: "rejected", reason: "boom" })),
    ]).isError).toBe(true)
  })

  it("fails a script that threw and passes one that returned plain data", () => {
    const result = (...texts: string[]) => texts.map((text) => ({ type: "input_text", text }))
    expect(parseCustomToolOutput(result(
      "Script failed\nWall time 0.0 seconds\nOutput:\n",
      "Script error:\nSyntaxError: Unexpected string",
    )).isError).toBe(true)
    expect(parseCustomToolOutput(result(
      "Script completed\nWall time 0.4 seconds\nOutput:\n",
      "<div class=\"error\">Cached page copy</div>",
    )).isError).toBe(false)
    expect(parseCustomToolOutput(result("Script completed\nWall time 0.0 seconds\nOutput:\n")).isError).toBe(false)
  })

  it("keeps a domain status field from posing as a settled chunk", () => {
    expect(parseCustomToolOutput([
      { type: "input_text", text: "Script completed\nWall time 0.2 seconds\nOutput:\n" },
      { type: "input_text", text: JSON.stringify({ status: "ambiguous", message: "Found 2 symbols" }) },
    ]).isError).toBe(false)
  })

  it("keeps ordinary JSON results intact", () => {
    const output = JSON.stringify({ agent_id: "agent-1", nickname: "reviewer" })
    expect(parseCustomToolOutput(output)).toEqual({ text: output, isError: false })
  })
})

describe("normalizeQuestions", () => {
  it("renames Codex's title to the question field the card renders", () => {
    expect(normalizeQuestions({
      questions: [{ title: "What is your budget?", options: null }],
    })).toEqual({
      questions: [{ question: "What is your budget?", options: [] }],
    })
  })

  it("promotes bare option labels to labelled options", () => {
    expect(normalizeQuestions({
      questions: [{ title: "Include it?", options: ["Ship it", "Wait"] }],
    })).toEqual({
      questions: [{
        question: "Include it?",
        options: [{ label: "Ship it" }, { label: "Wait" }],
      }],
    })
  })

  it("keeps already-normalized questions, headers and descriptions", () => {
    expect(normalizeQuestions({
      questions: [{
        question: "Which theme?",
        header: "Theme",
        options: [{ label: "Dark", description: "Low light" }],
      }],
    })).toEqual({
      questions: [{
        question: "Which theme?",
        header: "Theme",
        options: [{ label: "Dark", description: "Low light" }],
      }],
    })
  })

  it("reads a lone question given without the questions wrapper", () => {
    expect(normalizeQuestions({ title: "Ready?" })).toEqual({
      title: "Ready?",
      questions: [{ question: "Ready?", options: [] }],
    })
  })

  it("leaves input untouched when nothing carries question text", () => {
    expect(normalizeQuestions({ questions: [{ options: ["A"] }] }))
      .toEqual({ questions: [{ options: ["A"] }] })
  })
})

describe("isCodexQuestionTool", () => {
  it.each([
    ["request_user_input", true],
    ["request_user_input_async", true],
    ["exec_command", false],
    ["AskUserQuestion", false],
  ])("reports %s as %s", (name, expected) => {
    expect(isCodexQuestionTool(name)).toBe(expected)
  })
})
