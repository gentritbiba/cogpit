// SHARED SESSION CORE: edit shared/session only; cogpit-memory copies are generated.
/**
 * Shared message type guards for RawMessage discrimination.
 *
 * Previously duplicated between turnBuilder.ts and parser.ts to avoid circular
 * dependencies. Extracted here as a dependency-free leaf module (imports only
 * from ./types) so both files can share a single source of truth.
 */

import type {
  RawMessage,
  UserMessage,
  AssistantMessage,
  ProgressMessage,
  SystemMessage,
  SummaryMessage,
  QueueOperationMessage,
} from "./types"

export function isUserMessage(msg: RawMessage): msg is UserMessage {
  return msg.type === "user"
}

export function isAssistantMessage(msg: RawMessage): msg is AssistantMessage {
  return msg.type === "assistant"
}

export function isProgressMessage(msg: RawMessage): msg is ProgressMessage {
  return msg.type === "progress"
}

export function isSystemMessage(msg: RawMessage): msg is SystemMessage {
  return msg.type === "system"
}

export function isSummaryMessage(msg: RawMessage): msg is SummaryMessage {
  return msg.type === "summary"
}

export function isQueueOperationMessage(msg: RawMessage): msg is QueueOperationMessage {
  return msg.type === "queue-operation"
}

export function isCompactBoundary(
  msg: RawMessage,
): msg is SystemMessage & { subtype: "compact_boundary" } {
  return msg.type === "system" && msg.subtype === "compact_boundary"
}
