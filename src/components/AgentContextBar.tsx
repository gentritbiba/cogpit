import { useMemo, useState } from "react"
import { Bot, CheckCircle2, ChevronDown, ChevronRight, Circle, Clock3, Loader2, Users, Wrench, XCircle } from "lucide-react"
import { useStreamingOverlay } from "@/contexts/StreamingOverlayContext"
import type { BgAgent } from "@/hooks/useBackgroundAgents"
import type { ParsedSession, SubAgentMessage, ToolCall } from "@/lib/types"
import type { StreamingOverlay } from "@/lib/streamingOverlay"
import { cn } from "@/lib/utils"

interface AgentContextBarProps {
  session: ParsedSession
  sessionSource?: { dirName: string; fileName: string } | null
  backgroundAgents?: BgAgent[]
  onLoadSession?: (dirName: string, fileName: string) => void
  mobile?: boolean
}

const EMPTY_BACKGROUND_AGENTS: BgAgent[] = []

type AgentStatus = "running" | "done" | "failed" | "seen"

interface AgentContextItem {
  agentId: string
  agentName: string | null
  subagentType: string | null
  prompt: string
  status: AgentStatus
  durationMs?: number
  toolUseCount?: number
  parentToolUseId?: string
  dirName?: string
  fileName?: string
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

function agentLabel(agent: AgentContextItem): string {
  return agent.agentName || agent.subagentType || `agent-${agent.agentId.slice(0, 8)}`
}

function extractAgentContext(
  session: ParsedSession,
  backgroundAgents: BgAgent[],
  streamingOverlay: StreamingOverlay,
): AgentContextItem[] {
  const agents = new Map<string, AgentContextItem>()

  const addMessage = (message: SubAgentMessage) => {
    const existing = agents.get(message.agentId)
    const prompt = firstLine(message.prompt?.trim() || message.text.find((text) => text.trim()) || "")
    const next: AgentContextItem = {
      agentId: message.agentId,
      agentName: message.agentName ?? existing?.agentName ?? null,
      subagentType: message.subagentType ?? existing?.subagentType ?? null,
      prompt: prompt || existing?.prompt || "No task summary recorded",
      status: normalizeStatus(message.status, false),
      durationMs: message.durationMs ?? existing?.durationMs,
      toolUseCount: message.toolUseCount ?? existing?.toolUseCount,
      parentToolUseId: message.parentToolUseId ?? existing?.parentToolUseId,
      dirName: existing?.dirName,
      fileName: existing?.fileName,
    }
    if (existing && next.status === "seen" && existing.status !== "seen") next.status = existing.status
    agents.set(message.agentId, next)
  }

  for (const turn of session.turns) {
    for (const block of turn.contentBlocks) {
      if (block.kind !== "sub_agent" && block.kind !== "background_agent") continue
      for (const message of block.messages) addMessage(message)
    }
  }

  // A live Agent/Task result may not have landed in the parsed session yet,
  // but the streaming overlay already tells us which tool is producing it.
  // Surface that agent immediately so the header does not lag behind Claude.
  const knownParentToolIds = new Set(
    [...agents.values()].map((agent) => agent.parentToolUseId).filter(Boolean)
  )
  const activeToolIds = new Set(
    streamingOverlay.map((message) => message.parentToolUseId).filter(Boolean)
  )
  for (const turn of session.turns) {
    for (const toolCall of turn.toolCalls) {
      if (!isAgentToolCall(toolCall) || !activeToolIds.has(toolCall.id) || knownParentToolIds.has(toolCall.id)) continue
      const input = toolCall.input
      agents.set(`tool:${toolCall.id}`, {
        agentId: `tool:${toolCall.id}`,
        agentName: typeof input.name === "string" ? input.name : null,
        subagentType: typeof input.subagent_type === "string" ? input.subagent_type : null,
        prompt: firstLine(
          typeof input.prompt === "string"
            ? input.prompt
            : typeof input.description === "string"
              ? input.description
              : "Agent task in progress"
        ),
        status: "running",
        parentToolUseId: toolCall.id,
      })
    }
  }

  for (const background of backgroundAgents) {
    const existing = agents.get(background.agentId)
    agents.set(background.agentId, {
      agentId: background.agentId,
      agentName: existing?.agentName ?? null,
      subagentType: existing?.subagentType ?? null,
      prompt: existing?.prompt && existing.prompt !== "No task summary recorded"
        ? existing.prompt
        : firstLine(background.preview) || "Background task",
      status: normalizeStatus(existing?.status, background.isActive),
      durationMs: existing?.durationMs,
      toolUseCount: existing?.toolUseCount,
      dirName: background.dirName,
      fileName: background.fileName,
    })
  }

  return [...agents.values()].sort((a, b) => {
    if (a.status === "running" && b.status !== "running") return -1
    if (a.status !== "running" && b.status === "running") return 1
    return agentLabel(a).localeCompare(agentLabel(b))
  })
}

function isAgentToolCall(toolCall: ToolCall): boolean {
  return toolCall.name === "Task" || toolCall.name === "Agent"
}

function statusLabel(status: AgentStatus): string {
  if (status === "running") return "active"
  if (status === "done") return "done"
  if (status === "failed") return "failed"
  return "seen"
}

function statusIcon(status: AgentStatus) {
  if (status === "running") return <Loader2 className="size-3 animate-spin text-emerald-400" />
  if (status === "done") return <CheckCircle2 className="size-3 text-emerald-400" />
  if (status === "failed") return <XCircle className="size-3 text-red-400" />
  return <Circle className="size-2.5 text-muted-foreground" />
}

function formatDuration(durationMs: number | undefined): string | null {
  if (durationMs == null) return null
  if (durationMs < 1000) return `${durationMs}ms`
  return `${(durationMs / 1000).toFixed(durationMs >= 10_000 ? 0 : 1)}s`
}

export function AgentContextBar({
  session,
  sessionSource,
  backgroundAgents = EMPTY_BACKGROUND_AGENTS,
  onLoadSession,
  mobile = false,
}: AgentContextBarProps): React.ReactElement | null {
  const [expanded, setExpanded] = useState(false)
  const streamingOverlay = useStreamingOverlay()
  const agents = useMemo(
    () => extractAgentContext(session, backgroundAgents, streamingOverlay),
    [session, backgroundAgents, streamingOverlay]
  )

  if (agents.length === 0) return null

  const activeCount = agents.filter((agent) => agent.status === "running").length
  const featuredAgent = agents.find((agent) => agent.status === "running") ?? agents[0]
  const parentSessionId = sessionSource?.fileName.match(/^([^/]+)\.jsonl$/)?.[1] ?? null

  const openAgent = (agent: AgentContextItem) => {
    if (!onLoadSession) return
    if (agent.dirName && agent.fileName) {
      onLoadSession(agent.dirName, agent.fileName)
      return
    }
    if (parentSessionId && sessionSource && !agent.agentId.startsWith("tool:")) {
      onLoadSession(
        sessionSource.dirName,
        `${parentSessionId}/subagents/agent-${agent.agentId}.jsonl`
      )
    }
  }

  return (
    <div className={cn(
      "shrink-0 border-b border-border/40 bg-elevation-1",
      mobile ? "px-2 py-1" : "px-3 py-1.5",
    )}>
      <button
        type="button"
        aria-expanded={expanded}
        aria-controls="agent-context-details"
        onClick={() => setExpanded((value) => !value)}
        className={cn(
          "flex w-full min-w-0 items-center text-left text-[11px] text-muted-foreground transition-colors hover:text-foreground",
          mobile ? "h-6 gap-1.5" : "gap-2",
        )}
      >
        {expanded ? <ChevronDown className="size-3 shrink-0" /> : <ChevronRight className="size-3 shrink-0" />}
        <Users className="size-3 shrink-0 text-cyan-400" />
        <span className="font-medium">Agents</span>
        <span className="rounded-full bg-cyan-500/15 px-1.5 py-0.5 text-[10px] text-cyan-300">
          {agents.length}
        </span>
        {activeCount > 0 && <span className="text-emerald-400">{activeCount} active</span>}
        {mobile && featuredAgent ? (
          <span className="ml-auto flex min-w-0 items-center gap-1 truncate text-[10px]">
            <span className={cn("size-1.5 shrink-0 rounded-full", featuredAgent.status === "running" ? "animate-pulse bg-emerald-400" : featuredAgent.status === "failed" ? "bg-red-400" : "bg-muted-foreground/50")} />
            <span className="truncate">{agentLabel(featuredAgent)}</span>
          </span>
        ) : (
          <div className="flex min-w-0 items-center gap-1 overflow-hidden">
            {agents.map((agent) => (
              <span key={agent.agentId} className="inline-flex min-w-0 items-center gap-1 rounded-md bg-elevation-2 px-1.5 py-0.5 text-[10px]">
                <span className={cn("size-1.5 shrink-0 rounded-full", agent.status === "running" ? "animate-pulse bg-emerald-400" : agent.status === "failed" ? "bg-red-400" : "bg-muted-foreground/50")} />
                <span className="max-w-32 truncate">{agentLabel(agent)}</span>
              </span>
            ))}
          </div>
        )}
      </button>

      {expanded && (
        <div id="agent-context-details" className="mt-2 grid gap-1.5 sm:grid-cols-2">
          {agents.map((agent) => {
            const duration = formatDuration(agent.durationMs)
            const canOpen = !!onLoadSession && !agent.agentId.startsWith("tool:") && (!!agent.fileName || !!parentSessionId)
            return (
              <div key={agent.agentId} className="min-w-0 rounded-md border border-border/50 bg-elevation-2 px-2.5 py-2">
                <div className="flex min-w-0 items-center gap-1.5">
                  {statusIcon(agent.status)}
                  <span className="min-w-0 flex-1 truncate text-[11px] font-medium text-foreground">{agentLabel(agent)}</span>
                  {agent.subagentType && agent.agentName && (
                    <span className="max-w-24 truncate text-[9px] text-muted-foreground">{agent.subagentType}</span>
                  )}
                  <span className="text-[9px] uppercase tracking-wide text-muted-foreground">{statusLabel(agent.status)}</span>
                </div>
                <p className="mt-1 line-clamp-2 text-[10px] leading-snug text-muted-foreground" title={agent.prompt}>
                  {agent.prompt}
                </p>
                {(duration || agent.toolUseCount != null) && (
                  <div className="mt-1.5 flex items-center gap-2 text-[9px] text-muted-foreground/70">
                    {duration && <span className="inline-flex items-center gap-0.5"><Clock3 className="size-2.5" />{duration}</span>}
                    {agent.toolUseCount != null && <span className="inline-flex items-center gap-0.5"><Wrench className="size-2.5" />{agent.toolUseCount} tools</span>}
                  </div>
                )}
                {canOpen && (
                  <button
                    type="button"
                    onClick={() => openAgent(agent)}
                    className="mt-1.5 inline-flex items-center gap-1 text-[10px] text-cyan-300 hover:text-cyan-200"
                  >
                    <Bot className="size-2.5" /> Open transcript
                  </button>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
