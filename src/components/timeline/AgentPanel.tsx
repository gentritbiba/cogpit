import { useState, memo, useMemo } from "react"
import { Users, ChevronRight, ChevronDown, Clock, Wrench, CheckCircle2, XCircle, Loader2, ExternalLink } from "lucide-react"
import { cn } from "@/lib/utils"
import { formatDuration, parseSubAgentPath, shortenModel } from "@/lib/format"
import type { SubAgentMessage } from "../../../shared/session/types"
import { LiveSubagentTranscript } from "./LiveSubagentTranscript"
import { buildAgentLabelMap, buildParentToolByAgent, orderAgentsByParent } from "./agent-utils"
import { useSubagentContent } from "@/hooks/useSubagentContent"
import { useSessionContext } from "@/contexts/SessionContext"
import ReactMarkdown from "react-markdown"
import { markdownComponents, markdownPlugins, preprocessMediaPaths } from "./markdown-components"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { capabilitiesForDirName } from "@/lib/agents"

interface AgentPanelProps {
  messages: SubAgentMessage[]
  expandAll: boolean
  label: string
  countLabel: string
  /** Calls whose own row streams their agent's live output, so the panel leaves it out. */
  liveOnCallRow?: ReadonlySet<string>
}

/** How an agent that stopped without completing ended, by the status its transcript recorded. */
const UNFINISHED_ENDINGS: ReadonlyMap<string, "Failed" | "Interrupted" | "Cancelled"> = new Map([
  ["failed", "Failed"],
  ["error", "Failed"],
  ["errored", "Failed"],
  ["interrupted", "Interrupted"],
  ["cancelled", "Cancelled"],
  ["canceled", "Cancelled"],
])

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
  liveOnCallRow,
}: AgentPanelProps): React.ReactElement | null {
  const [open, setOpen] = useState(false)
  const isOpen = expandAll || open

  const { sessionSource, actions } = useSessionContext()
  const hasSubagentTranscripts = capabilitiesForDirName(sessionSource?.dirName).subagentTranscripts
  const { enrichedMessages: displayMessages, isLoading, unavailable } =
    useSubagentContent(messages, isOpen && hasSubagentTranscripts)

  // Parent session id used to construct sub-agent file paths. Mirrors the
  // logic in AgentsPanel (sidebar) so navigation is consistent.
  const parentSessionId = useMemo(() => {
    if (!sessionSource?.fileName) return null
    const sub = parseSubAgentPath(sessionSource.fileName)
    if (sub) return sub.parentSessionId
    const match = sessionSource.fileName.match(/^([^/]+)\.jsonl$/)
    return match?.[1] ?? null
  }, [sessionSource])

  const allMessages = useMemo(() => [...messages, ...displayMessages], [messages, displayMessages])
  const orderedAgents = useMemo(() => orderAgentsByParent(allMessages), [allMessages])
  const agentIds = useMemo(() => orderedAgents.map((agent) => agent.agentId), [orderedAgents])
  const agentLabelMap = useMemo(() => buildAgentLabelMap(displayMessages), [displayMessages])

  // Per-agent stats — merge anything present on the launch event summary or on
  // individual progress messages. The original `messages` array (not enriched)
  // always carries these on the summary/launch event.
  const statsByAgent = useMemo(() => {
    const map = new Map<string, { durationMs?: number; toolUseCount?: number; status?: string }>()
    for (const m of allMessages) {
      const existing = map.get(m.agentId) ?? {}
      if (m.durationMs != null) existing.durationMs = m.durationMs
      if (m.toolUseCount != null) existing.toolUseCount = m.toolUseCount
      if (m.status) existing.status = m.status
      map.set(m.agentId, existing)
    }
    return map
  }, [allMessages])

  // The model an agent ran on, and the effort its Agent call asked for.
  const runByAgent = useMemo(() => {
    const map = new Map<string, { model?: string; effort?: string }>()
    for (const m of allMessages) {
      const existing = map.get(m.agentId) ?? {}
      if (m.model) existing.model = m.model
      if (m.effort) existing.effort = m.effort
      map.set(m.agentId, existing)
    }
    return map
  }, [allMessages])

  const parentToolByAgent = useMemo(() => buildParentToolByAgent(allMessages), [allMessages])
  const liveToolUseId = (agentId: string) => {
    const toolUseId = parentToolByAgent.get(agentId)
    return toolUseId && !liveOnCallRow?.has(toolUseId) ? toolUseId : undefined
  }

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
        const toolUseId = liveToolUseId(id)
        return toolUseId ? <LiveSubagentTranscript key={id} toolUseId={toolUseId} /> : null
      })}

      {isOpen && (
        <div className="motion-enter mt-2 flex flex-col gap-2">
          {unavailable ? (
            <div className="py-1 text-xs italic text-muted-foreground">
              Sub-agent transcripts aren't available in a shared session.
            </div>
          ) : isLoading && (
            <div className="flex items-center gap-2 text-xs text-muted-foreground py-1">
              <Loader2 className="size-3 animate-spin" />
              Loading agent output...
            </div>
          )}
          {orderedAgents.map(({ agentId: id, depth }) => {
            const msg = finalMessageByAgent.get(id)
            const stats = statsByAgent.get(id)
            // Opening a sub-agent chat is a session load, which a guest
            // cannot perform, so the button would do nothing at all.
            const canNavigate = hasSubagentTranscripts && !!sessionSource && !!parentSessionId && !unavailable
            return (
              <AgentReturnItem
                key={id}
                agentLabel={agentLabelMap.get(id) ?? id}
                message={msg}
                stats={stats}
                run={runByAgent.get(id)}
                depth={depth}
                liveToolUseId={liveToolUseId(id)}
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
  run: { model?: string; effort?: string } | undefined
  /** How many agents deep it was launched: 0 for one the main thread started. */
  depth: number
  /** The call whose live output this item streams, unless that call's own row does. */
  liveToolUseId: string | undefined
  canNavigate: boolean
  onOpen: () => void
}

function AgentReturnItem({
  agentLabel,
  message,
  stats,
  run,
  depth,
  liveToolUseId,
  canNavigate,
  onOpen,
}: AgentReturnItemProps): React.ReactElement {
  const runLabel = [run?.model ? shortenModel(run.model) : null, run?.effort ? `${run.effort} effort` : null]
    .filter(Boolean)
    .join(" · ")
  const text = message?.text
  const markdownText = useMemo(() => preprocessMediaPaths((text ?? []).join("\n\n")), [text])
  const hasText = (text?.length ?? 0) > 0
  const status = stats?.status
  const isCompleted = status === "completed"
  const ending = status ? UNFINISHED_ENDINGS.get(status) : undefined
  const isRunning = status != null && !isCompleted && !ending && status !== "async_launched"

  return (
    <div className={cn("border-l pl-3", depth === 1 && "ml-4", depth >= 2 && "ml-8")}>
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        {/* Header: agent label + stats + open button */}
        <div className="flex items-center gap-2 flex-wrap">
          <Badge variant="outline">
            {agentLabel}
          </Badge>
          {runLabel && <span className="text-xs text-muted-foreground">{runLabel}</span>}
          {stats && (
            <span className="inline-flex items-center gap-2 text-xs text-muted-foreground">
              {isCompleted && <CheckCircle2 className="size-3 text-success" />}
              {ending && (
                <span className={cn("inline-flex items-center gap-0.5", ending === "Failed" ? "text-destructive" : "text-warning")}>
                  <XCircle className="size-3" />
                  {ending}
                </span>
              )}
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
              ) : ending ? (
                <>{ending} before returning anything</>
              ) : (
                <>No return message from this agent</>
              )}
            </div>
            {liveToolUseId && <LiveSubagentTranscript toolUseId={liveToolUseId} />}
          </div>
        )}
      </div>
    </div>
  )
}
