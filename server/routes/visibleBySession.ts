import type { IncomingMessage } from "node:http"
import { filterVisible, type WithAccess } from "../edition"
import { requestScope } from "./requestScope"

/**
 * Items blocking a session, grouped under it, for the sessions the caller may
 * see in the scope the request asks for; where the edition checks access each
 * item carries the caller's `access`. Marks the request decided.
 */
export async function visibleBySession<T extends { sessionId: string }>(
  req: IncomingMessage,
  items: readonly T[],
): Promise<Record<string, Array<WithAccess<T>>>> {
  const bySession: Record<string, Array<WithAccess<T>>> = {}
  for (const item of await filterVisible(req, items, ({ sessionId }) => ({ sessionId }), requestScope(req))) {
    (bySession[item.sessionId] ??= []).push(item)
  }
  return bySession
}
