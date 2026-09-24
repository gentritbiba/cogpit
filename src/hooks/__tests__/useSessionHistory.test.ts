import { act, renderHook } from "@testing-library/react"
import { beforeEach, describe, expect, it } from "vitest"
import { useSessionHistory } from "@/hooks/useSessionHistory"

const LOST = "00000000-0000-4000-8000-000000000001"
const KEPT = "00000000-0000-4000-8000-000000000002"

describe("useSessionHistory", () => {
  beforeEach(() => localStorage.clear())

  it("forgets every visit to a session, its sub-agents included, and remembers that", () => {
    const { result } = renderHook(() => useSessionHistory())
    act(() => {
      result.current.push("-work", `${LOST}.jsonl`)
      result.current.push("-work", `${KEPT}.jsonl`)
      result.current.push("-work", `${LOST}/subagents/agent-a1.jsonl`)
    })

    act(() => result.current.forget(LOST))

    expect(result.current.goBack()).toBeNull()
    const reloaded = renderHook(() => useSessionHistory())
    act(() => reloaded.result.current.push("-work", `${LOST}.jsonl`))
    expect(reloaded.result.current.goBack()).toEqual({ dirName: "-work", fileName: `${KEPT}.jsonl` })
  })
})
