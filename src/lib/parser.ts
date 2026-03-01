import type {
  RawMessage,
  ParsedSession,
  ContentBlock,
  ImageBlock,
  AssistantMessage,
  UserContent,
} from "./types"
import { buildTurns } from "./turnBuilder"
import { computeStats } from "./sessionStats"

// ── Re-exports (preserve public API) ─────────────────────────────────────────

export { buildTurns, buildCompactionSummary } from "./turnBuilder"
export { mergeTokenUsage, countToolCalls, tallyToolCalls, addUsageToStats, computeStats } from "./sessionStats"
export type { PlanApprovalState, UserQuestionState, PendingInteraction } from "./interactiveState"
export { detectPendingInteraction, isStuckInteractiveLoop } from "./interactiveState"

// ── Helpers ─────────────────────────────────────────────────────────────────

function isAssistantMessage(msg: RawMessage): msg is AssistantMessage {
  return msg.type === "assistant"
}

function extractTextFromContent(content: string | ContentBlock[]): string {
  if (typeof content === "string") return content
  return content
    .filter((b): b is { type: "text"; text: string } => b.type === "text")
    .map((b) => b.text)
    .join("\n")
}

// ── Parsing ─────────────────────────────────────────────────────────────────

function parseLines(jsonlText: string): RawMessage[] {
  const messages: RawMessage[] = []
  for (const line of jsonlText.split("\n")) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      messages.push(JSON.parse(trimmed) as RawMessage)
    } catch {
      // skip malformed lines
    }
  }
  return messages
}

function extractSessionMetadata(messages: RawMessage[]) {
  const meta = { sessionId: "", version: "", gitBranch: "", cwd: "", slug: "", model: "", branchedFrom: undefined as { sessionId: string; turnIndex?: number | null } | undefined }

  for (const msg of messages) {
    if (msg.sessionId && !meta.sessionId) meta.sessionId = msg.sessionId
    if (msg.version && !meta.version) meta.version = msg.version
    if (msg.gitBranch && !meta.gitBranch) meta.gitBranch = msg.gitBranch
    if (msg.cwd && !meta.cwd) meta.cwd = msg.cwd
    if (msg.slug && !meta.slug) meta.slug = msg.slug
    if ((msg as Record<string, unknown>).branchedFrom && !meta.branchedFrom) {
      meta.branchedFrom = (msg as Record<string, unknown>).branchedFrom as typeof meta.branchedFrom
    }
    if (isAssistantMessage(msg) && msg.message.model && !meta.model) {
      meta.model = msg.message.model
    }
    if (meta.sessionId && meta.version && meta.gitBranch && meta.cwd && meta.model) break
  }

  return meta
}

// ── Public API ──────────────────────────────────────────────────────────────

export function parseSession(jsonlText: string): ParsedSession {
  const rawMessages = parseLines(jsonlText)
  const metadata = extractSessionMetadata(rawMessages)
  const turns = buildTurns(rawMessages)
  const stats = computeStats(turns)

  return {
    ...metadata,
    turns,
    stats,
    rawMessages,
  }
}

/**
 * Incrementally append new JSONL lines to an existing parsed session.
 * Avoids re-parsing all turns from scratch — only re-processes the last
 * (potentially incomplete) turn and any new messages.
 */
