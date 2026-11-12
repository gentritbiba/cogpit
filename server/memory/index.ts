import { readFile, stat } from "node:fs/promises"
import { join } from "node:path"
import { createEmbeddingClient, MEMORY_CONFIG_FILE, parseEmbeddingConfig, type FetchLike } from "../../shared/memory/embeddings"
import type { SourceFile } from "../../shared/memory/types"
import { embedPending } from "../../shared/memory/vectors"
import { parseSession } from "../../shared/session/parser"
import { allStores } from "../agents"
import { readTranscriptText } from "../agents/transcriptFile"
import { subscribeTouchedFiles } from "../sessionCatalog/changes"
import { catalogRow } from "../sessionCatalog/rows"
import { createMemoryIndexer, type Embedder, type EmbeddingConfigFile, type MemoryIndexer } from "./indexer"
import { memoryDir } from "./paths"
import { openServerMemoryStore } from "./store"

/** One embedding run's share of a pass; the next pass carries on. */
const EMBED_BUDGET_MS = 60_000

/** Every transcript of every store, sub-agents' files included, as the memory store files them. */
export async function listSourceFiles(): Promise<SourceFile[]> {
  const listings = await Promise.all(allStores().map(async (store) => {
    const files = await store.listTranscripts().catch(() => [])
    return files.map((file): SourceFile => ({
      path: file.filePath,
      mtimeMs: file.mtimeMs,
      size: file.size,
      sessionId: file.sessionId,
      instanceId: store.instanceId ?? "default",
      agentKind: store.kind,
      isSubagent: file.isSubagent,
      parentSessionId: file.parentSessionId,
      agentId: file.agentId,
    }))
  }))
  return listings.flat()
}

async function parseTranscript(file: SourceFile) {
  let text: string
  try {
    text = await readTranscriptText(file.path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null
    throw error
  }
  return parseSession(text, { skipStats: true })
}

/** The title the session list shows when it was set by hand or generated; the store guesses one otherwise. */
async function sessionTitle(file: SourceFile): Promise<string | null> {
  const { meta } = await catalogRow({ filePath: file.path, mtimeMs: file.mtimeMs, size: file.size })
  return meta.customTitle || meta.aiTitle || null
}

async function readEmbeddingConfig(dir: string): Promise<EmbeddingConfigFile> {
  const path = join(dir, MEMORY_CONFIG_FILE)
  try {
    const { mtimeMs, size } = await stat(path)
    return { text: await readFile(path, "utf8"), stamp: `${mtimeMs}:${size}` }
  } catch {
    return { text: null, stamp: "" }
  }
}

/** The embedder `config.json` describes, null when it names no endpoint; throws when it is not usable. */
export function embedderFor(configText: string | null, fetch: FetchLike, env: NodeJS.ProcessEnv = process.env): Embedder | null {
  const { config, error } = parseEmbeddingConfig(configText, env)
  if (error) throw new Error(error)
  if (!config) return null
  const client = createEmbeddingClient(config, fetch)
  return {
    client,
    embedPending: (store, signal) => embedPending(store, client, {
      signal,
      budgetMs: EMBED_BUDGET_MS,
      pause: () => new Promise((resolve) => setImmediate(resolve)),
    }),
  }
}

let indexer: MemoryIndexer | null = null
let unsubscribe: (() => void) | null = null

/** Start keeping the memory store current. Called from `startSessionCatalog()`, so never in agent workers. */
export function startMemoryIndexer(): void {
  if (indexer) return
  const dir = memoryDir()
  indexer = createMemoryIndexer({
    openStore: () => openServerMemoryStore(dir),
    listFiles: listSourceFiles,
    parse: parseTranscript,
    title: sessionTitle,
    readEmbeddingConfig: () => readEmbeddingConfig(dir),
    createEmbedder: (text) => embedderFor(text, fetch),
  })
  unsubscribe = subscribeTouchedFiles(() => indexer?.hint())
  indexer.start()
}

export async function stopMemoryIndexer(): Promise<void> {
  unsubscribe?.()
  unsubscribe = null
  const stopping = indexer
  indexer = null
  await stopping?.stop()
}

/** The running indexer, or null before the catalog starts and in agent workers. */
export function memoryIndexer(): MemoryIndexer | null {
  return indexer
}
