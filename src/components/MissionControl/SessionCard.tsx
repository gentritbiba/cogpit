/**
 * One session, rendered as a Mission Control card.
 *
 * Deliberately sparse: what the session is, what state it's in, and what it
 * last said — with the space spent on actual text. A single thin footer
 * carries the diffstat and context pressure; every other metric lives in the
 * session itself.
 */

import { memo } from "react"
import { CheckCircle2, ChevronRight, MessageCircleQuestion, XCircle } from "lucide-react"
import type { LucideIcon } from "lucide-react"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { formatRelativeTime, shortenModel } from "@/lib/format"
import { LineCounts } from "@/components/shared/ChangeCounts"
import { sessionTitle } from "@/components/LiveSessions/sessionListView"
import type { PermissionDecision } from "@/lib/permissionApi"
import type { UserQuestionAnswerMap } from "@/lib/askUserApi"
import type {
  MissionControlCurrentTool,
  MissionControlSummary,
} from "../../../shared/contracts/missionControl"
import { PermissionPrompt } from "./PermissionPrompt"
import { QuestionPrompt } from "./QuestionPrompt"
import { contextPercentColor, type MissionCard, type MissionCardState } from "./missionControlView"

interface StateStyle {
  label: string
  text: string
  /** Border, surface and ring for the card shell. */
  shell: string
  /** Null for a running session, which gets the pulsing dot instead. */
  icon: LucideIcon | null
}

const STATE_STYLES: Record<MissionCardState, StateStyle> = {
  awaiting_approval: {
    label: "Waiting for approval",
    text: "text-warning",
    shell: "border-warning/40 bg-warning/5",
    icon: MessageCircleQuestion,
  },
  awaiting_question: {
    label: "Waiting for your answer",
    text: "text-info",
    shell: "border-info/40 bg-info/5",
    icon: MessageCircleQuestion,
  },
  awaiting_answer: {
    label: "Waiting for your answer",
    text: "text-warning",
    shell: "border-warning/40 bg-warning/5",
    icon: MessageCircleQuestion,
  },
  running: { label: "Running", text: "text-info", shell: "border-border", icon: null },
  done: { label: "Done", text: "text-success", shell: "border-border", icon: CheckCircle2 },
  failed: { label: "Failed", text: "text-destructive", shell: "border-destructive/40", icon: XCircle },
}

function StateIcon({ icon: Icon }: { icon: LucideIcon | null }) {
  if (!Icon) {
    return <span className="size-2 shrink-0 rounded-full bg-info" />
  }
  return <Icon className="size-3.5 shrink-0" />
}

interface SessionCardProps {
  card: MissionCard
  customName?: string
  projectLabel: string
  responding: Set<string>
  /** Tool-use ids the server has since forgotten. */
  goneQuestions: Set<string>
  compact?: boolean
  onOpen: () => void
  onRespond: (sessionId: string, requestId: string, behavior: PermissionDecision) => void
  onAnswerQuestion: (sessionId: string, toolUseId: string, answers: UserQuestionAnswerMap) => void
}

export const SessionCard = memo(function SessionCard({
  card,
  customName,
  projectLabel,
  responding,
  goneQuestions,
  compact = false,
  onOpen,
  onRespond,
  onAnswerQuestion,
}: SessionCardProps) {
  const { session, state, summary, permissions, questions } = card
  const style = STATE_STYLES[state]
  const request = permissions[0]
  const question = questions[0]
  const blocked = Boolean(request || question)
  const title = sessionTitle(session, customName)

  return (
    <div
      className={cn(
        "group flex min-w-0 flex-col gap-2 rounded-lg border bg-card p-3 text-left transition-colors hover:border-foreground/20",
        style.shell,
        compact && "gap-1.5 py-2",
      )}
    >
      <Button
        variant="ghost"
        onClick={onOpen}
        className="-m-1 h-auto min-w-0 flex-col items-stretch justify-start gap-1 whitespace-normal p-1 text-left"
        aria-label={`Open session ${title}`}
      >
        <span className="flex min-w-0 items-center gap-1.5">
          <span className="min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground">
            {projectLabel}
          </span>
          {summary?.model && (
            <span className="shrink-0 font-mono text-xs text-muted-foreground">
              {shortenModel(summary.model)}
            </span>
          )}
          <ChevronRight data-icon="inline-end" className="shrink-0 text-transparent transition-colors group-hover:text-muted-foreground" />
        </span>
        <span
          className={cn(
            "text-sm font-medium leading-snug text-foreground",
            compact ? "truncate" : "line-clamp-2",
          )}
        >
          {title}
        </span>
      </Button>

      <div className={cn("flex items-center gap-1.5 text-xs font-medium", style.text)}>
        <StateIcon icon={style.icon} />
        <span className="truncate">{style.label}</span>
        <span className="ml-auto shrink-0 font-mono text-xs font-normal text-muted-foreground">
          {formatRelativeTime(session.lastActivityAt || session.lastModified)}
        </span>
      </div>

      {request && (
        <PermissionPrompt
          request={request}
          queued={permissions.length - 1}
          responding={responding.has(request.requestId)}
          onRespond={(requestId, behavior) => onRespond(session.sessionId, requestId, behavior)}
        />
      )}

      {/* A pending permission outranks a question when a session has both. */}
      {!request && question && (
        <QuestionPrompt
          key={question.toolUseId}
          request={question}
          responding={responding.has(question.toolUseId)}
          gone={goneQuestions.has(question.toolUseId)}
          onAnswer={(toolUseId, answers) => onAnswerQuestion(session.sessionId, toolUseId, answers)}
          onOpenSession={onOpen}
        />
      )}

      {!blocked && summary?.currentTool && <CurrentTool tool={summary.currentTool} />}

      {!compact && !blocked && summary?.lastAssistantText && (
        <p className="line-clamp-4 text-sm leading-relaxed text-muted-foreground">
          {summary.lastAssistantText}
        </p>
      )}

      {summary && <Footer summary={summary} />}
    </div>
  )
})

function CurrentTool({ tool }: { tool: MissionControlCurrentTool }) {
  return (
    <div className="flex min-w-0 items-center gap-2 rounded-md bg-muted/50 px-2.5 py-2">
      <span className="shrink-0 font-mono text-xs text-muted-foreground">
        {tool.name}
      </span>
      <code className="min-w-0 flex-1 truncate font-mono text-xs text-foreground/80">
        {tool.summary}
      </code>
    </div>
  )
}

/** One thin line — diffstat left, context pressure right — or nothing at all. */
function Footer({ summary }: { summary: MissionControlSummary }) {
  const files = summary.filesTotal
  const context = summary.context
  const hasFiles = files.count > 0
  const hasContext = context !== null && context.used > 0
  if (!hasFiles && !hasContext) return null

  return (
    <div className="mt-auto flex items-center gap-2 border-t pt-2 font-mono text-xs text-muted-foreground">
      {hasFiles && (
        <span className="flex min-w-0 items-center gap-1.5">
          <span className="truncate">
            {files.count} file{files.count === 1 ? "" : "s"}
          </span>
          <LineCounts add={files.additions} del={files.deletions} />
        </span>
      )}
      {hasContext && (
        <span className={cn("ml-auto shrink-0", contextPercentColor(context.percent))}>
          ctx {context.percent}%
        </span>
      )}
    </div>
  )
}
