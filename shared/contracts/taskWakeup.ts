import type { DelegatedTask } from "./orchestration"

/**
 * The prompt that wakes a parent session when a session it delegated to
 * finishes. The parent agent reads it as text; the timeline reads it back.
 */
export interface TaskWakeup {
  taskId: string
  state: DelegatedTask["state"]
  childSessionId: string
  /** The child's session result, or the raw text when it was cut to fit. */
  result: unknown
}

const RESULT_LIMIT = 24000
const WAKEUP_RE = /^Delegated task (\S+) (running|completed|error|cancelled)\. Child session: (\S+)\. Result: ([\s\S]*)\nAcknowledge receipt with cogpit-session tasks \S+ --ack \S+\.$/
const WAKEUP_START_RE = /^Delegated task \S+ (?:running|completed|error|cancelled)\. Child session: /

export function formatTaskWakeup(task: Pick<DelegatedTask, "id" | "parentSessionId" | "childSessionId" | "state" | "result">): string {
  return `Delegated task ${task.id} ${task.state}. Child session: ${task.childSessionId}. Result: ${JSON.stringify(task.result ?? null).slice(0, RESULT_LIMIT)}\nAcknowledge receipt with cogpit-session tasks ${task.parentSessionId} --ack ${task.id}.`
}

export function parseTaskWakeup(text: string): TaskWakeup | null {
  const match = WAKEUP_RE.exec(text.trim())
  if (!match) return null
  const [, taskId, state, childSessionId, raw] = match as unknown as [string, string, TaskWakeup["state"], string, string]
  let result: unknown = raw
  try { result = JSON.parse(raw) } catch { /* cut at the limit; keep the text */ }
  return { taskId, state, childSessionId, result }
}

/** Whether a prompt, possibly cut short, is a wakeup rather than something a person wrote. */
export function isTaskWakeup(text: string): boolean {
  return WAKEUP_START_RE.test(text.trim())
}
