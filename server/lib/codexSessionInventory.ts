import { getSessionMeta, listCodexSessionFiles } from "../helpers"
import { getCodexSessionIdentity, type CodexSessionIdentity } from "../sessionMetadata"
import { createSessionInventoryCache } from "./sessionInventoryCache"

export interface CodexSessionInventoryEntry extends CodexSessionIdentity {
  filePath: string
  fileName: string
  mtimeMs: number
  size: number
}

async function loadIdentity(
  file: Awaited<ReturnType<typeof listCodexSessionFiles>>[number],
): Promise<CodexSessionInventoryEntry | null> {
  let identity = await getCodexSessionIdentity(file.filePath)

  // Preserve unusual/legacy rollouts whose identity is not fully present in
  // the first 32KB. Only those files fall back to the full metadata parser.
  if (!identity) {
    try {
      const meta = await getSessionMeta(file.filePath)
      if (!meta.cwd) return null
      identity = {
        sessionId: meta.sessionId,
        cwd: meta.cwd,
        gitBranch: meta.gitBranch,
        isSubagent: meta.isSubagent,
        parentSessionId: meta.parentSessionId,
      }
    } catch {
      return null
    }
  }

  return { ...file, ...identity }
}

async function loadInventory(): Promise<CodexSessionInventoryEntry[]> {
  const files = await listCodexSessionFiles()
  const entries = await Promise.all(files.map(loadIdentity))
  return entries.flatMap((entry) => entry ? [entry] : [])
}

const inventory = createSessionInventoryCache(loadInventory)

/** Share the cold filesystem walk and identity reads across concurrent routes. */
export const getCodexSessionInventory = inventory.get
export const invalidateCodexSessionInventory = inventory.invalidate
