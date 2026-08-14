import { describe, expect, it } from "vitest"
import { getSessionConfigKey } from "../sessionConfig"

describe("getSessionConfigKey", () => {
  it("preserves the historical Claude session key", () => {
    expect(getSessionConfigKey("session-123", "session-123.jsonl"))
      .toBe("session-123.jsonl")
  })

  it("uses a stable ID instead of a nested Codex rollout path", () => {
    expect(getSessionConfigKey(
      "019fed86-c462-7f02-8d0b-e41485ff40b9",
      "2026/08/10/rollout-2026-08-10T23-14-20-019fed86-c462-7f02-8d0b-e41485ff40b9.jsonl",
    )).toBe("019fed86-c462-7f02-8d0b-e41485ff40b9.jsonl")
  })

  it("falls back to the file name before session parsing finishes", () => {
    expect(getSessionConfigKey(null, "pending.jsonl")).toBe("pending.jsonl")
    expect(getSessionConfigKey(null, null)).toBeNull()
  })
})
