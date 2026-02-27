import { useMemo, useEffect, useRef } from "react"
import { ChevronRight } from "lucide-react"
import { SectionHeading } from "@/components/stats/SectionHeading"
import { AgentCard } from "@/components/stats/AgentCard"
import type { ParsedSession } from "@/lib/types"
import { parseSubAgentPath } from "@/lib/format"
import type { BgAgent } from "@/hooks/useBackgroundAgents"

// ── Inline Agent Extraction ─────────────────────────────────────────────────

interface InlineAgent {
  agentId: string
  agentName: string | null
  subagentType: string | null
  preview: string
  isBackground: boolean
}

function extractInlineAgents(session: ParsedSession): InlineAgent[] {
  const seen = new Map<string, Omit<InlineAgent, "agentId">>()
  for (const turn of session.turns) {
    for (const block of turn.contentBlocks) {
      if (block.kind !== "sub_agent" && block.kind !== "background_agent") continue
      for (const msg of block.messages) {
        if (seen.has(msg.agentId)) continue
        const preview = msg.text[0]?.split("\n").find((l) => l.trim())?.trim() ?? ""
        seen.set(msg.agentId, { agentName: msg.agentName, subagentType: msg.subagentType, preview, isBackground: msg.isBackground })
      }
    }
  }
  return Array.from(seen.entries()).map(([agentId, info]) => ({
    agentId,
    ...info,
  }))
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
}: AgentsPanelProps): JSX.Element | null {
  // Detect if we're currently viewing a sub-agent
  const subAgentView = useMemo(() => {
    if (!sessionSource) return null
    const parsed = parseSubAgentPath(sessionSource.fileName)
    if (!parsed) return null
    return { ...parsed, dirName: sessionSource.dirName }
  }, [sessionSource])

  // Extract inline sub-agents from session content blocks
  const currentInlineAgents = useMemo(() => extractInlineAgents(session), [session])

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

  // Build combined list: background agents + inline-only sub-agents (deduplicated)
  const inlineOnlyAgents = useMemo(() => {
    const bgAgentIds = new Set(sessionBgAgents.map((a) => a.agentId))
    return inlineAgents.filter(
      (a) => !a.isBackground && !bgAgentIds.has(a.agentId)
    )
  }, [sessionBgAgents, inlineAgents])

  const totalCount = sessionBgAgents.length + inlineOnlyAgents.length
  if (totalCount === 0) return null

  const currentAgentId = subAgentView?.agentId ?? null

  return (
    <section>
      <SectionHeading>Sub-Agents ({totalCount})</SectionHeading>

      {/* Back to Main button when viewing a sub-agent */}
      {subAgentView && onLoadSession && (
        <button
          onClick={() => onLoadSession(subAgentView.dirName, subAgentView.parentFileName)}
          className="mb-2 flex w-full items-center gap-1.5 rounded border border-blue-500/30 bg-blue-500/10 px-2.5 py-1.5 text-[11px] font-medium text-blue-400 transition-colors hover:bg-blue-500/20 hover:border-blue-500/50"
        >
          <ChevronRight className="size-3 rotate-180" />
          Back to Main Agent
        </button>
      )}

      <div className="max-h-[280px] overflow-y-auto space-y-1.5 pr-0.5">
        {/* Background agents */}
        {sessionBgAgents.map((agent, idx) => {
          const preview = agent.preview
            ? agent.preview.split("\n").find((l) => l.trim())?.trim() ?? ""
            : ""
          return (
            <AgentCard
              key={agent.agentId}
              agentId={agent.agentId}
              subagentType={agent.subagentType}
              agentName={agent.agentName}
              preview={preview !== agent.agentId ? preview : ""}
              colorIndex={idx}
              isViewing={currentAgentId === agent.agentId}
              isBackground
              isActive={agent.isActive}
              disabled={!onLoadSession}
              onClick={() => onLoadSession?.(agent.dirName, agent.fileName)}
            />
          )
        })}

        {/* Inline sub-agents (non-background) */}
        {inlineOnlyAgents.map((agent, idx) => {
          const canNavigate = !!onLoadSession && !!parentSessionId && !!sessionSource
          return (
            <AgentCard
              key={agent.agentId}
              agentId={agent.agentId}
              subagentType={agent.subagentType}
              agentName={agent.agentName}
              preview={agent.preview}
              colorIndex={sessionBgAgents.length + idx}
              isViewing={currentAgentId === agent.agentId}
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
