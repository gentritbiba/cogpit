import { describe, it, expect, afterEach } from "vitest"
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

describe("buildQueryOptions with partial messages", () => {
  const origEnv = process.env.COGPIT_STREAM_PARTIAL

  afterEach(() => {
    if (origEnv === undefined) delete process.env.COGPIT_STREAM_PARTIAL
    else process.env.COGPIT_STREAM_PARTIAL = origEnv
  })

  it("includePartialMessages is true by default", async () => {
    delete process.env.COGPIT_STREAM_PARTIAL
    const { buildQueryOptionsForTest } = await import("../sdk-session")
    const state = initSDKSessionState({ sessionId: "s1", cwd: "/tmp", message: "hi" })
    const opts = buildQueryOptionsForTest(state, {})
    expect(opts.includePartialMessages).toBe(true)
  })

  it("includePartialMessages is false when COGPIT_STREAM_PARTIAL=0", async () => {
    process.env.COGPIT_STREAM_PARTIAL = "0"
    const { buildQueryOptionsForTest } = await import("../sdk-session")
    const state = initSDKSessionState({ sessionId: "s2", cwd: "/tmp", message: "hi" })
    const opts = buildQueryOptionsForTest(state, {})
    expect(opts.includePartialMessages).toBe(false)
  })

  it("includePartialMessages is false when COGPIT_STREAM_PARTIAL=false", async () => {
    process.env.COGPIT_STREAM_PARTIAL = "false"
    const { buildQueryOptionsForTest } = await import("../sdk-session")
    const state = initSDKSessionState({ sessionId: "s3", cwd: "/tmp", message: "hi" })
    const opts = buildQueryOptionsForTest(state, {})
    expect(opts.includePartialMessages).toBe(false)
  })

  it("includePartialMessages is false when COGPIT_STREAM_PARTIAL=OFF (case-insensitive)", async () => {
    process.env.COGPIT_STREAM_PARTIAL = "OFF"
    const { buildQueryOptionsForTest } = await import("../sdk-session")
    const state = initSDKSessionState({ sessionId: "s4", cwd: "/tmp", message: "hi" })
    const opts = buildQueryOptionsForTest(state, {})
    expect(opts.includePartialMessages).toBe(false)
  })

  it("includePartialMessages is false when COGPIT_STREAM_PARTIAL='  no  ' (whitespace trimmed)", async () => {
    process.env.COGPIT_STREAM_PARTIAL = "  no  "
    const { buildQueryOptionsForTest } = await import("../sdk-session")
    const state = initSDKSessionState({ sessionId: "s5", cwd: "/tmp", message: "hi" })
    const opts = buildQueryOptionsForTest(state, {})
    expect(opts.includePartialMessages).toBe(false)
  })

  it("includePartialMessages stays true for truthy-ish values like 'true'", async () => {
    process.env.COGPIT_STREAM_PARTIAL = "true"
    const { buildQueryOptionsForTest } = await import("../sdk-session")
    const state = initSDKSessionState({ sessionId: "s6", cwd: "/tmp", message: "hi" })
    const opts = buildQueryOptionsForTest(state, {})
    expect(opts.includePartialMessages).toBe(true)
  })

  it("includePartialMessages is true when COGPIT_STREAM_PARTIAL is empty string", async () => {
    process.env.COGPIT_STREAM_PARTIAL = ""
    const { buildQueryOptionsForTest } = await import("../sdk-session")
    const state = initSDKSessionState({ sessionId: "s7", cwd: "/tmp", message: "hi" })
    const opts = buildQueryOptionsForTest(state, {})
    expect(opts.includePartialMessages).toBe(true)
  })
})
