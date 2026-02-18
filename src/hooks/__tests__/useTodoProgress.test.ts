import { describe, it, expect } from "vitest"
import { renderHook } from "@testing-library/react"
import { useTodoProgress } from "@/hooks/useTodoProgress"
import type { ParsedSession, Turn, ToolCall } from "@/lib/types"

function makeToolCall(overrides?: Partial<ToolCall>): ToolCall {
  return {
    id: "tc-1",
    name: "Read",
    input: {},
    result: null,
    isError: false,
    timestamp: "",
    ...overrides,
  }
}

function makeTurn(toolCalls: ToolCall[] = []): Turn {
  return {
    id: "turn-1",
    userMessage: "test",
    contentBlocks: [],
    thinking: [],
    assistantText: [],
    toolCalls,
    subAgentActivity: [],
    timestamp: "",
    durationMs: null,
    tokenUsage: null,
    model: null,
  }
}

function makeSession(turns: Turn[]): ParsedSession {
  return {
    sessionId: "test-session",
    version: "1",
    gitBranch: "main",
    cwd: "/test",
    slug: "test",
    model: "claude-3",
    turns,
    stats: {
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalCacheCreationTokens: 0,
      totalCacheReadTokens: 0,
      totalCostUSD: 0,
      toolCallCounts: {},
      errorCount: 0,
      totalDurationMs: 0,
      turnCount: turns.length,
    },
    rawMessages: [],
  }
}

