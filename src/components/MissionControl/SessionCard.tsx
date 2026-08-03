/**
 * One session, rendered as a Mission Control card.
 *
 * Density is the point: state, current work, diffstat, metrics and context
 * pressure at a glance, so a wall of these is scannable without opening any.
 */

import { memo } from "react"
import { CheckCircle2, ChevronRight, MessageCircleQuestion, XCircle } from "lucide-react"
import type { LucideIcon } from "lucide-react"
import { cn } from "@/lib/utils"
import { formatDuration, formatRelativeTime, formatTokenCount, shortenModel } from "@/lib/format"
import { getToolTextStyle } from "@/components/timeline/ToolCallCard"
import { LineCounts } from "@/components/shared/ChangeCounts"
import { sessionTitle } from "@/components/LiveSessions/sessionListView"
import type { PermissionDecision } from "@/lib/permissionApi"
import type { UserQuestionAnswerMap } from "@/lib/askUserApi"
import type {
  MissionControlContext,
  MissionControlCurrentTool,
  MissionControlSummary,
} from "../../../shared/contracts/missionControl"
import { PermissionPrompt } from "./PermissionPrompt"
import { QuestionPrompt } from "./QuestionPrompt"
import { contextBarColor, type MissionCard, type MissionCardState } from "./missionControlView"

const CAPTION = "text-[9px] uppercase tracking-wider text-muted-foreground/70"

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
    text: "text-amber-400",
    shell: "border-amber-500/60 bg-amber-500/[0.045] ring-1 ring-amber-500/20",
    icon: MessageCircleQuestion,
  },
  // Pink separates "answer a question" from "approve a tool" at a glance,
  // matching the colour the rest of the app already uses for AskUserQuestion.
  awaiting_question: {
    label: "Waiting for your answer",
    text: "text-pink-400",
    shell: "border-pink-500/60 bg-pink-500/[0.05] ring-1 ring-pink-500/20",
    icon: MessageCircleQuestion,
  },
  awaiting_answer: {
    label: "Waiting for your answer",
    text: "text-amber-400",
    shell: "border-amber-500/40 bg-amber-500/[0.03]",
    icon: MessageCircleQuestion,
  },
  running: { label: "Running", text: "text-blue-400", shell: "border-border/70", icon: null },
  done: { label: "Done", text: "text-green-400", shell: "border-green-500/25", icon: CheckCircle2 },
  failed: { label: "Failed", text: "text-red-400", shell: "border-red-500/35", icon: XCircle },
}

function StateIcon({ icon: Icon }: { icon: LucideIcon | null }) {
  // animate-pulse/ping are globally disabled for GPU reasons; live-pulse is the
  // sanctioned pulsing indicator.
  if (!Icon) return <span className="live-pulse size-[7px] shrink-0 rounded-full bg-blue-400" />
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
  const context = summary?.context ?? null
  const title = sessionTitle(session, customName)

  return (
    <div
      className={cn(
        "group flex min-w-0 flex-col gap-2 rounded-lg border bg-elevation-2 p-3 text-left transition-colors",
        style.shell,
        compact && "gap-1.5 py-2",
      )}
    >
      <button
        type="button"
        onClick={onOpen}
        className="flex min-w-0 flex-col gap-1 text-left"
        aria-label={`Open session ${title}`}
      >
        <span className="flex min-w-0 items-center gap-1.5">
          <span className="min-w-0 flex-1 truncate font-mono text-[10.5px] text-muted-foreground">
            {projectLabel}
          </span>
          {summary?.model && (
            <span className="shrink-0 font-mono text-[10px] text-muted-foreground/60">
              {shortenModel(summary.model)}
            </span>
          )}
          <ChevronRight className="size-3 shrink-0 text-muted-foreground/0 transition-colors group-hover:text-muted-foreground/60" />
        </span>
        <span className="truncate text-[13.5px] font-semibold leading-tight tracking-tight text-foreground/95">
          {title}
        </span>
      </button>

      <div className={cn("flex items-center gap-1.5 text-[11.5px] font-semibold", style.text)}>
        <StateIcon icon={style.icon} />
        <span className="truncate">{style.label}</span>
        <span className="ml-auto shrink-0 font-mono text-[10.5px] font-normal text-muted-foreground/70">
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
          request={question}
          responding={responding.has(question.toolUseId)}
          gone={goneQuestions.has(question.toolUseId)}
          onAnswer={(toolUseId, answers) => onAnswerQuestion(session.sessionId, toolUseId, answers)}
          onOpenSession={onOpen}
        />
      )}

      {!blocked && summary?.currentTool && <CurrentTool tool={summary.currentTool} />}

      {!compact && !blocked && summary?.lastAssistantText && (
        <p className="line-clamp-2 text-[11.5px] leading-relaxed text-muted-foreground">
          {summary.lastAssistantText}
        </p>
      )}

      {!compact && summary && summary.files.length > 0 && <ChangedFiles summary={summary} />}

      {!compact && summary && summary.toolTrail.length > 0 && (
        <ToolTrail trail={summary.toolTrail} totalCalls={summary.totalToolCalls} />
      )}

      <div
        className={cn(
          "mt-auto flex items-stretch border-t border-border/40 pt-2",
          // Full-width list rows would otherwise fling the three metrics to
          // opposite ends of the screen.
          compact && "max-w-xs gap-6",
        )}
      >
        {/* A session with one event has no span yet; "0ms" reads as noise. */}
        <Metric label="Elapsed" value={summary?.elapsedMs ? formatDuration(summary.elapsedMs) : "—"} />
        <Metric label="Turns" value={String(session.turnCount ?? summary?.turnCount ?? 0)} />
        <Metric label="Tokens" value={summary ? formatTokenCount(summary.tokens.total) : "—"} />
      </div>

      {context && context.used > 0 && <ContextBar context={context} />}
    </div>
  )
})

