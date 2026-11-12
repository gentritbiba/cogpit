import { DatabaseSync } from "node:sqlite"
import { MemoryStore } from "../../../shared/memory/store"
import type { SourceFile } from "../../../shared/memory/types"
import type { ParsedSession, Turn, TurnContentBlock } from "../../../shared/session/types"

export function openMemoryStore(path = ":memory:"): MemoryStore {
  return MemoryStore.open(new DatabaseSync(path))
}

export interface TurnSpec {
  user?: string
  assistant?: string
  thinking?: string
  timestamp?: string
  blocks?: TurnContentBlock[]
  compactionSummary?: string
  id?: string
}

export function makeTurn(spec: TurnSpec, ordinal = 0): Turn {
  const timestamp = spec.timestamp ?? `2026-11-0${(ordinal % 9) + 1}T10:00:00.000Z`
  const blocks: TurnContentBlock[] = [...(spec.blocks ?? [])]
  if (spec.thinking) blocks.unshift({ kind: "thinking", blocks: [{ type: "thinking", thinking: spec.thinking, signature: "" }], timestamp })
  if (spec.assistant) blocks.push({ kind: "text", text: [spec.assistant], timestamp })
  return {
    id: spec.id ?? `turn-${ordinal}`,
    userMessage: spec.user ?? null,
    contentBlocks: blocks,
    thinking: [],
    assistantText: spec.assistant ? [spec.assistant] : [],
    toolCalls: [],
    subAgentActivity: [],
    timestamp,
    durationMs: null,
    tokenUsage: null,
    model: null,
    ...(spec.compactionSummary ? { compactionSummary: spec.compactionSummary } : {}),
  }
}

export function makeSession(turns: TurnSpec[], overrides: Partial<ParsedSession> = {}): ParsedSession {
  return {
    sessionId: "session-1",
    version: "",
    gitBranch: "",
    cwd: "/work/project",
    slug: "",
    name: "",
    model: "",
    turns: turns.map((turn, ordinal) => makeTurn(turn, ordinal)),
    stats: { totalInputTokens: 0, totalOutputTokens: 0, totalCacheCreationTokens: 0, totalCacheReadTokens: 0, toolCallCounts: {}, errorCount: 0, totalDurationMs: 0, turnCount: turns.length },
    rawMessages: [],
    ...overrides,
  }
}

export function sourceFile(overrides: Partial<SourceFile> = {}): SourceFile {
  return {
    path: "/transcripts/session-1.jsonl",
    mtimeMs: 1_000,
    size: 100,
    sessionId: "session-1",
    instanceId: "default",
    agentKind: "acp",
    isSubagent: false,
    parentSessionId: null,
    agentId: null,
    ...overrides,
  }
}
