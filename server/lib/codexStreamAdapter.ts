import type { CodexNotification } from "../codex-app-server-protocol"
import * as streamBus from "./streamBus"

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function stringField(value: Record<string, unknown>, key: string): string | undefined {
  const field = value[key]
  return typeof field === "string" && field ? field : undefined
}

/** Bridge stable Codex app-server item events onto the shared browser stream. */
export function forwardCodexStreamNotification(notification: CodexNotification): void {
  if (!isObject(notification.params)) return
  const params = notification.params
  const threadId = stringField(params, "threadId")
  if (!threadId) return

  switch (notification.method) {
    case "item/agentMessage/delta": {
      const itemId = stringField(params, "itemId")
      const delta = stringField(params, "delta")
      if (itemId && delta) streamBus.publishTextDelta(threadId, itemId, delta)
      return
    }

    case "item/completed": {
      const item = params.item
      if (!isObject(item) || item.type !== "agentMessage") return
      const itemId = stringField(item, "id")
      if (itemId) streamBus.completeMessage(threadId, itemId)
      return
    }

    case "error": {
      const error = params.error
      const message = isObject(error) ? stringField(error, "message") : undefined
      if (message) streamBus.publishError(threadId, message)
      return
    }

    // A turn starting also clears, so an interrupted prior turn leaves no
    // stale overlay behind.
    case "turn/started":
    case "turn/completed":
    case "thread/closed":
      streamBus.clear(threadId)
      return
  }
}
