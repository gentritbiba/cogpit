// SHARED MEMORY CORE: edit shared/memory only; cogpit-memory copies are generated.
import type { AgentKind } from "../types"

/** What a chunk of prose is. Tool input and output never enter the memory store. */
export type ChunkKind = "user" | "assistant" | "thinking" | "compaction" | "recap" | "plan" | "agent_message"

export const CHUNK_KINDS: readonly ChunkKind[] = ["user", "assistant", "thinking", "compaction", "recap", "plan", "agent_message"]

/** One transcript file on disk, as the caller's walker found it. */
export interface SourceFile {
  /** Absolute path; the key every chunk is filed under. */
  path: string
  mtimeMs: number
  size: number
  /** Instance-qualified session id (`i-<instance>__…` outside the default account). */
  sessionId: string
  instanceId: string
  agentKind: AgentKind
  isSubagent: boolean
  parentSessionId: string | null
  /** The subagent this file is the transcript of, or null for a session's own transcript. */
  agentId: string | null
}

/** A chunk as the chunker produces it, before it is stored. */
export interface Chunk {
  /** Turn ordinal in its source file. */
  turn: number
  kind: ChunkKind
  /** Prose block number within the turn. */
  block: number
  /** Piece number when a block is longer than one chunk. */
  part: number
  turnId: string | null
  /** The subagent a parent transcript reported this text for inline; null otherwise. */
  inlineAgentId: string | null
  timestamp: string | null
  /** Written by Cogpit or another agent on someone's behalf rather than typed by the reader. */
  automated: boolean
  text: string
}

/** Whether a hit came from keywords, meaning, or both. */
export type MatchKind = "keyword" | "semantic" | "both"

/** One ranked prose hit, as `searchProse` returns it. */
export interface MemoryHit {
  chunkId: number
  sessionId: string
  instanceId: string
  agentKind: AgentKind
  cwd: string
  /** Session title snapshotted at index time; survives the transcript. */
  title: string | null
  sourceFile: string
  /** Turn ordinal: in the subagent's transcript when `agentId` is set, else in the session's. */
  turn: number
  turnId: string | null
  /** Set only when the text came from a subagent's own transcript (`context --agent`). */
  agentId: string | null
  /** The subagent a parent reported inline; `turn` is then the parent's turn. */
  inlineAgentId: string | null
  kind: ChunkKind
  /** `turn/<i>/<field>` or `agent/<id>/…`, in the existing index's style. */
  location: string
  snippet: string
  text: string
  textHash: string
  timestamp: string | null
  automated: boolean
  /** Query-term occurrences in the text; 0 for a hit that matched by meaning only. */
  matchCount: number
  match: MatchKind
  /** Reciprocal-rank-fusion score over the lists the hit appeared in. */
  score: number
  /** 1-based rank in each list the hit appeared in. */
  ranks: { keyword?: number; semantic?: number }
  /** Cosine similarity to the query, when the hit came from the vector list. */
  similarity?: number
  /** The transcript is gone (`stat` says ENOENT); the stored text is all that is left. */
  archived: boolean
  /** Other chunks with identical text (forked sessions) folded into this hit. */
  duplicates: number
}

export interface SemanticStatus {
  state: "ready" | "unavailable" | "off"
  reason?: string
}
