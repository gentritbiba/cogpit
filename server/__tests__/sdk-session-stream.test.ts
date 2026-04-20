import { describe, it, expect } from "vitest"
import { EventEmitter } from "node:events"
import { initSDKSessionState } from "../sdk-session"

describe("SDKSessionState streaming", () => {
  it("initSDKSessionState sets up a streamEmitter", () => {
    const state = initSDKSessionState({
      sessionId: "test-session",
      cwd: "/tmp",
      message: "hi",
    })
    expect(state.streamEmitter).toBeInstanceOf(EventEmitter)
  })

  it("streamEmitter starts with no listeners", () => {
    const state = initSDKSessionState({
      sessionId: "test-session-2",
      cwd: "/tmp",
      message: "hi",
    })
    expect(state.streamEmitter.listenerCount("stream_event")).toBe(0)
  })
})
