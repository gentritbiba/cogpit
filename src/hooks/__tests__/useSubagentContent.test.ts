import { describe, it, expect } from "vitest"
import { parseSubagentJsonl } from "@/hooks/useSubagentContent"

function buildSubagentJsonl(messages: Array<Record<string, unknown>>): string {
  return messages.map((m) => JSON.stringify(m)).join("\n")
}

describe("parseSubagentJsonl", () => {
  it("should parse assistant messages with text and thinking", () => {
    const jsonl = buildSubagentJsonl([
      {
        type: "user",
        message: { role: "user", content: "Review this code" },
        timestamp: "2026-03-01T19:00:00Z",
        agentId: "test-agent-1",
      },
      {
        type: "assistant",
        message: {
          role: "assistant",
          model: "claude-opus-4-6",
          id: "msg_001",
          content: [
            { type: "thinking", thinking: "Let me analyze this code", signature: "" },
            { type: "text", text: "**APPROVE** - The code looks good." },
          ],
          usage: { input_tokens: 100, output_tokens: 50 },
        },
        timestamp: "2026-03-01T19:00:01Z",
        agentId: "test-agent-1",
      },
    ])

    const messages = parseSubagentJsonl(jsonl, "test-agent-1")
    expect(messages).toHaveLength(1) // only assistant messages
    expect(messages[0].type).toBe("assistant")
    expect(messages[0].thinking).toEqual(["Let me analyze this code"])
    expect(messages[0].text).toEqual(["**APPROVE** - The code looks good."])
    expect(messages[0].model).toBe("claude-opus-4-6")
    expect(messages[0].agentId).toBe("test-agent-1")
  })

  it("should parse tool_use and match tool_result", () => {
    const jsonl = buildSubagentJsonl([
      {
        type: "assistant",
        message: {
          role: "assistant",
          model: "claude-opus-4-6",
          id: "msg_002",
          content: [
            { type: "text", text: "Let me read the file." },
            {
              type: "tool_use",
              id: "tool_1",
              name: "Read",
              input: { file_path: "/src/index.ts" },
            },
          ],
          usage: { input_tokens: 50, output_tokens: 30 },
        },
        timestamp: "2026-03-01T19:00:00Z",
        agentId: "agent-2",
      },
      {
        type: "user",
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "tool_1",
              content: "export function main() {}",
              is_error: false,
            },
          ],
        },
        timestamp: "2026-03-01T19:00:01Z",
        agentId: "agent-2",
      },
      {
        type: "assistant",
        message: {
          role: "assistant",
          model: "claude-opus-4-6",
          id: "msg_003",
          content: [{ type: "text", text: "The file contains a main function." }],
          usage: { input_tokens: 80, output_tokens: 20 },
        },
        timestamp: "2026-03-01T19:00:02Z",
        agentId: "agent-2",
      },
    ])

    const messages = parseSubagentJsonl(jsonl, "agent-2")
    expect(messages).toHaveLength(2) // two assistant messages

    // First message has the tool call with matched result
    expect(messages[0].text).toEqual(["Let me read the file."])
    expect(messages[0].toolCalls).toHaveLength(1)
    expect(messages[0].toolCalls[0].name).toBe("Read")
    expect(messages[0].toolCalls[0].result).toBe("export function main() {}")
    expect(messages[0].toolCalls[0].isError).toBe(false)

    // Second message has just text
    expect(messages[1].text).toEqual(["The file contains a main function."])
    expect(messages[1].toolCalls).toHaveLength(0)
  })

  it("should handle tool_result with is_error", () => {
    const jsonl = buildSubagentJsonl([
      {
        type: "assistant",
        message: {
          role: "assistant",
          id: "msg_err",
          content: [
            { type: "tool_use", id: "tool_err", name: "Bash", input: { command: "rm -rf /" } },
          ],
          usage: { input_tokens: 10, output_tokens: 10 },
        },
        timestamp: "2026-03-01T19:00:00Z",
        agentId: "err-agent",
      },
      {
        type: "user",
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "tool_err",
              content: "Permission denied",
              is_error: true,
            },
          ],
        },
        timestamp: "2026-03-01T19:00:01Z",
        agentId: "err-agent",
      },
    ])

    const messages = parseSubagentJsonl(jsonl, "err-agent")
    expect(messages).toHaveLength(1)
    expect(messages[0].toolCalls[0].result).toBe("Permission denied")
    expect(messages[0].toolCalls[0].isError).toBe(true)
  })

  it("should skip non-user/assistant messages", () => {
    const jsonl = buildSubagentJsonl([
      { type: "system", message: { content: "system init" } },
      {
        type: "assistant",
        message: {
          role: "assistant",
          id: "msg_only",
          content: [{ type: "text", text: "Hello" }],
          usage: { input_tokens: 5, output_tokens: 5 },
        },
        timestamp: "2026-03-01T19:00:00Z",
        agentId: "a1",
      },
      { type: "progress", data: { type: "something" } },
    ])

    const messages = parseSubagentJsonl(jsonl, "a1")
    expect(messages).toHaveLength(1)
    expect(messages[0].text).toEqual(["Hello"])
  })

  it("should handle malformed lines gracefully", () => {
    const jsonl = "not valid json\n" + JSON.stringify({
      type: "assistant",
      message: {
        role: "assistant",
        id: "msg_ok",
        content: [{ type: "text", text: "Valid" }],
        usage: { input_tokens: 1, output_tokens: 1 },
      },
      timestamp: "2026-03-01T19:00:00Z",
      agentId: "a2",
    })

    const messages = parseSubagentJsonl(jsonl, "a2")
    expect(messages).toHaveLength(1)
    expect(messages[0].text).toEqual(["Valid"])
  })

  it("parses Codex sub-agent apply_patch calls as file edits", () => {
    const patch = [
      "*** Begin Patch",
      "*** Update File: /workspace/src/app.ts",
      "@@",
      "-const value = 1",
      "+const value = 2",
      "*** End Patch",
    ].join("\n")
    const jsonl = buildSubagentJsonl([
      {
        type: "session_meta",
        timestamp: "2026-07-15T10:00:00Z",
        payload: {
          id: "codex-child-session",
          cwd: "/workspace",
          source: { subagent: { thread_spawn: { agent_path: "/root/worker" } } },
          forked_from_id: "codex-parent-session",
        },
      },
      {
        type: "turn_context",
        timestamp: "2026-07-15T10:00:01Z",
        payload: { turn_id: "child-turn", model: "gpt-5", cwd: "/workspace" },
      },
      {
        type: "event_msg",
        timestamp: "2026-07-15T10:00:02Z",
        payload: { type: "user_message", message: "Update the value" },
      },
      {
        type: "response_item",
        timestamp: "2026-07-15T10:00:03Z",
        payload: {
          type: "custom_tool_call",
          status: "completed",
          call_id: "patch-call",
          name: "apply_patch",
          input: patch,
        },
      },
      {
        type: "response_item",
        timestamp: "2026-07-15T10:00:04Z",
        payload: {
          type: "custom_tool_call_output",
          call_id: "patch-call",
          output: JSON.stringify({ output: "Done!", metadata: { exit_code: 0 } }),
        },
      },
    ])

    const messages = parseSubagentJsonl(jsonl, "codex-child-session")

    expect(messages).toHaveLength(1)
    expect(messages[0].agentId).toBe("codex-child-session")
    expect(messages[0].toolCalls).toHaveLength(1)
    expect(messages[0].toolCalls[0]).toMatchObject({
      name: "Edit",
      isError: false,
      input: {
        file_path: "/workspace/src/app.ts",
        old_string: "const value = 1",
        new_string: "const value = 2",
      },
    })
  })
})
