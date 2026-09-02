import type { UseFn } from "../http"
import { AGENT_KINDS, type AgentKind, type ModelOption } from "../../shared/session/agent-descriptors"
import { allRuntimes } from "../agents/runtimes"

/**
 * One list per agent, or null where that CLI could not be asked (missing or
 * erroring) so the frontend keeps its static fallback for it.
 */
export type ModelCatalog = Record<AgentKind, ModelOption[] | null>

const CACHE_TTL_MS = 10 * 60 * 1000

function emptyCatalog(): ModelCatalog {
  return Object.fromEntries(AGENT_KINDS.map((kind) => [kind, null])) as ModelCatalog
}

// ── Cache ────────────────────────────────────────────────────────────────────

let lastGood: ModelCatalog = emptyCatalog()
let fetchedAt = 0
let inFlight: Promise<ModelCatalog> | null = null

async function getModelCatalog(forceRefresh: boolean): Promise<ModelCatalog> {
  const fresh = Date.now() - fetchedAt < CACHE_TTL_MS
  if (!forceRefresh && fresh && AGENT_KINDS.some((kind) => lastGood[kind])) return lastGood
  if (inFlight) return inFlight

  inFlight = (async () => {
    const runtimes = allRuntimes()
    const lists = await Promise.all(runtimes.map((runtime) => runtime.listModels()))
    // Keep the previous good list for any agent that failed this round
    const next = { ...lastGood }
    runtimes.forEach((runtime, index) => {
      next[runtime.kind] = lists[index] ?? lastGood[runtime.kind]
    })
    lastGood = next
    fetchedAt = Date.now()
    return lastGood
  })()

  try {
    return await inFlight
  } finally {
    inFlight = null
  }
}

export function registerModelRoutes(use: UseFn) {
  // GET /api/models — live model lists from the installed agent CLIs. Any
  // entry may be null (CLI missing/erroring); the frontend falls back to its
  // static list for that agent.
  use("/api/models", async (req, res, next) => {
    if (req.method !== "GET") return next()
    const forceRefresh = (req.url || "").includes("refresh=1")
    const catalog = await getModelCatalog(forceRefresh)
    res.statusCode = 200
    res.setHeader("Content-Type", "application/json")
    res.end(JSON.stringify(catalog))
  })
}
