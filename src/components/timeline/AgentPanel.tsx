import { useState, memo, useMemo } from "react"
import { Users, ChevronRight, ChevronDown, Clock, Wrench, CheckCircle2, XCircle, Loader2, ExternalLink } from "lucide-react"
import { formatDuration, parseSubAgentPath } from "@/lib/format"
import type { SubAgentMessage } from "@/lib/types"
import { LiveSubagentTranscript } from "./LiveSubagentTranscript"
import { buildAgentLabelMap, buildParentToolByAgent } from "./agent-utils"
import { useSubagentContent } from "@/hooks/useSubagentContent"
import { useSessionContext } from "@/contexts/SessionContext"
import ReactMarkdown from "react-markdown"
import { markdownComponents, markdownPlugins, preprocessImagePaths } from "./markdown-components"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"

interface AgentPanelProps {
  messages: SubAgentMessage[]
  expandAll: boolean
  label: string
  countLabel: string
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

  const parentToolByAgent = useMemo(
    () => buildParentToolByAgent([...messages, ...displayMessages]),
    [messages, displayMessages],
  )

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
      <Button
        type="button"
        variant="ghost"
        onClick={() => setOpen(!open)}
        className="h-auto w-full min-w-0 flex-wrap justify-start gap-2 px-0 py-1 text-left whitespace-normal"
      >
        {isOpen
          ? <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" data-icon="inline-start" />
          : <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" data-icon="inline-start" />}
        <Users className="size-3.5 shrink-0 text-muted-foreground" data-icon="inline-start" />
        <span className="text-xs font-medium text-foreground">{label}</span>
        {agentIds.length > 1 && (
          <Badge variant="secondary">
            {agentIds.length} {countLabel}
          </Badge>
        )}
        {agentIds.map((id) => {
          return (
            <Badge key={id} variant="outline">
              {agentLabelMap.get(id)}
            </Badge>
          )
        })}
        {summaryStats ? (
          <span className="inline-flex items-center gap-2 text-xs text-muted-foreground">
            {summaryStats.allCompleted
              ? <CheckCircle2 className="size-3 text-success" data-icon="inline-start" />
              : <XCircle className="size-3 text-destructive" data-icon="inline-start" />}
            <span className="inline-flex items-center gap-0.5">
              <Clock className="size-3" data-icon="inline-start" />
              {formatDuration(summaryStats.totalDuration)}
            </span>
            {summaryStats.totalToolUses > 0 && (
              <span className="inline-flex items-center gap-0.5">
                <Wrench className="size-3" data-icon="inline-start" />
                {summaryStats.totalToolUses}
              </span>
            )}
          </span>
        ) : (
          <span className="text-xs text-muted-foreground">
            ({agentIds.length} agent{agentIds.length !== 1 ? "s" : ""})
          </span>
        )}
      </Button>

      {/* Live transcript is visible even while the panel is collapsed —
          running agents stream here before any return text exists. */}
      {!isOpen && agentIds.map((id) => {
        const ptid = parentToolByAgent.get(id)
        return ptid ? <LiveSubagentTranscript key={id} toolUseId={ptid} /> : null
      })}

      {isOpen && (
        <div className="mt-2 flex flex-col gap-2">
          {isLoading && (
            <div className="flex items-center gap-2 text-xs text-muted-foreground py-1">
              <Loader2 className="size-3 animate-spin" />
              Loading agent output...
            </div>
          )}
          {agentIds.map((id) => {
            const msg = finalMessageByAgent.get(id)
            const stats = statsByAgent.get(id)
            const canNavigate = !!sessionSource && !!parentSessionId
            return (
              <AgentReturnItem
                key={id}
                agentLabel={agentLabelMap.get(id) ?? id}
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
  message: SubAgentMessage | undefined
  stats: { durationMs?: number; toolUseCount?: number; status?: string } | undefined
  parentToolUseId: string | undefined
  canNavigate: boolean
  onOpen: () => void
}

function AgentReturnItem({
  agentLabel,
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
    <div className="border-l pl-3">
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        {/* Header: agent label + stats + open button */}
        <div className="flex items-center gap-2 flex-wrap">
          <Badge variant="outline">
            {agentLabel}
          </Badge>
          {stats && (
            <span className="inline-flex items-center gap-2 text-xs text-muted-foreground">
              {isCompleted && <CheckCircle2 className="size-3 text-success" />}
              {stats.durationMs != null && (
                <span className="inline-flex items-center gap-0.5">
                  <Clock className="size-3" />
                  {formatDuration(stats.durationMs)}
                </span>
              )}
              {stats.toolUseCount != null && stats.toolUseCount > 0 && (
                <span className="inline-flex items-center gap-0.5">
                  <Wrench className="size-3" />
                  {stats.toolUseCount}
                </span>
              )}
            </span>
          )}
          {canNavigate && (
            <Button
              type="button"
              variant="ghost"
              size="xs"
              onClick={onOpen}
              className="ml-auto"
              title="Open this sub-agent's full chat session"
            >
              <ExternalLink data-icon="inline-start" />
              Open chat
            </Button>
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
          <div className="flex flex-col gap-1">
            <div className="inline-flex items-center gap-1.5 text-xs italic text-muted-foreground">
              {isRunning ? (
                <>
                  <Loader2 className="size-3 animate-spin" />
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
