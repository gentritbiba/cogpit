import { useState, memo, useMemo } from "react"
import { Users, ChevronRight, ChevronDown, Clock, Wrench, CheckCircle2, XCircle, Loader2, ExternalLink } from "lucide-react"
import { cn } from "@/lib/utils"
import { formatDuration, parseSubAgentPath } from "@/lib/format"
import type { SubAgentMessage } from "@/lib/types"
import { LiveSubagentTranscript } from "./LiveSubagentTranscript"
import { buildAgentLabelMap } from "./agent-utils"
import { useSubagentContent } from "@/hooks/useSubagentContent"
import { useSessionContext } from "@/contexts/SessionContext"
import ReactMarkdown from "react-markdown"
import { markdownComponents, markdownPlugins, preprocessImagePaths } from "./markdown-components"

interface AgentColor {
  badge: string
  bar: string
}

interface AgentPanelStyle {
  border: string
  icon: string
  label: string
  countBadge: string
}

interface AgentPanelProps {
  messages: SubAgentMessage[]
  expandAll: boolean
  label: string
  countLabel: string
  style: AgentPanelStyle
  colors: AgentColor[]
  thinkingIconColor?: string
  /** Enable lazy loading of subagent JSONL files for async_launched agents */
  lazyLoad?: boolean
}

/**
 * Shared collapsible panel for sub-agent and background-agent activity.
 * The two use cases differ only in color palette and labeling.
 *
 * When expanded, shows only the FINAL text message returned from each agent to
 * the main agent (what the parent actually received back), plus a low-key
 * button that opens the sub-agent's full chat session in place of the current
 * view — the same behavior as clicking a sub-agent in the right sidebar.
 */
