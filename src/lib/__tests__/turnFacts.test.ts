import { describe, expect, it } from "vitest"
import { makeEditToolCall, makeToolCall, makeTurn } from "@/__tests__/fixtures"
import { turnsChangeFiles, workflowCallCount } from "@/lib/turnFacts"

describe("turn facts", () => {
  it("tells whether turns change files, including a sub-agent's edits", () => {
    const plain = makeTurn({ toolCalls: [makeToolCall({ name: "Read" })] })
    expect(turnsChangeFiles([plain], "/project")).toBe(false)
    const edited = makeTurn({ toolCalls: [makeEditToolCall("/project/a.ts", "old", "new")] })
    expect(turnsChangeFiles([plain, edited], "/project")).toBe(true)
  })

  it("counts workflow calls, and a later list of the same turns plus a new one", () => {
    const first = makeTurn({ toolCalls: [makeToolCall({ name: "Workflow" }), makeToolCall({ name: "Bash" })] })
    expect(workflowCallCount([first])).toBe(1)
    const next = makeTurn({ toolCalls: [makeToolCall({ name: "Workflow" })] })
    expect(workflowCallCount([first, next])).toBe(2)
  })
})