describe("useTodoProgress", () => {
  describe("null/empty cases", () => {
    it("returns null when session is null", () => {
      const { result } = renderHook(() => useTodoProgress(null))
      expect(result.current).toBeNull()
    })

    it("returns null when session has no turns", () => {
      const session = makeSession([])
      const { result } = renderHook(() => useTodoProgress(session))
      expect(result.current).toBeNull()
    })

    it("returns null when no TodoWrite tool calls exist", () => {
      const session = makeSession([
        makeTurn([makeToolCall({ name: "Read" })]),
        makeTurn([makeToolCall({ name: "Write" })]),
      ])
      const { result } = renderHook(() => useTodoProgress(session))
      expect(result.current).toBeNull()
    })

    it("returns null when TodoWrite has empty todos array", () => {
      const session = makeSession([
        makeTurn([
          makeToolCall({
            name: "TodoWrite",
            input: { todos: [] },
          }),
        ]),
      ])
      const { result } = renderHook(() => useTodoProgress(session))
      expect(result.current).toBeNull()
    })

    it("returns null when TodoWrite input has no todos field", () => {
      const session = makeSession([
        makeTurn([
          makeToolCall({
            name: "TodoWrite",
            input: { something: "else" },
          }),
        ]),
      ])
      const { result } = renderHook(() => useTodoProgress(session))
      expect(result.current).toBeNull()
    })
  })

  describe("basic extraction", () => {
    it("extracts todos from the last TodoWrite call", () => {
      const todos = [
        { content: "Task 1", status: "completed" as const, activeForm: "done" },
        { content: "Task 2", status: "pending" as const, activeForm: "todo" },
      ]

      const session = makeSession([
        makeTurn([
          makeToolCall({
            name: "TodoWrite",
            input: { todos },
          }),
        ]),
      ])

      const { result } = renderHook(() => useTodoProgress(session))

      expect(result.current).not.toBeNull()
      expect(result.current!.todos).toEqual(todos)
      expect(result.current!.total).toBe(2)
      expect(result.current!.completed).toBe(1)
    })

    it("uses the last TodoWrite call, not earlier ones", () => {
      const earlyTodos = [
        { content: "Old task", status: "pending" as const, activeForm: "form" },
      ]
      const lateTodos = [
        { content: "New task 1", status: "completed" as const, activeForm: "done" },
        { content: "New task 2", status: "completed" as const, activeForm: "done" },
        { content: "New task 3", status: "in_progress" as const, activeForm: "wip" },
      ]

      const session = makeSession([
        makeTurn([
          makeToolCall({
            name: "TodoWrite",
            input: { todos: earlyTodos },
          }),
        ]),
        makeTurn([
          makeToolCall({
            name: "TodoWrite",
            input: { todos: lateTodos },
          }),
        ]),
      ])

      const { result } = renderHook(() => useTodoProgress(session))

      expect(result.current!.todos).toEqual(lateTodos)
      expect(result.current!.total).toBe(3)
      expect(result.current!.completed).toBe(2)
    })

    it("finds TodoWrite even if it is not the last tool call in the turn", () => {
      const todos = [
        { content: "Task", status: "pending" as const, activeForm: "form" },
      ]

      const session = makeSession([
        makeTurn([
          makeToolCall({
            name: "TodoWrite",
            input: { todos },
          }),
          makeToolCall({ name: "Read" }),
          makeToolCall({ name: "Write" }),
        ]),
      ])

      const { result } = renderHook(() => useTodoProgress(session))

      expect(result.current).not.toBeNull()
      expect(result.current!.todos).toEqual(todos)
    })
  })

  describe("progress counting", () => {
    it("counts all completed items", () => {
      const todos = [
        { content: "A", status: "completed" as const, activeForm: "" },
        { content: "B", status: "completed" as const, activeForm: "" },
        { content: "C", status: "completed" as const, activeForm: "" },
      ]

      const session = makeSession([
        makeTurn([
          makeToolCall({ name: "TodoWrite", input: { todos } }),
        ]),
      ])

      const { result } = renderHook(() => useTodoProgress(session))
      expect(result.current!.completed).toBe(3)
      expect(result.current!.total).toBe(3)
    })

    it("counts zero completed when none are done", () => {
      const todos = [
        { content: "A", status: "pending" as const, activeForm: "" },
        { content: "B", status: "in_progress" as const, activeForm: "" },
      ]

      const session = makeSession([
        makeTurn([
          makeToolCall({ name: "TodoWrite", input: { todos } }),
        ]),
      ])

      const { result } = renderHook(() => useTodoProgress(session))
      expect(result.current!.completed).toBe(0)
    })
  })

  describe("inProgress detection", () => {
    it("returns the in_progress item", () => {
      const todos = [
        { content: "Done", status: "completed" as const, activeForm: "" },
        { content: "WIP", status: "in_progress" as const, activeForm: "working" },
        { content: "Later", status: "pending" as const, activeForm: "" },
      ]

      const session = makeSession([
        makeTurn([
          makeToolCall({ name: "TodoWrite", input: { todos } }),
        ]),
      ])

      const { result } = renderHook(() => useTodoProgress(session))
      expect(result.current!.inProgress).toEqual(todos[1])
    })

    it("returns null when no item is in progress", () => {
      const todos = [
        { content: "Done", status: "completed" as const, activeForm: "" },
        { content: "Pending", status: "pending" as const, activeForm: "" },
      ]

      const session = makeSession([
        makeTurn([
          makeToolCall({ name: "TodoWrite", input: { todos } }),
        ]),
      ])

      const { result } = renderHook(() => useTodoProgress(session))
      expect(result.current!.inProgress).toBeNull()
    })

    it("returns the first in_progress item when multiple exist", () => {
      const todos = [
        { content: "WIP1", status: "in_progress" as const, activeForm: "a" },
        { content: "WIP2", status: "in_progress" as const, activeForm: "b" },
      ]

      const session = makeSession([
        makeTurn([
          makeToolCall({ name: "TodoWrite", input: { todos } }),
        ]),
      ])

      const { result } = renderHook(() => useTodoProgress(session))
      expect(result.current!.inProgress).toEqual(todos[0])
    })
  })

  describe("memoization", () => {
    it("returns same reference for same session object", () => {
      const todos = [
        { content: "Task", status: "pending" as const, activeForm: "" },
      ]
      const session = makeSession([
        makeTurn([
          makeToolCall({ name: "TodoWrite", input: { todos } }),
        ]),
      ])

      const { result, rerender } = renderHook(() => useTodoProgress(session))
      const first = result.current

      rerender()
      expect(result.current).toBe(first)
    })

    it("recomputes when session reference changes", () => {
      const todos1 = [
        { content: "Task 1", status: "pending" as const, activeForm: "" },
      ]
      const todos2 = [
        { content: "Task 1", status: "completed" as const, activeForm: "" },
        { content: "Task 2", status: "pending" as const, activeForm: "" },
      ]

      const session1 = makeSession([
        makeTurn([makeToolCall({ name: "TodoWrite", input: { todos: todos1 } })]),
      ])
      const session2 = makeSession([
        makeTurn([makeToolCall({ name: "TodoWrite", input: { todos: todos2 } })]),
      ])

      const { result, rerender } = renderHook(
        ({ session }) => useTodoProgress(session),
        { initialProps: { session: session1 } }
      )

      expect(result.current!.total).toBe(1)
      expect(result.current!.completed).toBe(0)

      rerender({ session: session2 })

      expect(result.current!.total).toBe(2)
      expect(result.current!.completed).toBe(1)
    })
  })

  describe("complex scenarios", () => {
    it("handles TodoWrite mixed with other tool calls across many turns", () => {
      const session = makeSession([
        makeTurn([
          makeToolCall({ name: "Read" }),
          makeToolCall({
            name: "TodoWrite",
            input: {
              todos: [
                { content: "Step 1", status: "pending" as const, activeForm: "" },
              ],
            },
          }),
        ]),
        makeTurn([
          makeToolCall({ name: "Bash" }),
          makeToolCall({ name: "Write" }),
        ]),
        makeTurn([
          makeToolCall({ name: "Grep" }),
          makeToolCall({
            name: "TodoWrite",
            input: {
              todos: [
                { content: "Step 1", status: "completed" as const, activeForm: "" },
                { content: "Step 2", status: "in_progress" as const, activeForm: "doing" },
                { content: "Step 3", status: "pending" as const, activeForm: "" },
              ],
            },
          }),
          makeToolCall({ name: "Edit" }),
        ]),
        makeTurn([
          makeToolCall({ name: "Read" }),
        ]),
      ])

      const { result } = renderHook(() => useTodoProgress(session))

      // Should use the TodoWrite from turn 3 (last one that has TodoWrite)
      expect(result.current!.total).toBe(3)
      expect(result.current!.completed).toBe(1)
      expect(result.current!.inProgress!.content).toBe("Step 2")
    })

    it("scans from last turn backwards to find TodoWrite", () => {
      // The last TodoWrite is in the first turn, later turns have no TodoWrite
      const todos = [
        { content: "Only task", status: "completed" as const, activeForm: "" },
      ]

      const session = makeSession([
        makeTurn([
          makeToolCall({ name: "TodoWrite", input: { todos } }),
        ]),
        makeTurn([makeToolCall({ name: "Read" })]),
        makeTurn([makeToolCall({ name: "Write" })]),
        makeTurn([makeToolCall({ name: "Bash" })]),
      ])

      const { result } = renderHook(() => useTodoProgress(session))

      expect(result.current!.total).toBe(1)
      expect(result.current!.completed).toBe(1)
    })
  })
})