export const AgentPanel = memo(function AgentPanel({
  messages,
  expandAll,
  label,
  countLabel,
  style,
  colors,
  thinkingIconColor: _thinkingIconColor,
  lazyLoad = false,
}: AgentPanelProps): React.ReactElement | null {
  const [open, setOpen] = useState(false)
  const isOpen = expandAll || open

  const { enrichedMessages: displayMessages, isLoading } = useSubagentContent(messages, lazyLoad && isOpen)

  const { sessionSource, actions } = useSessionContext()

  // Parent session id used to construct sub-agent file paths. Mirrors the
  // logic in AgentsPanel (sidebar) so navigation is consistent.
  const parentSessionId = useMemo(() => {
    if (!sessionSource?.fileName) return null
    const sub = parseSubAgentPath(sessionSource.fileName)
    if (sub) return sub.parentSessionId
    const match = sessionSource.fileName.match(/^([^/]+)\.jsonl$/)
    return match?.[1] ?? null
  }, [sessionSource])

  const agentIds = useMemo(() => [...new Set(displayMessages.map((m) => m.agentId))], [displayMessages])
  const agentColorMap = useMemo(() => new Map(agentIds.map((id, i) => [id, colors[i % colors.length]])), [agentIds, colors])
  const agentLabelMap = useMemo(() => buildAgentLabelMap(displayMessages), [displayMessages])

  // Per-agent stats — merge anything present on the launch event summary or on
  // individual progress messages. The original `messages` array (not enriched)
  // always carries these on the summary/launch event.
  const statsByAgent = useMemo(() => {
    const map = new Map<string, { durationMs?: number; toolUseCount?: number; status?: string }>()
    for (const m of [...messages, ...displayMessages]) {
      const existing = map.get(m.agentId) ?? {}
      if (m.durationMs != null) existing.durationMs = m.durationMs
      if (m.toolUseCount != null) existing.toolUseCount = m.toolUseCount
      if (m.status) existing.status = m.status
      map.set(m.agentId, existing)
    }
    return map
  }, [messages, displayMessages])

  // agentId → Task/Agent tool_use id (key for the live streaming transcript)
  const parentToolByAgent = useMemo(() => {
    const map = new Map<string, string>()
    for (const m of [...messages, ...displayMessages]) {
      if (m.parentToolUseId && !map.has(m.agentId)) map.set(m.agentId, m.parentToolUseId)
    }
    return map
  }, [messages, displayMessages])

  // Pick the "return" message for each agent — the last message that carried
  // non-empty text (what the sub-agent handed back to its parent). Falls back
  // to the latest message seen if none yet carry text (agent still running).
  const finalMessageByAgent = useMemo(() => {
    const withText = new Map<string, SubAgentMessage>()
    const fallback = new Map<string, SubAgentMessage>()
    for (const m of displayMessages) {
      fallback.set(m.agentId, m)
      if (m.text.length > 0) withText.set(m.agentId, m)
    }
    const result = new Map<string, SubAgentMessage>()
    for (const id of agentIds) {
      const pick = withText.get(id) ?? fallback.get(id)
      if (pick) result.set(id, pick)
    }
    return result
  }, [displayMessages, agentIds])

  // Aggregate summary stats for the collapsed header
  const summaryStats = useMemo(() => {
    let totalDuration = 0
    let totalToolUses = 0
    let hasSummary = false
    let allCompleted = true
    for (const m of messages) {
      if (m.durationMs != null) { totalDuration += m.durationMs; hasSummary = true }
      if (m.toolUseCount != null) totalToolUses += m.toolUseCount
      if (m.status && m.status !== "completed") allCompleted = false
    }
    if (!hasSummary) return null
    return { totalDuration, totalToolUses, allCompleted }
  }, [messages])

  if (messages.length === 0) return null

  return (
    <div>
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center gap-2 w-full min-w-0 text-left py-1 hover:opacity-80 transition-opacity flex-wrap"
      >
        {isOpen
          ? <ChevronDown className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
          : <ChevronRight className="w-3.5 h-3.5 text-muted-foreground shrink-0" />}
        <Users className={cn("w-3.5 h-3.5 shrink-0", style.icon)} />
        <span className={cn("text-xs font-medium", style.label)}>
          {label}
        </span>
        {agentIds.length > 1 && (
          <span className={cn("text-[10px] font-semibold px-1.5 py-0.5 rounded-full", style.countBadge)}>
            {agentIds.length} {countLabel}
          </span>
        )}
        {agentIds.map((id) => {
          const color = agentColorMap.get(id)!
          return (
            <span
              key={id}
              className={cn("text-[10px] px-1.5 py-0 h-4 inline-flex items-center gap-1 rounded border", color.badge)}
            >
              <span className={cn("w-1.5 h-1.5 rounded-full", color.bar)} />
              {agentLabelMap.get(id)}
            </span>
          )
        })}
        {summaryStats ? (
          <span className="text-[10px] text-muted-foreground/50 inline-flex items-center gap-2">
            {summaryStats.allCompleted
              ? <CheckCircle2 className="w-3 h-3 text-green-400" />
              : <XCircle className="w-3 h-3 text-red-400" />}
            <span className="inline-flex items-center gap-0.5">
              <Clock className="w-3 h-3" />
              {formatDuration(summaryStats.totalDuration)}
            </span>
            {summaryStats.totalToolUses > 0 && (
              <span className="inline-flex items-center gap-0.5">
                <Wrench className="w-3 h-3" />
                {summaryStats.totalToolUses}
              </span>
            )}
          </span>
        ) : (
          <span className="text-[10px] text-muted-foreground/50">
            ({agentIds.length} agent{agentIds.length !== 1 ? "s" : ""})
          </span>
        )}
      </button>

      {/* Live transcript is visible even while the panel is collapsed —
          running agents stream here before any return text exists. */}
      {!isOpen && agentIds.map((id) => {
        const ptid = parentToolByAgent.get(id)
        return ptid ? <LiveSubagentTranscript key={id} toolUseId={ptid} /> : null
      })}

      {isOpen && (
        <div className="mt-2 space-y-2">
          {isLoading && (
            <div className="flex items-center gap-2 text-xs text-muted-foreground py-1">
              <Loader2 className="w-3 h-3 animate-spin" />
              Loading agent output...
            </div>
          )}
          {agentIds.map((id) => {
            const color = agentColorMap.get(id) ?? colors[0]
            const msg = finalMessageByAgent.get(id)
            const stats = statsByAgent.get(id)
            const canNavigate = !!sessionSource && !!parentSessionId
            return (
              <AgentReturnItem
                key={id}
                agentLabel={agentLabelMap.get(id) ?? id}
                barColor={color.bar}
                badgeClass={color.badge}
                message={msg}
                stats={stats}
                parentToolUseId={parentToolByAgent.get(id)}
                canNavigate={canNavigate}
                onOpen={() => {
                  if (!canNavigate) return
                  actions.handleLoadSession(
                    sessionSource!.dirName,
                    `${parentSessionId}/subagents/agent-${id}.jsonl`
                  )
                }}
              />
            )
          })}
        </div>
      )}
    </div>
  )
})

