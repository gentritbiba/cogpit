// SHARED MEMORY CORE: edit shared/memory only; cogpit-memory copies are generated.
/**
 * Turns a parsed session into prose chunks: one or more per content block, so
 * each chunk keeps its own timestamp and a long agent run is not one blob.
 * Tool input and output stay out; they live in the tool index.
 */
import { isReaderPrompt } from "../automatedPrompts"
import { composerPromptText } from "../composerContext"
import { getUserMessageText } from "../parser"
import type { ParsedSession, SubAgentMessage, Turn } from "../types"
import type { Chunk, ChunkKind } from "./types"

/** Bump when chunking changes, so every file is re-chunked on its next sync. */
export const CHUNKER_VERSION = 1

/** About 500 tokens of English: one embedding request per chunk. */
export const MAX_CHUNK_CHARS = 2000

export interface ChunkOptions {
  /**
   * True when a subagent has its own transcript. Its text is then indexed from
   * that file, and not a second time from the parent's inline report.
   */
  hasSubagentTranscript?: (agentId: string) => boolean
}

export function chunkSession(session: ParsedSession, options: ChunkOptions = {}): Chunk[] {
  const chunks: Chunk[] = []
  session.turns.forEach((turn, ordinal) => chunkTurn(turn, ordinal, options, chunks))
  return chunks
}

interface BlockText {
  kind: ChunkKind
  text: string
  timestamp?: string
  automated?: boolean
  inlineAgentId?: string
}

function chunkTurn(turn: Turn, ordinal: number, options: ChunkOptions, out: Chunk[]): void {
  const blocks: BlockText[] = []
  if (turn.compactionSummary) blocks.push({ kind: "compaction", text: turn.compactionSummary })
  const prompt = getUserMessageText(turn.userMessage)
  if (prompt.trim()) blocks.push(promptBlock(prompt, turn.timestamp))

  for (const block of turn.contentBlocks) {
    switch (block.kind) {
      case "text":
        blocks.push({ kind: "assistant", text: block.text.join("\n\n"), timestamp: block.timestamp })
        break
      case "thinking":
        blocks.push({ kind: "thinking", text: block.blocks.map((item) => item.thinking).join("\n\n"), timestamp: block.timestamp })
        break
      case "queued_prompt":
        blocks.push(promptBlock(block.content, block.timestamp))
        break
      case "agent_message":
        blocks.push({ kind: "agent_message", text: block.body, timestamp: block.timestamp, automated: true })
        break
      case "plan_mode":
        blocks.push({ kind: "plan", text: block.plan, timestamp: block.timestamp })
        break
      case "recap":
        blocks.push({ kind: "recap", text: block.content, timestamp: block.timestamp })
        break
      case "sub_agent":
      case "background_agent":
        for (const message of block.messages) {
          if (!options.hasSubagentTranscript?.(message.agentId)) blocks.push(...inlineAgentBlocks(message))
        }
        break
    }
  }

  let blockNumber = 0
  for (const block of blocks) {
    const text = block.text.trim()
    if (!text) continue
    splitText(text, MAX_CHUNK_CHARS).forEach((piece, part) => out.push({
      turn: ordinal,
      kind: block.kind,
      block: blockNumber,
      part,
      turnId: turn.id || null,
      inlineAgentId: block.inlineAgentId ?? null,
      timestamp: block.timestamp || turn.timestamp || null,
      automated: block.automated ?? false,
      text: piece,
    }))
    blockNumber++
  }
}

function promptBlock(raw: string, timestamp: string | undefined): BlockText {
  return { kind: "user", text: composerPromptText(raw), timestamp, automated: !isReaderPrompt(raw) }
}

function inlineAgentBlocks(message: SubAgentMessage): BlockText[] {
  const common = { timestamp: message.timestamp, inlineAgentId: message.agentId, automated: false }
  return [
    { ...common, kind: "thinking" as const, text: message.thinking.join("\n\n") },
    { ...common, kind: "assistant" as const, text: message.text.join("\n\n") },
  ]
}

/**
 * Pieces of at most `max` characters, cut at the largest boundary that fits:
 * a paragraph, then a line, then a sentence, then a word.
 */
export function splitText(text: string, max: number): string[] {
  const pieces: string[] = []
  let rest = text
  while (rest.length > max) {
    const cut = cutPoint(rest, max)
    const piece = rest.slice(0, cut).trim()
    if (piece) pieces.push(piece)
    rest = rest.slice(cut).trimStart()
  }
  if (rest.trim()) pieces.push(rest.trim())
  return pieces
}

const BOUNDARIES = [/\n\s*\n/g, /\n/g, /[.!?。]\s/g, /\s/g]

function cutPoint(text: string, max: number): number {
  const window = text.slice(0, max)
  for (const boundary of BOUNDARIES) {
    let best = -1
    for (const match of window.matchAll(boundary)) best = (match.index ?? 0) + match[0].length
    // A boundary in the first third would leave a tiny piece; try a finer one.
    if (best > max / 3) return best
  }
  const code = text.charCodeAt(max - 1)
  return code >= 0xd800 && code <= 0xdbff ? max - 1 : max
}
