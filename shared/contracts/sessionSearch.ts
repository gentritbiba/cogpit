import type { ChunkKind, MatchKind, SemanticStatus } from "../memory/types"

/** GET /api/session-search: content hits grouped by the session the UI opens. */

export interface SessionSearchHit {
  chunkId: number
  kind: ChunkKind
  /** Plain text, about 200 characters. */
  snippet: string
  timestamp: string | null
  match: MatchKind
  score: number
  automated: boolean
  /** Set when the text is a sub-agent's own. */
  agentId: string | null
  /** The turn to jump to in the opened session; may be stale, so `openTurn` is the fallback. */
  openTurnId: string | null
  /** Zero-based index in the opened session's complete turn list. */
  openTurn: number | null
  /** The whole stored chunk, only on archived hits. */
  text?: string
}

export interface SessionSearchResult {
  /** The session the UI opens: the parent, for a sub-agent's hit. */
  sessionId: string
  /** Null when archived. */
  dirName: string | null
  /** Null when archived. */
  fileName: string | null
  title: string | null
  cwd: string
  agentKind: string
  archived: boolean
  /** One to three, best first. */
  hits: SessionSearchHit[]
}

/** How far the memory store is behind; both 0 when it is current. */
export interface SessionSearchIndexing {
  pendingFiles: number
  pendingEmbeddings: number
}

export interface SessionSearchResponse {
  query: string
  semantic: SemanticStatus
  indexing: SessionSearchIndexing
  /** Best first. */
  results: SessionSearchResult[]
}
