import { getSessionMeta, listCodexSessionFiles } from "../helpers"
import { getCodexSessionIdentity, type CodexSessionIdentity } from "../sessionMetadata"

export interface CodexSessionInventoryEntry extends CodexSessionIdentity {
  filePath: string
  fileName: string
  mtimeMs: number
  size: number
}

const INVENTORY_TTL_MS = 1000

let cachedInventory: { loadedAt: number; entries: CodexSessionInventoryEntry[] } | null = null
let inventoryInFlight: Promise<CodexSessionInventoryEntry[]> | null = null

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

/** Share the cold filesystem walk and identity reads across concurrent routes. */
export function getCodexSessionInventory(): Promise<CodexSessionInventoryEntry[]> {
  if (cachedInventory && Date.now() - cachedInventory.loadedAt <= INVENTORY_TTL_MS) {
    return Promise.resolve(cachedInventory.entries)
  }
  if (inventoryInFlight) return inventoryInFlight

  inventoryInFlight = loadInventory()
    .then((entries) => {
      cachedInventory = { loadedAt: Date.now(), entries }
      return entries
    })
    .finally(() => {
      inventoryInFlight = null
    })
  return inventoryInFlight
}

export function invalidateCodexSessionInventory(): void {
  cachedInventory = null
  inventoryInFlight = null
}
