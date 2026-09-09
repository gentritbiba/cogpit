import { useMemo, useEffect, useRef } from "react"
import { ChevronRight } from "lucide-react"
import { Button } from "@/components/ui/button"
import { SectionHeading } from "@/components/stats/SectionHeading"
import { AgentCard, type AgentStatus } from "@/components/stats/AgentCard"
import type { ParsedSession, ToolCall } from "../../../shared/session/types"
import { parseSubAgentPath } from "@/lib/format"
import type { BgAgent } from "@/hooks/useBackgroundAgents"
import { authFetch } from "@/lib/auth"
import { useStreamingOverlay } from "@/contexts/StreamingOverlayContext"
import type { StreamingOverlay } from "@/lib/streamingOverlay"

// ── Inline Agent Extraction ─────────────────────────────────────────────────

interface InlineAgent {
  agentId: string
  agentName: string | null
  subagentType: string | null
  preview: string
  isBackground: boolean
  status: AgentStatus
  durationMs?: number
  toolUseCount?: number
  parentToolUseId?: string
}

function normalizeStatus(status: string | undefined, isActive = false): AgentStatus {
  const normalized = status?.toLowerCase()
  if (normalized === "completed" || normalized === "success" || normalized === "done") return "done"
  if (normalized === "failed" || normalized === "error" || normalized === "cancelled") return "failed"
  if (isActive || normalized === "running" || normalized === "async_launched") return "running"
  return "seen"
}

function firstLine(value: string): string {
  return value.split("\n").map((line) => line.trim()).find(Boolean) ?? ""
}

function isAgentToolCall(toolCall: ToolCall): boolean {
  return toolCall.name === "Task" || toolCall.name === "Agent"
}

function extractInlineAgents(session: ParsedSession, streamingOverlay: StreamingOverlay): InlineAgent[] {
  const seen = new Map<string, InlineAgent>()
  for (const turn of session.turns) {
    for (const block of turn.contentBlocks) {
      if (block.kind !== "sub_agent" && block.kind !== "background_agent") continue
      for (const msg of block.messages) {
        const existing = seen.get(msg.agentId)
        const nextStatus = normalizeStatus(msg.status)
        seen.set(msg.agentId, {
          agentId: msg.agentId,
          agentName: msg.agentName ?? existing?.agentName ?? null,
          subagentType: msg.subagentType ?? existing?.subagentType ?? null,
          preview: firstLine(msg.prompt?.trim() || msg.text.find((text) => text.trim()) || "") || existing?.preview || "No task summary recorded",
          isBackground: msg.isBackground || existing?.isBackground || false,
          status: nextStatus === "seen" && existing?.status ? existing.status : nextStatus,
          durationMs: msg.durationMs ?? existing?.durationMs,
          toolUseCount: msg.toolUseCount ?? existing?.toolUseCount,
          parentToolUseId: msg.parentToolUseId ?? existing?.parentToolUseId,
        })
      }
    }
  }

  const knownParentToolIds = new Set<string>()
  for (const agent of seen.values()) {
    if (agent.parentToolUseId) knownParentToolIds.add(agent.parentToolUseId)
  }
  const activeToolIds = new Set<string>()
  for (const message of streamingOverlay) {
    if (message.parentToolUseId) activeToolIds.add(message.parentToolUseId)
  }
  for (const turn of session.turns) {
    for (const toolCall of turn.toolCalls) {
      if (!isAgentToolCall(toolCall) || !activeToolIds.has(toolCall.id) || knownParentToolIds.has(toolCall.id)) continue
      const input = toolCall.input
      seen.set(`tool:${toolCall.id}`, {
        agentId: `tool:${toolCall.id}`,
        agentName: typeof input.name === "string" ? input.name : null,
        subagentType: typeof input.subagent_type === "string" ? input.subagent_type : null,
        preview: firstLine(
          typeof input.prompt === "string"
            ? input.prompt
            : typeof input.description === "string"
              ? input.description
              : "Agent task in progress",
        ),
        isBackground: false,
        status: "running",
        parentToolUseId: toolCall.id,
      })
    }
  }

  return [...seen.values()]
}

// ── Props ───────────────────────────────────────────────────────────────────

interface AgentsPanelProps {
  session: ParsedSession
  sessionSource?: { dirName: string; fileName: string } | null
  bgAgents: BgAgent[]
  onLoadSession?: (dirName: string, fileName: string) => void
}

// ── Main Component ──────────────────────────────────────────────────────────

