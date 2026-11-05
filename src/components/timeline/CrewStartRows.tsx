import { memo, useMemo, useState } from "react"
import { ChevronRight } from "lucide-react"
import ReactMarkdown from "react-markdown"
import type { ToolCall } from "../../../shared/session/types"
import { getCommandText } from "../../../shared/session/toolSummary"
import { useSessionPeek, type SessionPeek } from "@/hooks/useSessionPeek"
import { parseAgentKind, DEFAULT_AGENT_KIND } from "@/lib/agents"
import { crewStarts, startDetails, startedIds, startMessage, type CrewInvocation } from "@/lib/crewCommands"
import { previewLine } from "@/lib/textPreview"
import { toolCallFailed } from "@/lib/toolActivity"
import { cn } from "@/lib/utils"
import { Collapsible, CollapsibleContent } from "@/components/ui/collapsible"
import { markdownComponents, markdownPlugins } from "./markdown-components"
import { SessionRow, type SessionRowState } from "./SessionRow"
import { ToolCallCard } from "./ToolCallCard"

function Markdown({ text, className }: { text: string; className?: string }) {
  return (
    <div className={cn("min-w-0 overflow-auto break-words text-sm", className)}>
      <ReactMarkdown components={markdownComponents} remarkPlugins={markdownPlugins}>{text}</ReactMarkdown>
    </div>
  )
}

/** A labelled fold inside a row's detail: the command that started it. */
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

interface CrewStartProps {
  toolCall: ToolCall
  isAgentActive: boolean
  expandToolPayloads: boolean
}

function crewStartState(toolCall: ToolCall, failed: boolean, peek: SessionPeek, isAgentActive: boolean): SessionRowState {
  if (failed) return "failed"
  if (peek.liveState) return peek.liveState
  if (toolCall.result === null) return isAgentActive ? "starting" : "started"
  return peek.settled ? "finished" : "started"
}

function CrewStartRow({ toolCall, invocation, sessionId, isAgentActive, expandToolPayloads }: CrewStartProps & { invocation: CrewInvocation; sessionId: string | undefined }) {
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
export const CrewStartRows = memo(function CrewStartRows(props: CrewStartProps) {
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
