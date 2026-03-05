/**
 * Context command — L1 (session overview), L2 (turn detail), L3 (sub-agent resolution).
 * Ported from routes/session-context.ts to plain functions returning objects.
 */

import { readFile, readdir } from "node:fs/promises"
import { join } from "node:path"
import { findJsonlPath, matchSubagentToMember } from "../lib/helpers"
import { dirs } from "../lib/dirs"
import { parseSession } from "../lib/parser"
import type {
  ParsedSession,
  Turn,
  UserContent,
  ThinkingBlock,
  SubAgentMessage,
  TurnContentBlock,
} from "../lib/types"

const RESULT_TRUNCATE_LIMIT = 10_000
const L1_RESPONSE_LIMIT = 150_000

// -- Helpers ------------------------------------------------------------------

function extractUserMessageText(userMessage: UserContent | null): string | null {
  if (userMessage === null) return null
  if (typeof userMessage === "string") return userMessage
  const parts: string[] = []
  for (const block of userMessage) {
    if (block.type === "text") parts.push(block.text)
    else if (block.type === "image") parts.push("[image attached]")
  }
  return parts.length > 0 ? parts.join("\n") : null
}

function truncateResult(result: string | null): { result: string | null; resultTruncated: boolean } {
  if (result === null) return { result: null, resultTruncated: false }
  if (result.length <= RESULT_TRUNCATE_LIMIT) return { result, resultTruncated: false }
  return { result: result.slice(0, RESULT_TRUNCATE_LIMIT), resultTruncated: true }
}

function mapSubAgentSummary(msg: SubAgentMessage) {
  return {
    agentId: msg.agentId,
    name: msg.agentName ?? null,
    type: msg.subagentType ?? null,
    status: msg.status ?? null,
    durationMs: msg.durationMs ?? null,
    toolUseCount: msg.toolUseCount ?? null,
    isBackground: msg.isBackground,
  }
}

function mapSubAgentDetail(msg: SubAgentMessage) {
  return {
    ...mapSubAgentSummary(msg),
    prompt: msg.prompt ?? null,
    resultText: msg.text.join("\n\n") || null,
  }
}

// -- L1: Session Overview -----------------------------------------------------

function mapSessionToOverview(session: ParsedSession) {
  const turns = session.turns.map((turn, i) => mapTurnToSummary(turn, i))
  const compacted = session.turns.some((t) => t.compactionSummary != null)

  const overview = {
    sessionId: session.sessionId,
    cwd: session.cwd,
    model: session.model,
    branchedFrom: session.branchedFrom ?? null,
    compacted,
    turns,
    stats: {
      totalTurns: session.stats.turnCount,
      totalToolCalls: Object.values(session.stats.toolCallCounts).reduce((a, b) => a + b, 0),
      totalTokens: {
        input: session.stats.totalInputTokens,
        output: session.stats.totalOutputTokens,
      },
    },
  }

  // If response exceeds limit, progressively trim messages (longest first)
  let serialized = JSON.stringify(overview)
  if (serialized.length > L1_RESPONSE_LIMIT) {
    const entries: { turn: (typeof turns)[number]; field: "assistantMessage" | "userMessage"; len: number }[] = []
    for (const t of overview.turns) {
      if (t.assistantMessage) entries.push({ turn: t, field: "assistantMessage", len: t.assistantMessage.length })
      if (t.userMessage) entries.push({ turn: t, field: "userMessage", len: t.userMessage.length })
    }
    entries.sort((a, b) => b.len - a.len)

    for (const entry of entries) {
      const current = entry.turn[entry.field]
      if (current && current.length > 200) {
        entry.turn[entry.field] = current.slice(0, 200) + "... [truncated, use L2 for full text]"
        serialized = JSON.stringify(overview)
        if (serialized.length <= L1_RESPONSE_LIMIT) break
      }
    }
  }

  return overview
}

