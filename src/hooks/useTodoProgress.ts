import { useMemo } from "react"
import type { ParsedSession } from "@/lib/types"

export interface TodoItem {
  id?: string
  content: string
  status: "pending" | "in_progress" | "completed"
  activeForm: string
  owner?: string
  blockedBy?: string[]
}

export interface TodoProgress {
  todos: TodoItem[]
  completed: number
  total: number
  inProgress: TodoItem | null
}

/**
 * Extracts work progress from both the legacy TodoWrite snapshot and Claude's
 * structured TaskCreate/TaskUpdate tools. Structured tasks are reconstructed
 * chronologically because updates carry a task ID instead of the full list.
 */
export function useTodoProgress(session: ParsedSession | null): TodoProgress | null {
  return useMemo(() => {
    if (!session) return null

    let lastTodos: TodoItem[] | null = null
    const structuredTasks = new Map<string, TodoItem>()
    let createIndex = 0

    for (const turn of session.turns) {
      for (const tc of turn.toolCalls) {
        if (tc.name === "TodoWrite") {
          const input = tc.input as { todos?: TodoItem[] }
          if (Array.isArray(input.todos)) {
            lastTodos = input.todos
          }
          continue
        }

        if (tc.name === "TaskCreate") {
          const input = tc.input as {
            subject?: string
            description?: string
            activeForm?: string
            owner?: string
          }
          createIndex += 1
          const resultId = tc.result?.match(/(?:Task\s*#?|task[_ ]?id["': ]+)(\d+)/i)?.[1]
          const id = resultId ?? String(createIndex)
          structuredTasks.set(id, {
            id,
            content: input.subject || input.description || `Task ${id}`,
            activeForm: input.activeForm || input.subject || `Working on task ${id}`,
            status: "pending",
            owner: input.owner,
          })
          continue
        }

        if (tc.name === "TaskUpdate") {
          const input = tc.input as {
            taskId?: string
            status?: TodoItem["status"] | "deleted"
            subject?: string
            description?: string
            activeForm?: string
            owner?: string
            addBlockedBy?: string[]
          }
          const id = String(input.taskId ?? "")
          if (!id) continue
          if (input.status === "deleted") {
            structuredTasks.delete(id)
            continue
          }
          const current = structuredTasks.get(id) ?? {
            id,
            content: input.subject || input.description || `Task ${id}`,
            activeForm: input.activeForm || input.subject || `Working on task ${id}`,
            status: "pending" as const,
          }
          structuredTasks.set(id, {
            ...current,
            content: input.subject || input.description || current.content,
            activeForm: input.activeForm || current.activeForm,
            status: input.status || current.status,
            owner: input.owner ?? current.owner,
            blockedBy: input.addBlockedBy
              ? [...new Set([...(current.blockedBy ?? []), ...input.addBlockedBy])]
              : current.blockedBy,
          })
        }
      }
    }

    const todos = structuredTasks.size > 0 ? [...structuredTasks.values()] : lastTodos
    if (!todos || todos.length === 0) return null

    const completed = todos.filter((t) => t.status === "completed").length
    const inProgress = todos.find((t) => t.status === "in_progress") ?? null

    return {
      todos,
      completed,
      total: todos.length,
      inProgress,
    }
  }, [session])
}
