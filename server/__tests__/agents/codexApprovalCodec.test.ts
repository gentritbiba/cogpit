// @vitest-environment node
import { describe, expect, expectTypeOf, it } from "vitest"
import { CODEX_CLIENT_CAPABILITIES as facadeCapabilities } from "../../agents/codexAppServer"
import type * as Facade from "../../agents/codexAppServer"
import {
  mcpToolCallDecisions,
  normalizeAvailableDecisions,
  readTerminalInput,
  wireApprovalDecision,
  wireApprovalResult,
} from "../../agents/codexApprovalCodec"
import {
  CODEX_CLIENT_CAPABILITIES as protocolCapabilities,
  COMMAND_APPROVAL_METHOD,
  CURRENT_TIME_METHOD,
  FILE_APPROVAL_METHOD,
  MCP_ELICITATION_METHOD,
} from "../../agents/codexAppServerProtocol"
import type * as Protocol from "../../agents/codexAppServerProtocol"

function makeApproval(availableDecisions?: unknown): Protocol.PendingApproval {
  return {
    requestId: "approval-1",
    kind: "commandExecution",
    method: "item/commandExecution/requestApproval",
    threadId: "thread-1",
    turnId: "turn-1",
    itemId: "item-1",
    requestedAt: 1,
    availableDecisions: normalizeAvailableDecisions(availableDecisions),
    params: availableDecisions === undefined ? {} : { availableDecisions },
  }
}

describe("Codex app-server protocol facade", () => {
  it("preserves runtime capability identity through the compatibility facade", () => {
    expect(facadeCapabilities).toBe(protocolCapabilities)
  })

  it("keeps the server-request method names as explicit protocol contracts", () => {
    expect({
      command: COMMAND_APPROVAL_METHOD,
      file: FILE_APPROVAL_METHOD,
      elicitation: MCP_ELICITATION_METHOD,
      currentTime: CURRENT_TIME_METHOD,
    }).toEqual({
      command: "item/commandExecution/requestApproval",
      file: "item/fileChange/requestApproval",
      elicitation: "mcpServer/elicitation/request",
      currentTime: "currentTime/read",
    })
  })

  it("preserves every public protocol type through direct re-exports", () => {
    expectTypeOf<Facade.JsonRpcId>().toEqualTypeOf<Protocol.JsonRpcId>()
    expectTypeOf<Facade.JsonObject>().toEqualTypeOf<Protocol.JsonObject>()
    expectTypeOf<Facade.CodexAppServerProcess>().toEqualTypeOf<Protocol.CodexAppServerProcess>()
    expectTypeOf<Facade.CodexAppServerSpawn>().toEqualTypeOf<Protocol.CodexAppServerSpawn>()
    expectTypeOf<Facade.CodexAppServerOptions>().toEqualTypeOf<Protocol.CodexAppServerOptions>()
    expectTypeOf<Facade.CodexNotification>().toEqualTypeOf<Protocol.CodexNotification>()
    expectTypeOf<Facade.CodexNotificationListener>().toEqualTypeOf<Protocol.CodexNotificationListener>()
    expectTypeOf<Facade.PendingApprovalKind>().toEqualTypeOf<Protocol.PendingApprovalKind>()
    expectTypeOf<Facade.ApprovalDecision>().toEqualTypeOf<Protocol.ApprovalDecision>()
    expectTypeOf<Facade.PendingApproval>().toEqualTypeOf<Protocol.PendingApproval>()
    expectTypeOf<Facade.McpToolCallRequest>().toEqualTypeOf<Protocol.McpToolCallRequest>()
    expectTypeOf<Facade.PendingElicitation>().toEqualTypeOf<Protocol.PendingElicitation>()
    expectTypeOf<Facade.ElicitationResponse>().toEqualTypeOf<Protocol.ElicitationResponse>()
    expectTypeOf<Facade.CodexThread>().toEqualTypeOf<Protocol.CodexThread>()
    expectTypeOf<Facade.CodexTurn>().toEqualTypeOf<Protocol.CodexTurn>()
    expectTypeOf<Facade.ThreadStartParams>().toEqualTypeOf<Protocol.ThreadStartParams>()
    expectTypeOf<Facade.ThreadResumeParams>().toEqualTypeOf<Protocol.ThreadResumeParams>()
    expectTypeOf<Facade.UserInput>().toEqualTypeOf<Protocol.UserInput>()
    expectTypeOf<Facade.TurnStartParams>().toEqualTypeOf<Protocol.TurnStartParams>()
    expectTypeOf<Facade.TurnSteerParams>().toEqualTypeOf<Protocol.TurnSteerParams>()
    expectTypeOf<Facade.ThreadGoal>().toEqualTypeOf<Protocol.ThreadGoal>()
    expectTypeOf<Facade.ThreadGoalSetParams>().toEqualTypeOf<Protocol.ThreadGoalSetParams>()
    expectTypeOf<Facade.InitializeResult>().toEqualTypeOf<Protocol.InitializeResult>()
    expectTypeOf<Facade.ThreadResponse>().toEqualTypeOf<Protocol.ThreadResponse>()
    expectTypeOf<Facade.TurnResponse>().toEqualTypeOf<Protocol.TurnResponse>()
    expectTypeOf<Facade.TurnSteerResponse>().toEqualTypeOf<Protocol.TurnSteerResponse>()
    expectTypeOf<Facade.ThreadGoalResponse>().toEqualTypeOf<Protocol.ThreadGoalResponse>()
    expectTypeOf<Facade.ThreadGoalClearResponse>().toEqualTypeOf<Protocol.ThreadGoalClearResponse>()
  })
})

