import { describe, it, expect, afterEach } from "vitest"
import { streamingEnabledForTest } from "../sdk-session"

describe("buildQueryOptions with partial messages", () => {
  const origEnv = process.env.COGPIT_STREAM_PARTIAL

  afterEach(() => {
    if (origEnv === undefined) delete process.env.COGPIT_STREAM_PARTIAL
    else process.env.COGPIT_STREAM_PARTIAL = origEnv
  })

  it("includePartialMessages is true by default", () => {
    delete process.env.COGPIT_STREAM_PARTIAL
    expect(streamingEnabledForTest()).toBe(true)
  })

  it("includePartialMessages is false when COGPIT_STREAM_PARTIAL=0", () => {
    process.env.COGPIT_STREAM_PARTIAL = "0"
    expect(streamingEnabledForTest()).toBe(false)
  })

  it("includePartialMessages is false when COGPIT_STREAM_PARTIAL=false", () => {
    process.env.COGPIT_STREAM_PARTIAL = "false"
    expect(streamingEnabledForTest()).toBe(false)
  })

  it("includePartialMessages is false when COGPIT_STREAM_PARTIAL=OFF (case-insensitive)", () => {
    process.env.COGPIT_STREAM_PARTIAL = "OFF"
    expect(streamingEnabledForTest()).toBe(false)
  })

  it("includePartialMessages is false when COGPIT_STREAM_PARTIAL='  no  ' (whitespace trimmed)", () => {
    process.env.COGPIT_STREAM_PARTIAL = "  no  "
    expect(streamingEnabledForTest()).toBe(false)
  })

  it("includePartialMessages stays true for truthy-ish values like 'true'", () => {
    process.env.COGPIT_STREAM_PARTIAL = "true"
    expect(streamingEnabledForTest()).toBe(true)
  })

  it("includePartialMessages is true when COGPIT_STREAM_PARTIAL is empty string", () => {
    process.env.COGPIT_STREAM_PARTIAL = ""
    expect(streamingEnabledForTest()).toBe(true)
  })
})
