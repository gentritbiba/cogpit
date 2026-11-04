import { memo, useMemo, useState } from "react"
import { ChevronRight } from "lucide-react"
import ReactMarkdown from "react-markdown"
import type { SubAgentMessage, ToolCall } from "../../../shared/session/types"
import { getCommandText, getToolPresentation } from "../../../shared/session/toolSummary"
import { useSessionContext } from "@/contexts/SessionContext"
import { useSessionPeek, type SessionPeek } from "@/hooks/useSessionPeek"
import { useTaskOutcome } from "@/lib/startedSessions"
import type { TaskNotification } from "@/lib/userMessageContent"
import { agentKindForDirName, capabilitiesForDirName, parseAgentKind, DEFAULT_AGENT_KIND } from "@/lib/agents"
import { crewStarts, startDetails, startedIds, startMessage, startsCrewSession, type CrewInvocation } from "@/lib/crewCommands"
import { parseSubAgentPath } from "@/lib/format"
import { previewLine } from "@/lib/textPreview"
import { toolCallFailed } from "@/lib/toolActivity"
import { cn } from "@/lib/utils"
import { Collapsible, CollapsibleContent } from "@/components/ui/collapsible"
import { LiveSubagentTranscript } from "./LiveSubagentTranscript"
import { markdownComponents, markdownPlugins } from "./markdown-components"
import { SessionRow, type SessionRowState } from "./SessionRow"
import { ToolCallCard } from "./ToolCallCard"

/** A call that starts another session or agent, which the timeline shows as that session rather than as a tool. */
export function isSpawnCall(toolCall: ToolCall): boolean {
  return getToolPresentation(toolCall).label === "Spawn agent" || startsCrewSession(toolCall)
}

function Markdown({ text, className }: { text: string; className?: string }) {
  return (
    <div className={cn("min-w-0 overflow-auto break-words text-sm", className)}>
      <ReactMarkdown components={markdownComponents} remarkPlugins={markdownPlugins}>{text}</ReactMarkdown>
    </div>
  )
}

/** A labelled fold inside a row's detail: the brief it was given, the command that started it. */
function DetailFold({ label, children }: { label: string; children: React.ReactNode }) {
  const [open, setOpen] = useState(false)
  return (
    <div className="min-w-0">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className="-ml-1 flex items-center gap-1 rounded px-1 py-0.5 text-xs text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <ChevronRight aria-hidden="true" className={cn("size-3 transition-transform", open && "rotate-90")} />
        {label}
      </button>
      <Collapsible open={open}>
        <CollapsibleContent>
          <div className="mt-1 min-w-0">{children}</div>
        </CollapsibleContent>
      </Collapsible>
    </div>
  )
}

interface SpawnRowProps {
  toolCall: ToolCall
  isAgentActive: boolean
  expandToolPayloads: boolean
}

// ── Crew starts ─────────────────────────────────────────────────────────────

function crewStartState(toolCall: ToolCall, failed: boolean, peek: SessionPeek, isAgentActive: boolean): SessionRowState {
  if (failed) return "failed"
  if (peek.liveState) return peek.liveState
  if (toolCall.result === null) return isAgentActive ? "starting" : "started"
  return peek.settled ? "finished" : "started"
}

function CrewStartRow({ toolCall, invocation, sessionId, isAgentActive, expandToolPayloads }: SpawnRowProps & { invocation: CrewInvocation; sessionId: string | undefined }) {
  const peek = useSessionPeek(sessionId ?? null)
  const brief = useMemo(() => startMessage(invocation, getCommandText(toolCall.input)), [invocation, toolCall.input])
  const details = startDetails(invocation)
  const failed = toolCall.result !== null && !sessionId && toolCallFailed(toolCall)
  const state = crewStartState(toolCall, failed, peek, isAgentActive)
  const kind = peek.kind ?? parseAgentKind(invocation.flags.agent, DEFAULT_AGENT_KIND)
  const title = peek.title ?? invocation.flags.name ?? "New session"
  return (
    <SessionRow
      kind={kind}
      state={state}
      statusLabel={failed ? "Couldn't start" : peek.activity ?? undefined}
      title={title}
      preview={previewLine(brief || peek.firstMessage || "") || details.join(" · ")}
      time={toolCall.timestamp}
      onOpen={sessionId ? peek.open : undefined}
      detail={(
        <div className="flex flex-col gap-1.5 border-l border-border/60 pl-3">
          {details.length > 0 && <p className="text-xs text-muted-foreground">{details.join(" · ")}</p>}
          {brief ? <Markdown text={brief} className="max-h-80" /> : <p className="text-xs text-muted-foreground">The brief was read from a file.</p>}
          <DetailFold label="Command">
            <ToolCallCard toolCall={toolCall} expandToolPayloads={expandToolPayloads} isAgentActive={isAgentActive} />
          </DetailFold>
        </div>
      )}
    />
  )
}

