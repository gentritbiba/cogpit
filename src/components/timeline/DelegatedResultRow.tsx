import ReactMarkdown from "react-markdown"
import type { TaskWakeup } from "../../../shared/contracts/taskWakeup"
import type { AgentKind } from "@/lib/agents"
import { useSessionPeek } from "@/hooks/useSessionPeek"
import { useStartedSession } from "@/lib/startedSessions"
import { previewLine } from "@/lib/textPreview"
import { markdownComponents, markdownPlugins } from "./markdown-components"
import { SessionRow, type SessionRowState } from "./SessionRow"

interface ChildResult {
  turn?: { reply?: unknown } | null
  filesChanged?: unknown
  /** Changed files a long result left out of `filesChanged`. */
  filesChangedOmitted?: unknown
}

function describeResult(result: unknown): { reply: string; files: number } {
  if (typeof result === "string") return { reply: result, files: 0 }
  const { turn, filesChanged, filesChangedOmitted } = (result ?? {}) as ChildResult
  return {
    reply: typeof turn?.reply === "string" ? turn.reply : "",
    files: (Array.isArray(filesChanged) ? filesChanged.length : 0) + (typeof filesChangedOmitted === "number" ? filesChangedOmitted : 0),
  }
}

const WAKEUP_STATE: Record<TaskWakeup["state"], SessionRowState> = {
  running: "working",
  completed: "finished",
  error: "failed",
  cancelled: "cancelled",
}

/** Who a session this one started is: the session list's word for it, else what the command that started it said. */
function useDelegatedSession(sessionId: string): { kind: AgentKind | null; title: string; open: () => void } {
  const peek = useSessionPeek(sessionId)
  const started = useStartedSession(sessionId)
  return {
    kind: peek.kind ?? started?.kind ?? null,
    title: peek.title ?? started?.name ?? "Delegated session",
    open: peek.open,
  }
}

/** The prompt that wakes this session when a session it started finishes, shown as that session reporting back. */
export function DelegatedResultRow({ wakeup, timestamp }: { wakeup: TaskWakeup; timestamp?: string }) {
  const session = useDelegatedSession(wakeup.childSessionId)
  const { reply, files } = describeResult(wakeup.result)
  const changed = files ? `${files} ${files === 1 ? "file" : "files"} changed` : ""
  const preview = previewLine(reply) || changed || "No reply"
  return (
    <SessionRow
      kind={session.kind}
      state={WAKEUP_STATE[wakeup.state]}
      title={session.title}
      preview={preview}
      time={timestamp}
      onOpen={session.open}
      detail={reply ? (
        <div className="flex flex-col gap-1.5 border-l border-border/60 pl-3">
          <div className="max-h-[32rem] overflow-auto break-words text-sm">
            <ReactMarkdown components={markdownComponents} remarkPlugins={markdownPlugins}>{reply}</ReactMarkdown>
          </div>
          {changed && <p className="text-xs text-muted-foreground">{changed}</p>}
        </div>
      ) : undefined}
    />
  )
}

/** The prompt that wakes this session while a session it started is stuck: it asked something, or its queue is. */
export function DelegatedAttentionRow({ childSessionId, detail, timestamp }: { childSessionId: string; detail: string; timestamp?: string }) {
  const session = useDelegatedSession(childSessionId)
  return (
    <SessionRow
      kind={session.kind}
      state="needs-you"
      statusLabel="Needs attention"
      title={session.title}
      preview={previewLine(detail)}
      time={timestamp}
      onOpen={session.open}
    />
  )
}
