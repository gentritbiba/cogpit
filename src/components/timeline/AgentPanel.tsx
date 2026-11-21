import { useState, memo, useMemo } from "react"
import { Users, ChevronRight, Loader2, ExternalLink } from "lucide-react"
import { cn } from "@/lib/utils"
import { formatDuration, parseSubAgentPath, shortenModel } from "@/lib/format"
import type { SubAgentMessage } from "../../../shared/session/types"
import { LiveSubagentTranscript } from "./LiveSubagentTranscript"
import { buildAgentLabelMap, buildParentToolByAgent, orderAgentsByParent } from "./agent-utils"
import { useSubagentContent } from "@/hooks/useSubagentContent"
import { useSessionContext } from "@/contexts/SessionContext"
import ReactMarkdown from "react-markdown"
import { markdownComponents, markdownPlugins, preprocessMediaPaths } from "./markdown-components"
import { Button } from "@/components/ui/button"
import { capabilitiesForDirName } from "@/lib/agents"

interface AgentPanelProps {
  messages: SubAgentMessage[]
  expandAll: boolean
  /** What one of these agents is called at the start of a line: "Sub-agent", "Background agent". */
  noun: string
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

function toolCallCount(count: number): string {
  return `${count} tool ${count === 1 ? "call" : "calls"}`
}

/**
 * One line for the sub-agents or background agents a turn ran: who they were
 * and what they cost, in the grammar of a tool call's line.
 *
 * When expanded, shows only the FINAL text message returned from each agent to
 * the main agent (what the parent actually received back), plus a low-key
 * button that opens the sub-agent's full chat session in place of the current
 * view — the same behavior as clicking a sub-agent in the right sidebar.
 */
export const AgentPanel = memo(function AgentPanel({
  messages,
  expandAll,
  noun,
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
    let unfinished = false
    for (const m of messages) {
      if (m.durationMs != null) { totalDuration += m.durationMs; hasSummary = true }
      if (m.toolUseCount != null) totalToolUses += m.toolUseCount
      if (m.status && UNFINISHED_ENDINGS.has(m.status)) unfinished = true
    }
    if (!hasSummary) return null
    return { totalDuration, totalToolUses, unfinished }
  }, [messages])
  const agentNames = agentIds.map((id) => agentLabelMap.get(id)).filter(Boolean).join(", ")

  if (messages.length === 0) return null

  return (
    <div className="min-w-0">
      <button
        type="button"
        aria-expanded={isOpen}
        onClick={() => setOpen(!open)}
        className="group/tool flex min-h-8 pointer-fine:min-h-7 w-full min-w-0 items-center gap-2 rounded-md px-2 py-0.5 text-left text-[13px] leading-5 transition-colors hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <span className={cn("flex size-4 shrink-0 items-center justify-center text-muted-foreground", summaryStats?.unfinished && "text-destructive")}>
          <Users className="size-3.5" aria-hidden="true" />
        </span>
        <span className="flex min-w-0 flex-1 items-baseline gap-1.5">
          <span className="shrink-0 font-medium text-foreground/90">
            {agentIds.length === 1 ? noun : `${agentIds.length} ${noun.toLowerCase()}s`}
          </span>
          <span className="min-w-0 truncate text-muted-foreground" title={agentNames}>{agentNames}</span>
        </span>
        {summaryStats && (
          <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
            {summaryStats.unfinished && <span className="text-destructive">Did not finish · </span>}
            {formatDuration(summaryStats.totalDuration)}
            {summaryStats.totalToolUses > 0 && ` · ${toolCallCount(summaryStats.totalToolUses)}`}
          </span>
        )}
        <ChevronRight
          className={cn(
            "size-3.5 shrink-0 text-muted-foreground transition-[transform,opacity] pointer-fine:opacity-0 pointer-fine:group-hover/tool:opacity-100 pointer-fine:group-focus-visible/tool:opacity-100",
            isOpen && "rotate-90 pointer-fine:opacity-100",
          )}
          aria-hidden="true"
        />
      </button>

      {/* Live transcript is visible even while the panel is collapsed —
          running agents stream here before any return text exists. */}
      {!isOpen && agentIds.map((id) => {
        const toolUseId = liveToolUseId(id)
        return toolUseId ? <LiveSubagentTranscript key={id} toolUseId={toolUseId} /> : null
      })}

      {isOpen && (
        <div className="motion-enter mb-1 ml-[15px] mt-1 flex flex-col gap-3">
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
        <div className="group/agent flex min-h-6 flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
          <span className="text-[13px] font-medium text-foreground/90">{agentLabel}</span>
          {ending && <span className={ending === "Failed" ? "text-destructive" : "text-warning"}>{ending}</span>}
          {runLabel && <span>{runLabel}</span>}
          {stats?.durationMs != null && <span className="tabular-nums">{formatDuration(stats.durationMs)}</span>}
          {stats?.toolUseCount != null && stats.toolUseCount > 0 && (
            <span className="tabular-nums">{toolCallCount(stats.toolUseCount)}</span>
          )}
          {canNavigate && (
            <Button
              type="button"
              variant="ghost"
              size="xs"
              onClick={onOpen}
              className="ml-auto transition-opacity pointer-fine:opacity-0 pointer-fine:group-hover/agent:opacity-100 pointer-fine:focus-visible:opacity-100"
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
