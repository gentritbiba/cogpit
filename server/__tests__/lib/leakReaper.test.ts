import { describe, expect, it } from "vitest"

import { planReaping, type PendingOrphan } from "../../lib/leakReaper"
import type { OrphanedClaudeSubtree } from "../../lib/systemProcesses"

const HOUR = 3600
const MIN_AGE = 30 * 60

function subtree(overrides: Partial<OrphanedClaudeSubtree> = {}): OrphanedClaudeSubtree {
  return {
    rootPid: 100,
    command: "claude",
    ageSeconds: 2 * HOUR,
    pids: [100, 101, 102],
    ...overrides,
  }
}

describe("planReaping", () => {
  it("does not kill on first sighting — only records the orphan as pending", () => {
    const { toKill, nextPending } = planReaping([subtree()], new Map(), {
      minAgeSeconds: MIN_AGE,
      now: 1000,
    })
    expect(toKill).toEqual([])
    expect(nextPending.get(100)).toMatchObject({ command: "claude", firstSeenAt: 1000 })
  })

  it("kills the whole subtree on second sighting when old enough", () => {
    const pending = new Map<number, PendingOrphan>([
      [100, { firstSeenAt: 0, command: "claude" }],
    ])
    const { toKill, nextPending } = planReaping([subtree()], pending, {
      minAgeSeconds: MIN_AGE,
      now: 600_000,
    })
    expect(toKill).toHaveLength(1)
    expect(toKill[0].pids).toEqual([100, 101, 102])
    expect(nextPending.has(100)).toBe(false)
  })

  it("keeps young orphans pending instead of killing them", () => {
    const pending = new Map<number, PendingOrphan>([
      [100, { firstSeenAt: 0, command: "claude" }],
    ])
    const { toKill, nextPending } = planReaping(
      [subtree({ ageSeconds: 15 * 60 })],
      pending,
      { minAgeSeconds: MIN_AGE, now: 600_000 },
    )
    expect(toKill).toEqual([])
    expect(nextPending.get(100)).toMatchObject({ firstSeenAt: 0 })
  })

  it("treats a command mismatch as a new process (pid reuse guard)", () => {
    const pending = new Map<number, PendingOrphan>([
      [100, { firstSeenAt: 0, command: "claude --old-flags" }],
    ])
    const { toKill, nextPending } = planReaping([subtree()], pending, {
      minAgeSeconds: MIN_AGE,
      now: 600_000,
    })
    expect(toKill).toEqual([])
    expect(nextPending.get(100)).toMatchObject({ command: "claude", firstSeenAt: 600_000 })
  })

  it("prunes pending entries whose process disappeared", () => {
    const pending = new Map<number, PendingOrphan>([
      [999, { firstSeenAt: 0, command: "claude" }],
    ])
    const { nextPending } = planReaping([], pending, { minAgeSeconds: MIN_AGE, now: 600_000 })
    expect(nextPending.size).toBe(0)
  })
})
