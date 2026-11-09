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

/** Unread tasks are neither acknowledged nor cancelled. */
export const isUnreadTask = (task: Pick<DelegatedTask, "state" | "acknowledgedAt">) => !task.acknowledgedAt && task.state !== "cancelled"

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
