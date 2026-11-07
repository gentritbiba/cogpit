import { getSessionMeta, getSessionStatus } from "../helpers"
import type { TopLevelSessionInfo } from "../agents/types"
import { getOrLoadSessionMeta } from "./sessionMetaCache"

/** A listed session's metadata and tail status, shared through the meta cache by every reader that lists it. */
export function listedMeta(session: Pick<TopLevelSessionInfo, "filePath" | "mtimeMs">) {
  return getOrLoadSessionMeta(session.filePath, session.mtimeMs, async () => {
    const [meta, status] = await Promise.all([
      getSessionMeta(session.filePath),
      getSessionStatus(session.filePath),
    ])
    return { meta, status }
  })
}

/** When a listed session last did something: its newest record's time, else its transcript's mtime. */
export function lastActivityOf(meta: { lastTimestamp?: string }, mtimeMs: number): string {
  return meta.lastTimestamp || new Date(mtimeMs).toISOString()
}
