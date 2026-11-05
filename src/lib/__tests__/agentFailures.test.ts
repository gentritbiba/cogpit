import { describe, expect, it } from "vitest"
import {
  agentFailureTitle,
  agentNotInstalledIn,
  agentNotInstalledMessage,
  classifyAgentFailure,
} from "../../../shared/session/agentFailures"
import { deriveSessionStatus } from "../../../shared/session/sessionStatus"
import { parseSession } from "../../../shared/session/parser"

const jsonl = (records: object[]) => records.map((record) => JSON.stringify(record)).join("\n")

// The records Claude Code 2.1.318 writes for a first prompt with an invalid key.
const claudeUser = {
  type: "user", uuid: "u1", sessionId: "s1", cwd: "/work", timestamp: "2026-11-04T21:00:00.000Z",
  message: { role: "user", content: "hi" },
}
const claudeSignedOut = {
  type: "assistant", uuid: "a1", sessionId: "s1", timestamp: "2026-11-04T21:00:01.000Z",
  error: "authentication_failed", isApiErrorMessage: true, apiErrorStatus: 401,
  message: {
    id: "9b35512a", model: "<synthetic>", role: "assistant", type: "message",
    stop_reason: "stop_sequence", stop_sequence: "",
    content: [{ type: "text", text: "Invalid API key · Fix external API key" }],
    usage: { input_tokens: 0, output_tokens: 0 },
  },
}

describe("classifyAgentFailure", () => {
  it.each([
    ["Not logged in · Please run /login"],
    ["Invalid API key · Fix external API key"],
    ["unexpected status 401 Unauthorized: Missing bearer or basic authentication in header, url: https://api.openai.com/v1/responses"],
    ["Execution failed: model resolution leaf failed: get_model_list: GenericFailure, Session was not created with authentication info or custom provider"],
    ["Execution failed: InvalidArg, No GitHub OAuth token or Copilot HMAC key provided"],
  ])("recognises a missing login: %s", (message) => {
    expect(classifyAgentFailure(message).reason).toBe("not_signed_in")
  })

  it.each([
    ["Native CLI binary for darwin-arm64 not found. Reinstall @anthropic-ai/claude-agent-sdk without --omit=optional, or set options.pathToClaudeCodeExecutable."],
    ["Claude Code executable not found at /missing/claude. Is options.pathToClaudeCodeExecutable set?"],
    [agentNotInstalledMessage("copilot", "linux")],
  ])("recognises a missing CLI: %s", (message) => {
    expect(classifyAgentFailure(message).reason).toBe("not_installed")
  })

  it("keeps the HTTP status of any other API failure", () => {
    expect(classifyAgentFailure("unexpected status 429 Too Many Requests")).toEqual({
      reason: "http_status", httpStatus: 429, message: "unexpected status 429 Too Many Requests",
    })
    expect(classifyAgentFailure("Overloaded", 529)).toMatchObject({ reason: "http_status", httpStatus: 529 })
    expect(classifyAgentFailure("anything", 401).reason).toBe("not_signed_in")
  })

  it("leaves everything else as it is", () => {
    expect(classifyAgentFailure("The model refused")).toEqual({ reason: "other", message: "The model refused" })
  })
})

describe("what the user is told", () => {
  it("names the agent and the fix for the machine's own platform", () => {
    expect(agentNotInstalledMessage("claude", "darwin")).toBe(
      "Claude Code isn't installed on this computer.\n"
      + "Install it from https://code.claude.com/docs/en/setup, or run: curl -fsSL https://claude.ai/install.sh | bash",
    )
    expect(agentNotInstalledMessage("claude", "win32")).toMatch(/run: irm https:\/\/claude\.ai\/install\.ps1 \| iex$/)
    expect(agentNotInstalledMessage("acp", "darwin")).toBe("ACP agent isn't installed on this computer.")
    expect(agentFailureTitle("codex", { reason: "not_signed_in", message: "401" })).toBe("Codex isn't signed in.")
    expect(agentFailureTitle("copilot", { reason: "other", message: "boom" })).toBe("GitHub Copilot CLI stopped with an error.")
  })

  it("finds the agent a not-installed message is about", () => {
    expect(agentNotInstalledIn(agentNotInstalledMessage("codex", "linux"))).toBe("codex")
    expect(agentNotInstalledIn("Something else broke")).toBeNull()
  })
})

