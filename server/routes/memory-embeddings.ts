import type { EmbeddingSettingsInput } from "../../shared/contracts/memoryEmbeddings"
import { sendJson, withJsonBody, type UseFn } from "../http"
import { memoryIndexer } from "../memory"
import { embeddingSettingsReport, saveEmbeddingSettings, testEmbeddingSettings } from "../memory/embeddingSettings"
import { memoryDir } from "../memory/paths"
import { hostAdminRoute } from "./hostAdminRoute"

function readInput(value: unknown): EmbeddingSettingsInput | null {
  if (typeof value !== "object" || value === null) return null
  const { url, model } = value as Record<string, unknown>
  return typeof url === "string" && typeof model === "string" ? value as EmbeddingSettingsInput : null
}

/**
 * GET  /api/memory-embeddings — the saved embedding endpoint (never its key),
 *                               how much session text has a vector, and why
 *                               embedding is stopped when it is.
 * POST /api/memory-embeddings — `{ action: "save", settings }`,
 *                               `{ action: "test", settings }` or
 *                               `{ action: "off" }`.
 *
 * Host administrators only: the server sends session text to the address
 * saved here.
 */
export function registerMemoryEmbeddingRoutes(use: UseFn) {
  hostAdminRoute(use, "/api/memory-embeddings", "Only a host administrator can change how sessions are searched", async (req, res) => {
    const dir = memoryDir()
    const report = () => embeddingSettingsReport(dir, memoryIndexer())
    if (req.method === "GET") return sendJson(res, 200, await report())
    const save = async (input: EmbeddingSettingsInput | null) => {
      const { error } = await saveEmbeddingSettings(dir, input)
      if (error) return sendJson(res, 400, { error })
      await memoryIndexer()?.reloadEmbeddings()
      sendJson(res, 200, await report())
    }
    withJsonBody<Record<string, unknown>>(req, res, async (body) => {
      if (body.action === "off") return save(null)
      if (body.action !== "save" && body.action !== "test") return sendJson(res, 400, { error: "Unknown action" })
      const input = readInput(body.settings)
      if (!input) return sendJson(res, 400, { error: "settings need a url and a model" })
      if (body.action === "save") return save(input)
      sendJson(res, 200, await testEmbeddingSettings(dir, input, fetch))
    })
  })
}