function mapTurnToSummary(turn: Turn, turnIndex: number) {
  // Tool summary: count by name
  const toolSummary: Record<string, number> = {}
  for (const tc of turn.toolCalls) {
    toolSummary[tc.name] = (toolSummary[tc.name] ?? 0) + 1
  }

  // Sub-agent summaries -- deduplicate by agentId, keeping the last entry
  const agentById = new Map<string, SubAgentMessage>()
  for (const msg of turn.subAgentActivity) {
    agentById.set(msg.agentId, msg)
  }
  const subAgents = [...agentById.values()].map(mapSubAgentSummary)

  return {
    turnIndex,
    userMessage: extractUserMessageText(turn.userMessage),
    assistantMessage: turn.assistantText.length > 0 ? turn.assistantText.join("\n\n") : null,
    toolSummary,
    subAgents,
    hasThinking: turn.thinking.length > 0,
    isError: turn.toolCalls.some((tc) => tc.isError),
    compactionSummary: turn.compactionSummary ?? null,
  }
}

// -- L2: Turn Detail ----------------------------------------------------------

function mapTurnToDetail(session: ParsedSession, turnIndex: number) {
  const turn = session.turns[turnIndex]

  const contentBlocks = turn.contentBlocks.map((block) => mapContentBlock(block))

  return {
    sessionId: session.sessionId,
    turnIndex,
    userMessage: extractUserMessageText(turn.userMessage),
    contentBlocks,
    tokenUsage: turn.tokenUsage
      ? { input: turn.tokenUsage.input_tokens, output: turn.tokenUsage.output_tokens }
      : null,
    model: turn.model,
    durationMs: turn.durationMs,
  }
}

function mapContentBlock(block: TurnContentBlock) {
  switch (block.kind) {
    case "thinking": {
      const text = block.blocks
        .filter((b: ThinkingBlock) => b.thinking.length > 0)
        .map((b: ThinkingBlock) => b.thinking)
        .join("\n\n")
      return { kind: "thinking" as const, text, timestamp: block.timestamp ?? null }
    }
    case "text":
      return { kind: "text" as const, text: block.text.join("\n\n"), timestamp: block.timestamp ?? null }
    case "tool_calls":
      return {
        kind: "tool_calls" as const,
        toolCalls: block.toolCalls.map((tc) => {
          const { result, resultTruncated } = truncateResult(tc.result)
          return { id: tc.id, name: tc.name, input: tc.input, result, resultTruncated, isError: tc.isError }
        }),
        timestamp: block.timestamp ?? null,
      }
    case "sub_agent":
    case "background_agent":
      return {
        kind: block.kind as "sub_agent" | "background_agent",
        agents: block.messages.map(mapSubAgentDetail),
        timestamp: block.timestamp ?? null,
      }
  }
}

// -- L3: Sub-Agent Resolution -------------------------------------------------

async function findSubagentFile(
  parentJsonlPath: string,
  agentId: string,
): Promise<{ filePath: string; fileName: string } | null> {
  const subagentsDir = parentJsonlPath.replace(/\.jsonl$/, "") + "/subagents"
  try {
    const files = await readdir(subagentsDir)
    for (const f of files) {
      if (!f.startsWith("agent-") || !f.endsWith(".jsonl")) continue
      const fileAgentId = f.replace("agent-", "").replace(".jsonl", "")
      if (fileAgentId === agentId) {
        return { filePath: join(subagentsDir, f), fileName: f }
      }
    }
  } catch {
    // Directory doesn't exist
  }
  return null
}

async function findTeamContext(
  sessionId: string,
  subagentFileName: string,
): Promise<{
  teamName: string
  role: string
  currentTask: { id: string; subject: string; status: string } | null
} | null> {
  try {
    const teamEntries = await readdir(dirs.TEAMS_DIR, { withFileTypes: true })
    for (const entry of teamEntries) {
      if (!entry.isDirectory()) continue
      const configPath = join(dirs.TEAMS_DIR, entry.name, "config.json")
      try {
        const raw = await readFile(configPath, "utf-8")
        const config = JSON.parse(raw)
        if (config.leadSessionId !== sessionId) continue

        // Found the team -- match sub-agent to member
        const members = config.members ?? []
        const memberName = await matchSubagentToMember(sessionId, subagentFileName, members)
        if (!memberName) continue

        // Look up active task
        let currentTask: { id: string; subject: string; status: string } | null = null
        try {
          const taskDir = join(dirs.TASKS_DIR, entry.name)
          const taskFiles = await readdir(taskDir)
          for (const tf of taskFiles) {
            if (!tf.endsWith(".json")) continue
            const taskRaw = await readFile(join(taskDir, tf), "utf-8")
            const task = JSON.parse(taskRaw)
            if (task.owner === memberName && task.status === "in_progress") {
              currentTask = { id: task.id, subject: task.subject, status: task.status }
              break
            }
          }
        } catch {
          // No tasks directory
        }

        return { teamName: entry.name, role: memberName, currentTask }
      } catch {
        // Invalid config file
      }
    }
  } catch {
    // No teams directory
  }
  return null
}

