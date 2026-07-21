import { describe, expect, expectTypeOf, it } from "vitest"
import { CODEX_CLIENT_CAPABILITIES as facadeCapabilities } from "../codex-app-server"
import type * as Facade from "../codex-app-server"
import {
  normalizeAvailableDecisions,
  wireApprovalDecision,
} from "../codex-approval-codec"
import {
  CODEX_CLIENT_CAPABILITIES as protocolCapabilities,
  COMMAND_APPROVAL_METHOD,
  CURRENT_TIME_METHOD,
  FILE_APPROVAL_METHOD,
} from "../codex-app-server-protocol"
import type * as Protocol from "../codex-app-server-protocol"

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
      currentTime: CURRENT_TIME_METHOD,
    }).toEqual({
      command: "item/commandExecution/requestApproval",
      file: "item/fileChange/requestApproval",
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
    expectTypeOf<Facade.ApprovalListener>().toEqualTypeOf<Protocol.ApprovalListener>()
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