describe("normalizeAvailableDecisions", () => {
  it("uses independent full defaults when the server omits the decision list", () => {
    const first = normalizeAvailableDecisions(undefined)
    const second = normalizeAvailableDecisions(null)

    expect(first).toEqual(["allow", "allow_always", "deny"])
    expect(second).toEqual(first)
    expect(second).not.toBe(first)
  })

  it("maps, deduplicates, and preserves the first UI-decision order", () => {
    expect(normalizeAvailableDecisions([
      "decline",
      "accept",
      "cancel",
      "acceptForSession",
      "accept",
      "acceptWithExecpolicyAmendment",
    ])).toEqual(["deny", "allow", "allow_always"])
  })

  it("rejects malformed decision containers and unsupported decisions", () => {
    expect(normalizeAvailableDecisions("accept")).toEqual([])
    expect(normalizeAvailableDecisions({ accept: true })).toEqual([])
    expect(normalizeAvailableDecisions(["acceptWithNetworkPolicyAmendments"])).toEqual([])
  })
})

describe("wireApprovalDecision", () => {
  it.each([
    ["allow", "accept"],
    ["allow_always", "acceptForSession"],
    ["deny", "decline"],
  ] as const)("uses the legacy %s mapping when no server list is present", (decision, wire) => {
    expect(wireApprovalDecision(makeApproval(), decision)).toBe(wire)
  })

  it("selects only a matching server-offered decision", () => {
    const approval = makeApproval(["accept", "decline"])
    expect(wireApprovalDecision(approval, "allow")).toBe("accept")
    expect(wireApprovalDecision(approval, "deny")).toBe("decline")
    expect(wireApprovalDecision(approval, "allow_always")).toBeUndefined()
  })

  it("preserves cancel when it is the server's first deny representation", () => {
    expect(wireApprovalDecision(makeApproval(["cancel", "decline"]), "deny"))
      .toBe("cancel")
  })

  it("falls back to legacy mapping for malformed server metadata", () => {
    expect(wireApprovalDecision(makeApproval("accept"), "allow")).toBe("accept")
  })
})

describe("MCP tool-call approvals", () => {
  function makeToolCall(persist?: unknown): Protocol.PendingApproval {
    return {
      requestId: "tool-1",
      kind: "mcpToolCall",
      method: "mcpServer/elicitation/request",
      threadId: "thread-1",
      turnId: null,
      requestedAt: 1,
      mcpToolCall: { serverName: "github", message: "Allow?" },
      availableDecisions: mcpToolCallDecisions(persist),
      params: {},
    }
  }

  it.each([
    [undefined, ["allow", "deny"]],
    ["session", ["allow", "allow_always", "deny"]],
    ["always", ["allow", "deny"]],
    [["session", "always"], ["allow", "allow_always", "deny"]],
    [["always"], ["allow", "deny"]],
    [{ session: true }, ["allow", "deny"]],
  ])("offers a session grant only when persist %j names one", (persist, decisions) => {
    expect(mcpToolCallDecisions(persist)).toEqual(decisions)
  })

  it("answers with an elicitation response, remembering only for the session", () => {
    const approval = makeToolCall(["session", "always"])
    expect(wireApprovalResult(approval, "allow")).toEqual({ action: "accept", content: null })
    expect(wireApprovalResult(approval, "allow_always")).toEqual({
      action: "accept",
      content: null,
      _meta: { persist: "session" },
    })
    expect(wireApprovalResult(approval, "deny")).toEqual({ action: "decline" })
  })
})

describe("wireApprovalResult", () => {
  it("wraps a command or file decision, and has no result for one the server did not offer", () => {
    const approval = makeApproval(["accept", "cancel"])
    expect(wireApprovalResult(approval, "allow")).toEqual({ decision: "accept" })
    expect(wireApprovalResult(approval, "deny")).toEqual({ decision: "cancel" })
    expect(wireApprovalResult(approval, "allow_always")).toBeUndefined()
  })
})

describe("readTerminalInput", () => {
  it.each([
    ["write_stdin --session-id 12 y", { processId: "12", input: "y" }],
    ["write_stdin --session-id 12 'echo hi\n'", { processId: "12", input: "echo hi\n" }],
    ["write_stdin --session-id 7 ''", { processId: "7", input: "" }],
    [`write_stdin --session-id 7 "it's \\$HOME"`, { processId: "7", input: "it's $HOME" }],
    ["write_stdin --session-id 7 'a; rm -rf / | b'", { processId: "7", input: "a; rm -rf / | b" }],
  ])("reads the target and input out of %j", (command, expected) => {
    expect(readTerminalInput(command)).toEqual(expected)
  })

  it.each([
    undefined,
    "",
    "npm test",
    "write_stdin --session-id 12",
    "write_stdin --pid 12 y",
    "write_stdin --session-id 12 y; rm -rf /",
    "write_stdin --session-id 12 'unterminated",
  ])("does not guess at %j", (command) => {
    expect(readTerminalInput(command)).toBeNull()
  })
})
