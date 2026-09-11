import { describe, expect, it } from "vitest"

import { recencyBucket } from "../recencyBuckets"

// A Wednesday afternoon, in local time so the day boundaries match the helper's.
const now = new Date(2026, 8, 9, 15, 30).getTime()
const hours = (n: number) => now - n * 3_600_000
const days = (n: number) => now - n * 86_400_000

describe("recencyBucket", () => {
  it("names the day a session was last touched relative to now", () => {
    expect(recencyBucket(new Date(now).toISOString(), now)).toBe("Today")
    expect(recencyBucket(new Date(2026, 8, 9, 0, 5).toISOString(), now)).toBe("Today")
    expect(recencyBucket(new Date(2026, 8, 8, 23, 55).toISOString(), now)).toBe("Yesterday")
    expect(recencyBucket(new Date(hours(20)).toISOString(), now)).toBe("Yesterday")
    expect(recencyBucket(new Date(days(3)).toISOString(), now)).toBe("Last 7 days")
    expect(recencyBucket(new Date(days(12)).toISOString(), now)).toBe("Last 30 days")
    expect(recencyBucket(new Date(days(45)).toISOString(), now)).toBe("Older")
  })

  it("treats a future timestamp as today and an unparsable one as older, matching the sort", () => {
    expect(recencyBucket(new Date(hours(-2)).toISOString(), now)).toBe("Today")
    expect(recencyBucket("not a date", now)).toBe("Older")
  })
})