export function parseSessionAppend(
  existing: ParsedSession,
  newJsonlText: string
): ParsedSession {
  const newMessages = parseLines(newJsonlText)
  if (newMessages.length === 0) return existing

  const allRawMessages = [...existing.rawMessages, ...newMessages]

  // Find the raw message index where the last existing turn started.
  // We pop the last turn and re-build from that point forward.
  // This way, even for a 500-turn session, we only re-process ~1 turn's worth of messages.
  let lastTurnStartIdx = existing.rawMessages.length // default: start of new messages
  let turnsToKeep = existing.turns.length > 0 ? existing.turns.length - 1 : 0
  if (existing.turns.length > 0) {
    // Walk backwards through existing raw messages to find the last non-meta
    // user message (which starts a turn)
    let userMsgCount = 0
    for (let i = existing.rawMessages.length - 1; i >= 0; i--) {
      const msg = existing.rawMessages[i]
      if (msg.type === "user" && !msg.isMeta) {
        const content = msg.message?.content
        // Skip tool-result user messages
        if (Array.isArray(content) && content.some((b: { type: string }) => b.type === "tool_result")) {
          continue
        }
        userMsgCount++
        if (userMsgCount === 1) {
          lastTurnStartIdx = i
          break
        }
      }
    }

    // Check if new messages include progress events whose parentToolUseID
    // belongs to an earlier turn (not the last one being rebuilt).  Claude
    // Code can flush sub-agent progress events AFTER the parent turn's
    // tool_result and even after the next turn has started.  When that
    // happens we need to rebuild from the turn that owns the tool call so
    // the sub-agent content block lands in the correct turn.
    const progressParentIds = new Set<string>()
    for (const msg of newMessages) {
      if (msg.type === "progress") {
        const parentId = (msg as typeof newMessages[0] & { parentToolUseID?: string }).parentToolUseID
        if (parentId) progressParentIds.add(parentId)
      }
    }

    if (progressParentIds.size > 0) {
      // Walk earlier turns to see if any own the referenced tool calls
      for (let t = existing.turns.length - 2; t >= 0; t--) {
        const turn = existing.turns[t]
        const ownsProgressParent = turn.toolCalls.some((tc) => progressParentIds.has(tc.id))
        if (ownsProgressParent) {
          // Need to rebuild from this earlier turn.  Find its start in rawMessages.
          turnsToKeep = t
          let found = 0
          for (let i = 0; i < existing.rawMessages.length; i++) {
            const msg = existing.rawMessages[i]
            if (msg.type === "user" && !msg.isMeta) {
              const content = msg.message?.content
              if (Array.isArray(content) && content.some((b: { type: string }) => b.type === "tool_result")) {
                continue
              }
              if (found === t) {
                lastTurnStartIdx = i
                break
              }
              found++
            }
          }
          break
        }
      }
    }
  }

  // Keep all turns before the rebuild point
  const keptTurns = existing.turns.slice(0, turnsToKeep)

  // Re-build turns from the last turn's start through all new messages
  const tailMessages = allRawMessages.slice(lastTurnStartIdx)
  const tailTurns = buildTurns(tailMessages)

  const allTurns = [...keptTurns, ...tailTurns]
  const stats = computeStats(allTurns)

  // Preserve metadata from existing (already extracted)
  return {
    sessionId: existing.sessionId,
    version: existing.version,
    gitBranch: existing.gitBranch,
    cwd: existing.cwd,
    slug: existing.slug,
    model: existing.model || (allTurns.length > 0 ? allTurns[allTurns.length - 1].model || "" : ""),
    turns: allTurns,
    stats,
    rawMessages: allRawMessages,
    branchedFrom: existing.branchedFrom,
  }
}

export function getUserMessageText(content: UserContent | null): string {
  if (content === null) return ""
  if (typeof content === "string") return content
  return extractTextFromContent(content)
}

export function getUserMessageImages(content: UserContent | null): ImageBlock[] {
  if (content === null || typeof content === "string") return []
  return content.filter((b): b is ImageBlock => b.type === "image")
}

// ── Tool Colors ─────────────────────────────────────────────────────────────

const TOOL_COLORS: Record<string, string> = {
  Read: "text-blue-400",
  Write: "text-green-400",
  Edit: "text-amber-400",
  Bash: "text-red-400",
  Grep: "text-purple-400",
  Glob: "text-cyan-400",
  Task: "text-indigo-400",
  Agent: "text-indigo-400",
  WebFetch: "text-orange-400",
  WebSearch: "text-orange-400",
  NotebookEdit: "text-green-400",
  EnterPlanMode: "text-purple-400",
  ExitPlanMode: "text-purple-400",
  AskUserQuestion: "text-pink-400",
}

export function getToolColor(toolName: string): string {
  return TOOL_COLORS[toolName] ?? "text-slate-400"
}