function findParentToolCallId(session: ParsedSession, agentId: string): string | null {
  for (const turn of session.turns) {
    for (const msg of turn.subAgentActivity) {
      if (msg.agentId === agentId) {
        for (const tc of turn.toolCalls) {
          if (tc.name === "Task" || tc.name === "Agent") {
            return tc.id
          }
        }
      }
    }
  }
  return null
}

function findAgentMetadata(
  session: ParsedSession,
  agentId: string,
): { name: string | null; type: string | null; isBackground: boolean } {
  for (const turn of session.turns) {
    for (const msg of turn.subAgentActivity) {
      if (msg.agentId === agentId) {
        return {
          name: msg.agentName,
          type: msg.subagentType,
          isBackground: msg.isBackground,
        }
      }
    }
  }
  return { name: null, type: null, isBackground: false }
}

// -- Exported Command Functions -----------------------------------------------

/**
 * L1: Session overview with all turns summarized.
 */
export async function getSessionOverview(sessionId: string): Promise<object> {
  const jsonlPath = await findJsonlPath(sessionId)
  if (!jsonlPath) return { error: "Session not found" }
  const content = await readFile(jsonlPath, "utf-8")
  const session = parseSession(content)
  return mapSessionToOverview(session)
}

/**
 * L2: Detailed view of a single turn.
 */
export async function getTurnDetail(sessionId: string, turnIndex: number): Promise<object> {
  const jsonlPath = await findJsonlPath(sessionId)
  if (!jsonlPath) return { error: "Session not found" }
  const content = await readFile(jsonlPath, "utf-8")
  const session = parseSession(content)
  if (turnIndex < 0 || turnIndex >= session.turns.length) return { error: "Turn not found" }
  return mapTurnToDetail(session, turnIndex)
}

/**
 * L3: Sub-agent's session overview.
 */
export async function getAgentOverview(sessionId: string, agentId: string): Promise<object> {
  const jsonlPath = await findJsonlPath(sessionId)
  if (!jsonlPath) return { error: "Session not found" }
  const content = await readFile(jsonlPath, "utf-8")
  const session = parseSession(content)

  const subagentFile = await findSubagentFile(jsonlPath, agentId)
  if (!subagentFile) return { error: "Agent not found" }

  const subagentContent = await readFile(subagentFile.filePath, "utf-8")
  const subagentSession = parseSession(subagentContent)
  const metadata = findAgentMetadata(session, agentId)
  const parentToolCallId = findParentToolCallId(session, agentId)
  const teamContext = await findTeamContext(sessionId, subagentFile.fileName)

  return {
    sessionId,
    agentId,
    name: metadata.name,
    type: metadata.type,
    parentToolCallId,
    isBackground: metadata.isBackground,
    teamContext,
    overview: mapSessionToOverview(subagentSession),
  }
}

/**
 * L3+L2: Sub-agent turn detail.
 */
export async function getAgentTurnDetail(
  sessionId: string,
  agentId: string,
  turnIndex: number,
): Promise<object> {
  const jsonlPath = await findJsonlPath(sessionId)
  if (!jsonlPath) return { error: "Session not found" }
  const content = await readFile(jsonlPath, "utf-8")

  const subagentFile = await findSubagentFile(jsonlPath, agentId)
  if (!subagentFile) return { error: "Agent not found" }

  const subagentContent = await readFile(subagentFile.filePath, "utf-8")
  const subagentSession = parseSession(subagentContent)
  if (turnIndex < 0 || turnIndex >= subagentSession.turns.length) return { error: "Turn not found" }

  return mapTurnToDetail(subagentSession, turnIndex)
}