// ── Per-agent return block ──────────────────────────────────────────────────

interface AgentReturnItemProps {
  agentLabel: string
  barColor: string
  badgeClass: string
  message: SubAgentMessage | undefined
  stats: { durationMs?: number; toolUseCount?: number; status?: string } | undefined
  parentToolUseId: string | undefined
  canNavigate: boolean
  onOpen: () => void
}

function AgentReturnItem({
  agentLabel,
  barColor,
  badgeClass,
  message,
  stats,
  parentToolUseId,
  canNavigate,
  onOpen,
}: AgentReturnItemProps): React.ReactElement {
  const text = message?.text
  const markdownText = useMemo(() => preprocessImagePaths((text ?? []).join("\n\n")), [text])
  const hasText = (text?.length ?? 0) > 0
  const isRunning = stats?.status != null && stats.status !== "completed" && stats.status !== "async_launched"
  const isCompleted = stats?.status === "completed"

  return (
    <div className="flex gap-0">
      <div className={cn("w-[3px] shrink-0 rounded-full", barColor)} />
      <div className="space-y-1.5 pl-3 min-w-0 flex-1">
        {/* Header: agent label + stats + open button */}
        <div className="flex items-center gap-2 flex-wrap">
          <span className={cn("text-[10px] px-1.5 py-0 h-4 inline-flex items-center gap-1 rounded border", badgeClass)}>
            <span className={cn("w-1.5 h-1.5 rounded-full", barColor)} />
            {agentLabel}
          </span>
          {stats && (
            <span className="text-[10px] text-muted-foreground/60 inline-flex items-center gap-2">
              {isCompleted && <CheckCircle2 className="w-3 h-3 text-green-400/80" />}
              {stats.durationMs != null && (
                <span className="inline-flex items-center gap-0.5">
                  <Clock className="w-3 h-3" />
                  {formatDuration(stats.durationMs)}
                </span>
              )}
              {stats.toolUseCount != null && stats.toolUseCount > 0 && (
                <span className="inline-flex items-center gap-0.5">
                  <Wrench className="w-3 h-3" />
                  {stats.toolUseCount}
                </span>
              )}
            </span>
          )}
          {canNavigate && (
            <button
              onClick={onOpen}
              className="ml-auto inline-flex items-center gap-1 text-[10px] text-muted-foreground/60 hover:text-foreground transition-colors"
              title="Open this sub-agent's full chat session"
            >
              <ExternalLink className="w-3 h-3" />
              Open chat
            </button>
          )}
        </div>

        {/* Final returned text — what the sub-agent handed back to the parent */}
        {hasText ? (
          <div className="text-xs break-words overflow-hidden">
            <ReactMarkdown components={markdownComponents} remarkPlugins={markdownPlugins}>
              {markdownText}
            </ReactMarkdown>
          </div>
        ) : (
          <div className="space-y-1">
            <div className="text-[11px] text-muted-foreground/60 italic inline-flex items-center gap-1.5">
              {isRunning ? (
                <>
                  <Loader2 className="w-3 h-3 animate-spin" />
                  Working — no return yet
                </>
              ) : (
                <>No return message from this agent</>
              )}
            </div>
            {parentToolUseId && <LiveSubagentTranscript toolUseId={parentToolUseId} />}
          </div>
        )}
      </div>
    </div>
  )
}
