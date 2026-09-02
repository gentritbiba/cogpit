import type { AgentKind } from "../shared/session/agent-descriptors"
import { allStores, storeFor, storeForDirName, storeForPath } from "./agents"
import { isSinglePathSegment } from "./agents/containment"
import { getSessionMeta } from "./sessionMetadata"

/**
 * Session-path resolution, expressed over the agent store registry.
 *
 * Everything here used to be a three-arm `if (isCodex…) else if (isCopilot…)
 * else` chain; what is left is the composition each route needs — which store
 * to ask, and in what order.
 */

export { dirs, refreshDirs } from "./dirs"
export type { SessionFileInfo } from "./agents/types"

/**
 * Which agent produced the transcript at `filePath`.
 *
 * Defaults to Claude for a null, unknown or unowned path. Several callers rely
 * on that default — a session whose file has been deleted still has to render
 * as something rather than 404.
 */
export function getAgentKindFromSessionPath(filePath: string | null | undefined): AgentKind {
  return storeForPath(filePath)?.kind ?? "claude"
}

/**
 * Turn an untrusted `{dirName, fileName}` pair from a URL into a safe absolute
 * path, or null when it escapes the owning agent's storage.
 */
export function resolveSessionFilePath(
  dirName: string,
  fileName: string,
): Promise<string | null> {
  return storeForDirName(dirName).resolveSessionFile(dirName, fileName)
}

/**
 * Order in which storage is searched for a bare session id.
 *
 * Not `AGENT_KINDS`: this preserves the historical resolution order, and the
 * ids are near-unique across agents anyway, so the only thing the order really
 * decides is which store pays for the walk first.
 */
const LOOKUP_ORDER: readonly AgentKind[] = ["claude", "codex", "copilot"]

/** Find the transcript for a session id across every agent's storage. */
export async function findJsonlPath(sessionId: string): Promise<string | null> {
  if (!isSinglePathSegment(sessionId)) return null
  for (const kind of LOOKUP_ORDER) {
    try {
      const filePath = await storeFor(kind).findSessionFile(sessionId)
      if (filePath) return filePath
    } catch {
      // A missing or unreadable root just means that agent has no history.
    }
  }
  return null
}

/**
 * Find the rollout `codex exec` just created for `cwd`.
 *
 * Codex is the only agent that does not report the path it wrote, so the
 * spawner has to recognise its own session by elimination: newer than the
 * spawn, not seen before it, and carrying the right cwd.
 */
export async function findNewestCodexSessionForCwd(
  cwd: string,
  knownPaths: Set<string>,
  startedAt: number,
): Promise<{ filePath: string; fileName: string; sessionId: string } | null> {
  const files = await storeFor("codex").listSessionFiles()
  const candidates = files
    .filter((file) => !knownPaths.has(file.filePath) && file.mtimeMs >= startedAt - 1_000)
    .sort((a, b) => b.mtimeMs - a.mtimeMs)

  for (const file of candidates) {
    try {
      const meta = await getSessionMeta(file.filePath)
      if (meta.cwd !== cwd || !meta.sessionId) continue
      return {
        filePath: file.filePath,
        fileName: file.fileName,
        sessionId: meta.sessionId,
      }
    } catch {
      continue
    }
  }

  return null
}

/** Absolute storage roots, one per agent, for whole-tree scans. */
export function sessionStorageRoots(): Array<{ kind: AgentKind; root: string }> {
  return allStores().flatMap((store) => {
    const root = store.sessionsRoot()
    return root ? [{ kind: store.kind, root }] : []
  })
}
