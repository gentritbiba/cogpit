import { useMemo } from "react"
import type { ParsedSession } from "@/lib/types"

export interface TodoItem {
  content: string
  status: "pending" | "in_progress" | "completed"
  activeForm: string
}

export interface TodoProgress {
  todos: TodoItem[]
  completed: number
  total: number
  inProgress: TodoItem | null
}

/**
 * Extracts the latest TodoWrite state from a session's tool calls.
 * Returns null if the session has no TodoWrite calls.
 */
export function useTodoProgress(session: ParsedSession | null): TodoProgress | null {
  return useMemo(() => {
    if (!session) return null

    // Find the last TodoWrite tool call (it contains the full current state)
    let lastTodos: TodoItem[] | null = null

    for (let i = session.turns.length - 1; i >= 0; i--) {
      const turn = session.turns[i]
      for (let j = turn.toolCalls.length - 1; j >= 0; j--) {
        const tc = turn.toolCalls[j]
        if (tc.name === "TodoWrite") {
          const input = tc.input as { todos?: TodoItem[] }
          if (Array.isArray(input.todos)) {
            lastTodos = input.todos
          }
          break
        }
      }
      if (lastTodos) break
    }

    if (!lastTodos || lastTodos.length === 0) return null

    const completed = lastTodos.filter((t) => t.status === "completed").length
    const inProgress = lastTodos.find((t) => t.status === "in_progress") ?? null

    return {
      todos: lastTodos,
      completed,
      total: lastTodos.length,
      inProgress,
    }
  }, [session])
}
