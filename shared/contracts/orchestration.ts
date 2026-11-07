import type { AgentKind } from "../session/agent-descriptors"

export type CommandState = "queued" | "held" | "dispatching" | "delivered" | "completed" | "failed" | "cancelled" | "unknown"
export type CommandIntent = "queue" | "steer" | "restart"

export interface NativeBinding {
  hostId: string
  agent: AgentKind
  instanceId: string
  sessionId: string
  nativeSessionId?: string
  filePath?: string | null
  cwd?: string
}

export interface Conversation {
  id: string
  revision: number
  binding: NativeBinding
  createdAt: number
  updatedAt: number
}

export interface CommandReceipt {
  id: string
  conversationId: string
  sessionId: string
  bindingRevision: number
  state: CommandState
  intent: CommandIntent
  message?: string
  createdAt: number
  updatedAt: number
  position: number
  delivery?: "started" | "enqueued" | "steered"
  nativeMessageId?: string
  turnId?: string
  error?: string
  errorCode?: string
  replaces?: string
  questionId?: string
}

export interface ConversationEvent {
  sequence: number
  conversationId: string
  type: "command" | "binding" | "question" | "task"
  createdAt: number
  data: unknown
}

export interface EventPage {
  events: ConversationEvent[]
  cursor: number
  reset: boolean
  hasMore: boolean
}

export interface DelegatedTask {
  id: string
  parentSessionId: string
  childSessionId: string
  sourceId: string
  state: "running" | "completed" | "error" | "cancelled"
  createdAt: number
  updatedAt: number
  result?: unknown
  acknowledgedAt?: number
  wakeupCommandId?: string
  deliveryDisposition?: "blocking" | "async"
  blockingDeadline?: number
  /** The follow-up message this task tracks; absent for the task that started the child. */
  commandId?: string
  /** Requests and stuck deliveries the parent has already been told about. */
  notified?: string[]
}

/** Where a delegated task stands, without its result: what readers that only count or place tasks need. */
export type DelegatedTaskState = Pick<DelegatedTask, "id" | "parentSessionId" | "childSessionId" | "state" | "createdAt" | "updatedAt" | "acknowledgedAt">

/**
 * `GET /api/delegated-tasks?sessionId=<id>&view=counts`: the tasks a session
 * handed out, counted. Unread tasks are neither acknowledged nor cancelled.
 * Answers with a weak ETag; send it back as `If-None-Match` for a 304.
 */
export interface DelegatedTaskCounts {
  total: number
  running: number
  unread: number
  unreadRunning: number
}

export const isUnreadTask = (task: Pick<DelegatedTask, "state" | "acknowledgedAt">) => !task.acknowledgedAt && task.state !== "cancelled"

export function countDelegatedTasks(tasks: Iterable<Pick<DelegatedTask, "state" | "acknowledgedAt">>): DelegatedTaskCounts {
  const counts = { total: 0, running: 0, unread: 0, unreadRunning: 0 }
  for (const task of tasks) {
    const running = task.state === "running"
    const unread = isUnreadTask(task)
    counts.total++
    if (running) counts.running++
    if (unread) counts.unread++
    if (unread && running) counts.unreadRunning++
  }
  return counts
}

export interface ProviderInstance {
  setupCommand?: string
  retired?: boolean
  id: string
  agent: AgentKind
  label: string
  homeDir: string
  executable?: string
  args?: string[]
  createdAt: number
}