function CurrentTool({ tool }: { tool: MissionControlCurrentTool }) {
  return (
    <div className="flex min-w-0 items-center gap-1.5 rounded-md border border-border/40 bg-black/25 px-2 py-1.5">
      <span className={cn("shrink-0 font-mono text-[10px]", getToolTextStyle(tool.name))}>
        {tool.name}
      </span>
      <code className="min-w-0 flex-1 truncate font-mono text-[10.5px] text-foreground/75">
        {tool.summary}
      </code>
    </div>
  )
}

function ChangedFiles({ summary }: { summary: MissionControlSummary }) {
  const total = summary.filesTotal
  return (
    <div className="flex flex-col gap-0.5">
      <div className={cn("flex items-center justify-between", CAPTION)}>
        <span>
          {total.count} file{total.count === 1 ? "" : "s"} changed
        </span>
        <LineCounts add={total.additions} del={total.deletions} />
      </div>
      {summary.files.map((file) => (
        <div key={file.path} className="flex min-w-0 items-center gap-1.5">
          <span className="min-w-0 flex-1 truncate font-mono text-[10.5px] text-muted-foreground/85">
            {file.path.split("/").slice(-2).join("/")}
          </span>
          <LineCounts add={file.additions} del={file.deletions} />
        </div>
      ))}
    </div>
  )
}

function ToolTrail({ trail, totalCalls }: { trail: string[]; totalCalls: number }) {
  const hidden = totalCalls - trail.length
  return (
    <div className="flex items-center gap-1">
      {trail.map((tool, i) => (
        <span key={`${tool}-${i}`} className="flex items-center gap-1">
          {i > 0 && <span className="text-[10px] text-muted-foreground/30">›</span>}
          <span className={cn("font-mono text-[9.5px]", getToolTextStyle(tool))}>
            {tool}
          </span>
        </span>
      ))}
      {hidden > 0 && (
        <span className="ml-auto font-mono text-[10px] text-muted-foreground/50">
          +{hidden} calls
        </span>
      )}
    </div>
  )
}

function ContextBar({ context }: { context: MissionControlContext }) {
  return (
    <div className="flex flex-col gap-1">
      <div className="flex justify-between font-mono text-[9.5px] text-muted-foreground/70">
        <span>
          context {formatTokenCount(context.used)} / {formatTokenCount(context.limit)}
        </span>
        <span>{context.percent}%</span>
      </div>
      <div className="h-1 overflow-hidden rounded-full bg-elevation-0">
        <div
          className={cn("h-full rounded-full transition-all", contextBarColor(context.percent))}
          style={{ width: `${Math.max(1, Math.min(100, context.percent))}%` }}
        />
      </div>
    </div>
  )
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0 flex-1">
      <span className={cn("block", CAPTION)}>{label}</span>
      <span className="mt-0.5 block truncate font-mono text-[12.5px] font-semibold tracking-tight text-foreground/90">
        {value}
      </span>
    </div>
  )
}