describe("a failed turn ends the session's turn", () => {
  it("Claude: a synthetic sign-in error is a failure, not a turn still thinking", () => {
    expect(deriveSessionStatus([claudeUser, claudeSignedOut])).toEqual({
      status: "completed",
      terminalReason: "authentication_failed",
      failure: { reason: "not_signed_in", message: "Invalid API key · Fix external API key", httpStatus: 401 },
      pendingQueue: 0,
    })
  })

  it("Claude: any API error ends the turn with its own reason", () => {
    const overloaded = { ...claudeSignedOut, error: "overloaded", apiErrorStatus: 529, message: { ...claudeSignedOut.message, content: [{ type: "text", text: "API Error: Overloaded" }] } }
    expect(deriveSessionStatus([claudeUser, overloaded])).toMatchObject({
      status: "completed", terminalReason: "overloaded", failure: { reason: "http_status", httpStatus: 529 },
    })
  })

  it("Claude: a synthetic reply that is not an error ends the turn normally", () => {
    const { isApiErrorMessage: _, error: __, apiErrorStatus: ___, ...plain } = claudeSignedOut
    expect(deriveSessionStatus([claudeUser, { ...plain, message: { ...plain.message, content: [{ type: "text", text: "No response requested." }] } }]))
      .toEqual({ status: "completed", pendingQueue: 0 })
  })

  it("Claude: the session model never reads <synthetic>", () => {
    expect(parseSession(jsonl([claudeUser, claudeSignedOut])).model).toBe("")
  })

  it("Codex: a 401 task_complete is a sign-in failure, told in plain words", () => {
    const records = [
      { type: "session_meta", timestamp: "2026-11-04T21:15:09.896Z", payload: { id: "01a1a86a", cwd: "/work", originator: "cogpit", cli_version: "0.166.0" } },
      { type: "event_msg", timestamp: "2026-11-04T21:15:10.000Z", payload: { type: "task_started", turn_id: "t1" } },
      { type: "response_item", timestamp: "2026-11-04T21:15:10.100Z", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "Add a footer" }] } },
      { type: "event_msg", timestamp: "2026-11-04T21:15:20.000Z", payload: {
        type: "task_complete", turn_id: "t1", last_agent_message: null,
        error: {
          message: "unexpected status 401 Unauthorized: Missing bearer or basic authentication in header, url: https://api.openai.com/v1/responses, cf-ray: a556a26d3aa9341d-PRN",
          codex_error_info: { http_connection_failed: { http_status_code: 401 } },
        },
      } },
    ]
    expect(deriveSessionStatus(records)).toMatchObject({
      status: "completed", terminalReason: "authentication_failed", failure: { reason: "not_signed_in", httpStatus: 401 },
    })
    const turn = parseSession(jsonl(records)).turns.at(-1)!
    expect(turn.assistantText.join("\n")).toBe("Codex isn't signed in.")
  })

  it("Copilot: a session that was not created with authentication info is a sign-in failure", () => {
    expect(deriveSessionStatus([
      { type: "session.start", data: { sessionId: "0b6ed0c2", copilotVersion: "1.0.105" } },
      { type: "session.error", data: { errorType: "query", message: "Execution failed: model resolution leaf failed: get_model_list: GenericFailure, Session was not created with authentication info or custom provider" } },
    ])).toMatchObject({ status: "completed", terminalReason: "authentication_failed", failure: { reason: "not_signed_in" } })
  })
})
