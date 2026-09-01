import { getSessionMeta, listCopilotSessionFiles } from "../helpers"
import { getCopilotSessionIdentity, type CopilotSessionIdentity } from "../sessionMetadata"
import { createSessionInventoryCache } from "./sessionInventoryCache"

export interface CopilotSessionInventoryEntry extends CopilotSessionIdentity {
  filePath: string
  fileName: string
  mtimeMs: number
  size: number
}

async function loadIdentity(
  file: Awaited<ReturnType<typeof listCopilotSessionFiles>>[number],
): Promise<CopilotSessionInventoryEntry | null> {
  const sessionId = file.fileName.slice(0, -"/events.jsonl".length)
  if (!sessionId || sessionId.includes("/")) return null
  let identity = await getCopilotSessionIdentity(file.filePath)
  if (!identity) {
    try {
      const meta = await getSessionMeta(file.filePath)
      if (!meta.cwd) return null
      identity = {
        sessionId,
        cwd: meta.cwd,
        gitBranch: meta.gitBranch,
        isSubagent: false,
        parentSessionId: null,
      }
    } catch {
      return null
    }
  }
  return { ...file, ...identity, sessionId }
}

async function loadInventory(): Promise<CopilotSessionInventoryEntry[]> {
  const files = await listCopilotSessionFiles()
  const entries = await Promise.all(files.map(loadIdentity))
  return entries.flatMap((entry) => entry ? [entry] : [])
}

const inventory = createSessionInventoryCache(loadInventory)

export const getCopilotSessionInventory = inventory.get
export const invalidateCopilotSessionInventory = inventory.invalidate
