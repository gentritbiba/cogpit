// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { forwardCodexStreamNotification } from "../../lib/codexStreamAdapter"
import {
  _resetForTests,
  getSnapshot,
  isCompacting,
  subscribe,
  type StreamBusEvent,
} from "../../lib/streamBus"

const THREAD_ID = "019fff00-1111-7222-8333-444444444444"

beforeEach(() => {
  vi.useFakeTimers()
  _resetForTests()
})

afterEach(() => {
  vi.useRealTimers()
})

describe("forwardCodexStreamNotification", () => {
  it("accumulates agent-message deltas under the Codex thread and item ids", () => {
    forwardCodexStreamNotification({
      method: "item/agentMessage/delta",
      params: { threadId: THREAD_ID, turnId: "turn-1", itemId: "msg_1", delta: "**live" },
    })
    forwardCodexStreamNotification({
      method: "item/agentMessage/delta",
      params: { threadId: THREAD_ID, turnId: "turn-1", itemId: "msg_1", delta: "** text" },
    })

    expect(getSnapshot(THREAD_ID)).toEqual([
      {
        messageId: "msg_1",
        parentToolUseId: null,
        stopped: false,
        blocks: [{ index: 0, blockType: "text", text: "**live** text" }],
      },
    ])
  })

  it("removes completed messages from late-subscriber snapshots", () => {
    forwardCodexStreamNotification({
      method: "item/agentMessage/delta",
      params: { threadId: THREAD_ID, turnId: "turn-1", itemId: "msg_1", delta: "done" },
    })
    forwardCodexStreamNotification({
      method: "item/completed",
      params: {
        threadId: THREAD_ID,
        turnId: "turn-1",
        item: { type: "agentMessage", id: "msg_1", text: "done" },
      },
    })

    expect(getSnapshot(THREAD_ID)).toBeNull()
  })

  it("clears the browser overlay when the Codex turn completes", () => {
    const events: StreamBusEvent[] = []
    subscribe(THREAD_ID, (event) => events.push(event))
    forwardCodexStreamNotification({
      method: "item/agentMessage/delta",
      params: { threadId: THREAD_ID, turnId: "turn-1", itemId: "msg_1", delta: "done" },
    })

    forwardCodexStreamNotification({
      method: "turn/completed",
      params: { threadId: THREAD_ID, turn: { id: "turn-1", status: "completed" } },
    })

    expect(events).toContainEqual({ type: "stream_clear" })
    expect(getSnapshot(THREAD_ID)).toBeNull()
  })

  // Sequence recorded from Codex 0.163.0, where steering cancels the streamed
  // response: the first message gets no item/completed and is not in the rollout.
  it("drops a response cancelled by a steer once the steer lands in the turn", () => {
    const events: StreamBusEvent[] = []
    subscribe(THREAD_ID, (event) => events.push(event))
    const note = (method: string, params: Record<string, unknown>) =>
      forwardCodexStreamNotification({ method, params: { threadId: THREAD_ID, turnId: "turn-1", ...params } })

    note("item/started", { item: { type: "agentMessage", id: "msg_essay", text: "", phase: "final_answer" } })
    note("item/agentMessage/delta", { itemId: "msg_essay", delta: "Lighthouses have" })
    note("item/agentMessage/delta", { itemId: "msg_essay", delta: " guided ships" })
    note("thread/tokenUsage/updated", {})
    note("item/started", { item: { type: "userMessage", id: "steer-1", content: [{ type: "text", text: "Stop" }] } })

    expect(getSnapshot(THREAD_ID)).toBeNull()
    expect(events.at(-1)).toEqual({ type: "stream_clear" })

    note("item/completed", { item: { type: "userMessage", id: "steer-1", content: [{ type: "text", text: "Stop" }] } })
    note("item/started", { item: { type: "commandExecution", id: "exec-1" } })
    note("item/completed", { item: { type: "commandExecution", id: "exec-1" } })
    note("item/started", { item: { type: "agentMessage", id: "msg_reply", text: "", phase: "final_answer" } })
    note("item/agentMessage/delta", { itemId: "msg_reply", delta: "STEERED" })

    expect(getSnapshot(THREAD_ID)).toEqual([
      {
        messageId: "msg_reply",
        parentToolUseId: null,
        stopped: false,
        blocks: [{ index: 0, blockType: "text", text: "STEERED" }],
      },
    ])
  })

  it("tracks a context compaction item from start to completion", () => {
    const events: StreamBusEvent[] = []
    subscribe(THREAD_ID, (event) => events.push(event))

    forwardCodexStreamNotification({
      method: "item/started",
      params: { threadId: THREAD_ID, turnId: "turn-1", item: { type: "contextCompaction", id: "c1" } },
    })
    expect(isCompacting(THREAD_ID)).toBe(true)

    forwardCodexStreamNotification({
      method: "item/completed",
      params: { threadId: THREAD_ID, turnId: "turn-1", item: { type: "contextCompaction", id: "c1" } },
    })
    expect(isCompacting(THREAD_ID)).toBe(false)
    expect(events).toEqual([
      { type: "compacting", active: true },
      { type: "compacting", active: false },
    ])
  })

  it("ignores non-compaction item starts", () => {
    forwardCodexStreamNotification({
      method: "item/started",
      params: { threadId: THREAD_ID, turnId: "turn-1", item: { type: "agentMessage", id: "msg_1", text: "" } },
    })
    expect(isCompacting(THREAD_ID)).toBe(false)
  })
})
