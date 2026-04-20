import { describe, it, expect, afterEach } from "vitest"
import { initSDKSessionState, sdkSessions, findSessionByJsonlPath } from "../sdk-session"

describe("findSessionByJsonlPath", () => {
  afterEach(() => sdkSessions.clear())

  it("returns the session whose jsonlPath matches", () => {
    const state = initSDKSessionState({ sessionId: "sid-1", cwd: "/tmp", message: "hi" })
    state.jsonlPath = "/tmp/sessions/abc.jsonl"
    sdkSessions.set("sid-1", state)

    const found = findSessionByJsonlPath("/tmp/sessions/abc.jsonl")
    expect(found).toBe(state)
  })

  it("returns null when no session matches", () => {
    expect(findSessionByJsonlPath("/tmp/nope.jsonl")).toBeNull()
  })
})

describe("SSE stream event forwarding", () => {
  afterEach(() => sdkSessions.clear())

  it("forwards stream_event payloads to res.write as SSE data", async () => {
    // Use a stub SDK state with a real EventEmitter
    const state = initSDKSessionState({ sessionId: "sse-1", cwd: "/tmp", message: "hi" })
    state.jsonlPath = "/tmp/test-sse-session.jsonl"
    sdkSessions.set("sse-1", state)

    // Collect what would be written to SSE
    const writes: string[] = []
    const fakeRes = {
      write: (chunk: string) => writes.push(chunk),
    }

    // Simulate what files-watch.ts will do:
    const onStreamEvent = (payload: unknown) => {
      fakeRes.write(`data: ${JSON.stringify({ type: "stream_event", ...(payload as object) })}\n\n`)
    }
    state.streamEmitter.on("stream_event", onStreamEvent)

    state.streamEmitter.emit("stream_event", {
      event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "abc" } },
      parent_tool_use_id: null,
      ttft_ms: 100,
    })

    expect(writes).toHaveLength(1)
    expect(writes[0]).toContain('"type":"stream_event"')
    expect(writes[0]).toContain('"text":"abc"')
  })
})
