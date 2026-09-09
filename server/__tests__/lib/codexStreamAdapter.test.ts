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

  it("forwards app-server errors to the watching client", () => {
    const events: StreamBusEvent[] = []
    subscribe(THREAD_ID, (event) => events.push(event))

    forwardCodexStreamNotification({
      method: "error",
      params: { threadId: THREAD_ID, error: { message: "response stream disconnected" } },
    })

    expect(events).toContainEqual({
      type: "turn_error",
      message: "response stream disconnected",
    })
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