export function AgentsPanel({
  session,
  sessionSource,
  bgAgents,
  onLoadSession,
}: AgentsPanelProps): React.JSX.Element | null {
  const streamingOverlay = useStreamingOverlay()
  // Detect if we're currently viewing a sub-agent
  const subAgentView = useMemo(() => {
    if (!sessionSource) return null
    const parsed = parseSubAgentPath(sessionSource.fileName)
    if (!parsed) return null
    return { ...parsed, dirName: sessionSource.dirName }
  }, [sessionSource])

  // Extract inline sub-agents from session content blocks
  const currentInlineAgents = useMemo(
    () => extractInlineAgents(session, streamingOverlay),
    [session, streamingOverlay],
  )

  // Cache parent session's inline agents so they persist when navigating to sub-agents.
  const cachedInlineAgentsRef = useRef(currentInlineAgents)
  useEffect(() => {
    if (!subAgentView && currentInlineAgents.length > 0) {
      cachedInlineAgentsRef.current = currentInlineAgents
    }
  }, [subAgentView, currentInlineAgents])
  const inlineAgents = subAgentView && currentInlineAgents.length === 0
    ? cachedInlineAgentsRef.current
    : currentInlineAgents

  // Determine the parent session ID for constructing sub-agent paths
  const parentSessionId = useMemo(() => {
    if (subAgentView) return subAgentView.parentSessionId
    if (sessionSource?.fileName) {
      const match = sessionSource.fileName.match(/^([^/]+)\.jsonl$/)
      if (match) return match[1]
    }
    return null
  }, [subAgentView, sessionSource])

  // Filter background agents to only those belonging to the current session
  const sessionBgAgents = useMemo(() => {
    if (!parentSessionId) return bgAgents
    return bgAgents.filter((a) => a.parentSessionId === parentSessionId)
  }, [bgAgents, parentSessionId])

  // Lookup map to enrich background agents with metadata from inline agents
  const inlineMetaMap = useMemo(() => {
    return new Map(inlineAgents.map((agent) => [agent.agentId, agent]))
  }, [inlineAgents])

  // Build combined list: background agents + inline-only sub-agents (deduplicated)
  // Show inline agents that aren't already covered by the background-agents API.
  // Previously this also excluded `a.isBackground`, which meant completed background
  // agents whose /tmp symlinks were cleaned up disappeared from the sidebar entirely.
  const inlineOnlyAgents = useMemo(() => {
    const bgAgentIds = new Set(sessionBgAgents.map((a) => a.agentId))
    return inlineAgents.filter((a) => !bgAgentIds.has(a.agentId))
  }, [sessionBgAgents, inlineAgents])

  // Sort background agents by modifiedAt descending (latest first)
  const sortedBgAgents = useMemo(
    () => [...sessionBgAgents].sort((a, b) => b.modifiedAt - a.modifiedAt),
    [sessionBgAgents]
  )

  // Reverse inline-only agents so the latest-spawned appear first
  const sortedInlineAgents = useMemo(
    () => [...inlineOnlyAgents].reverse(),
    [inlineOnlyAgents]
  )

  const totalCount = sessionBgAgents.length + inlineOnlyAgents.length
  if (totalCount === 0) return null

  const stopBackgroundAgent = (agentId: string) => {
    void authFetch(
      `/api/claude/tasks/${encodeURIComponent(session.sessionId)}/${encodeURIComponent(agentId)}`,
      { method: "DELETE" },
    )
  }

  const currentAgentId = subAgentView?.agentId ?? null

  return (
    <section>
      <SectionHeading>Agents ({totalCount})</SectionHeading>

      {/* Back to Main button when viewing a sub-agent */}
      {subAgentView && onLoadSession && (
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => onLoadSession(subAgentView.dirName, subAgentView.parentFileName)}
          className="mb-2 w-full justify-start"
        >
          <ChevronRight data-icon="inline-start" className="rotate-180" />
          Back to Main Agent
        </Button>
      )}

      <div className="flex max-h-[280px] flex-col gap-1.5 overflow-y-auto pr-0.5">
        {/* Background agents (sorted by latest modified) */}
        {sortedBgAgents.map((agent) => {
          const preview = firstLine(agent.preview ?? "")
          const meta = inlineMetaMap.get(agent.agentId)
          return (
            <AgentCard
              key={agent.agentId}
              agentId={agent.agentId}
              subagentType={meta?.subagentType ?? null}
              agentName={meta?.agentName ?? null}
              preview={meta?.preview || (preview !== agent.agentId ? preview : "")}
              isViewing={currentAgentId === agent.agentId}
              isBackground
              status={agent.isActive ? "running" : meta?.status === "failed" ? "failed" : "done"}
              durationMs={meta?.durationMs}
              toolUseCount={meta?.toolUseCount}
              disabled={!onLoadSession}
              onStop={agent.isActive ? () => stopBackgroundAgent(agent.agentId) : undefined}
              onClick={() => onLoadSession?.(agent.dirName, agent.fileName)}
            />
          )
        })}

        {/* Inline agents (sorted by latest spawned) */}
        {sortedInlineAgents.map((agent) => {
          const canNavigate = !!onLoadSession && !!parentSessionId && !!sessionSource && !agent.agentId.startsWith("tool:")
          return (
            <AgentCard
              key={agent.agentId}
              agentId={agent.agentId}
              subagentType={agent.subagentType}
              agentName={agent.agentName}
              preview={agent.preview}
              isViewing={currentAgentId === agent.agentId}
              isBackground={agent.isBackground}
              status={agent.status}
              durationMs={agent.durationMs}
              toolUseCount={agent.toolUseCount}
              disabled={!canNavigate}
              onClick={() => {
                if (!canNavigate) return
                onLoadSession!(
                  sessionSource!.dirName,
                  `${parentSessionId}/subagents/agent-${agent.agentId}.jsonl`
                )
              }}
            />
          )
        })}
      </div>
    </section>
  )
}
