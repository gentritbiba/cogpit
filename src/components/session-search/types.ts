import type { QuoteSource } from "../../../shared/session/composerContext"

export interface SessionSearchHit {
  chunkId: number
  kind: "user" | "assistant" | "thinking" | "compaction" | "recap" | "plan" | "agent_message"
  snippet: string
  timestamp: string | null
  match: "keyword" | "semantic" | "both"
  score: number
  automated: boolean
  agentId: string | null
  openTurnId: string | null
  openTurn: number | null
  text?: string
}

export interface SessionSearchResult {
  sessionId: string
  dirName: string | null
  fileName: string | null
  title: string | null
  cwd: string
  agentKind: string
  archived: boolean
  hits: SessionSearchHit[]
}

export interface SessionSearchResponse {
  query: string
  semantic: { state: "ready" | "unavailable" | "off"; reason?: string }
  indexing: { pendingFiles: number; pendingEmbeddings: number }
  results: SessionSearchResult[]
}

export type OpenSearchQuote = (source: QuoteSource, text: string, turn?: number | null) => Promise<boolean>