/** A shell command that started crew sessions: one row per session, in the order it started them. */
const CrewStartRows = memo(function CrewStartRows(props: SpawnRowProps) {
  const { toolCall } = props
  const command = getCommandText(toolCall.input)
  const invocations = useMemo(() => crewStarts(command), [command])
  const ids = useMemo(() => startedIds(toolCall.result, command), [toolCall.result, command])
  return (
    <div className="flex flex-col" data-tool-call-id={toolCall.id}>
      {invocations.map((invocation, index) => (
        <CrewStartRow key={ids[index] ?? `start-${index}`} {...props} invocation={invocation} sessionId={ids[index]} />
      ))}
    </div>
  )
})

// ── Agents a turn spawns ────────────────────────────────────────────────────

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : ""
}

/** What a sub-agent call returned, without the trailer that tells the parent how to resume it. */
function agentReply(result: string | null): string {
  return (result ?? "").replace(/\n*agentId:[^\n]*(?:\n[\s\S]*)?$/, "").trim()
}

const FAILED_AGENT = /^(?:failed|error|errored|interrupted)$/

/**
 * Where an agent a call started stands, and what it said. A launch that
 * failed says so at once. A background agent's call returns only a receipt,
 * so it reports through a later notification; an agent whose activity the
 * transcript records, including one that keeps working long after its
 * spawn call returned, reports through that; anything else through the
 * call's own result.
 */
export function subagentProgress({ toolCall, activity, outcome, background, isAgentActive, isLive }: {
  toolCall: ToolCall
  activity?: SubAgentMessage
  outcome?: TaskNotification
  background: boolean
  isAgentActive: boolean
  isLive: boolean
}): { state: SessionRowState; reply: string } {
  if (toolCall.isError) return { state: "failed", reply: toolCall.result?.trim() ?? "" }
  const waiting = (live: boolean): SessionRowState => (live ? "working" : "started")
  if (background) {
    if (!outcome) return { state: toolCall.result === null ? waiting(isAgentActive) : waiting(isLive), reply: "" }
    return { state: FAILED_AGENT.test(outcome.status) ? "failed" : "finished", reply: outcome.result }
  }
  if (activity?.status) {
    const reply = activity.text.filter(Boolean).at(-1)?.trim() ?? ""
    if (activity.status === "completed") return { state: "finished", reply: reply || agentReply(toolCall.result) }
    if (FAILED_AGENT.test(activity.status)) return { state: "failed", reply }
    return { state: waiting(toolCall.result === null ? isAgentActive : isLive), reply }
  }
  if (toolCall.result === null) return { state: waiting(isAgentActive), reply: "" }
  return { state: toolCallFailed(toolCall) ? "failed" : "finished", reply: agentReply(toolCall.result) }
}

/** A Task, Agent or spawn_agent call, shown as the agent it started. */
const SubagentRow = memo(function SubagentRow({ toolCall, isAgentActive, activity }: SpawnRowProps & { activity?: SubAgentMessage }) {
  const { sessionSource, actions, isLive } = useSessionContext()
  const input = toolCall.input
  const type = text(input.subagent_type) || text(input.agent_type)
  const brief = text(input.prompt) || text(input.message) || text(input.task)
  const title = text(input.description) || text(input.name) || previewLine(brief, 80) || type || "Agent"
  const background = input.run_in_background === true || /^Async agent launched/.test(toolCall.result ?? "")
  const outcome = useTaskOutcome(toolCall.id)
  const { state, reply } = subagentProgress({ toolCall, activity, outcome, background, isAgentActive, isLive })
  const agentId = activity?.agentId
  const parentSessionId = useMemo(() => {
    const fileName = sessionSource?.fileName
    if (!fileName) return null
    return parseSubAgentPath(fileName)?.parentSessionId ?? /^([^/]+)\.jsonl$/.exec(fileName)?.[1] ?? null
  }, [sessionSource?.fileName])
  const canOpen = Boolean(agentId && parentSessionId && sessionSource && capabilitiesForDirName(sessionSource.dirName).subagentTranscripts)
  return (
    <SessionRow
      kind={sessionSource ? agentKindForDirName(sessionSource.dirName) : null}
      state={state}
      statusLabel={state === "working" && background ? "In background" : undefined}
      title={title}
      preview={(reply && previewLine(reply)) || [type, previewLine(brief)].filter(Boolean).join(" · ")}
      time={toolCall.timestamp}
      onOpen={canOpen ? () => actions.handleLoadSession(sessionSource!.dirName, `${parentSessionId}/subagents/agent-${agentId}.jsonl`) : undefined}
      defaultOpen={state === "working" && !background}
      detail={(
        <div className="flex flex-col gap-1.5 border-l border-border/60 pl-3" data-tool-call-id={toolCall.id}>
          {reply && <Markdown text={reply} className={cn("max-h-[32rem]", state === "failed" && "text-destructive")} />}
          {toolCall.result === null && <LiveSubagentTranscript toolUseId={toolCall.id} />}
          {brief && (
            <DetailFold label="Brief">
              <Markdown text={brief} className="max-h-80 text-muted-foreground" />
            </DetailFold>
          )}
        </div>
      )}
    />
  )
})

/** The row for a call that starts sessions or agents. */
export function SpawnedSessionRows(props: SpawnRowProps & { activity?: SubAgentMessage }) {
  return getToolPresentation(props.toolCall).label === "Spawn agent"
    ? <SubagentRow {...props} />
    : <CrewStartRows {...props} />
}
