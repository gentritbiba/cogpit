import { describe, expect, it } from "vitest"
import type { CommandReceipt } from "../../../shared/contracts/orchestration"
import { fetchWithModelFallback } from "../agents/modelFallback"

const receipt: CommandReceipt = { id: "accepted-command", conversationId: "conversation", sessionId: "native", bindingRevision: 1, state: "queued", intent: "queue", createdAt: 1, updatedAt: 1, position: 1 }
const options = { model: undefined, agentKind: "claude", errorFallback: "Failed" }

describe("accepted command model fallback", () => {
  it("returns the accepted receipt so the timeline can show it from the queue", async () => {
    const accepted = await fetchWithModelFallback(async () => new Response(JSON.stringify({ receipt }), { status: 202 }), options)
    expect(accepted.receipt).toEqual(receipt)
    expect((await fetchWithModelFallback(async () => new Response("{}", { status: 200 }), options)).receipt).toBeNull()
  })
})
