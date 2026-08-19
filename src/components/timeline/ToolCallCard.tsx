import { useState, useMemo, memo, useCallback } from "react"
import {
  XCircle,
  ChevronRight,
  ChevronDown,
  Loader2,
  ExternalLink,
} from "lucide-react"
import type { ToolCall } from "@/lib/types"
import { cn } from "@/lib/utils"
import { LiveSubagentTranscript } from "@/components/timeline/LiveSubagentTranscript"
import { useIsMobile } from "@/hooks/useIsMobile"
import { EditDiffView } from "./EditDiffView"
import { authFetch } from "@/lib/auth"
import { isRemoteDeviceActive } from "@/lib/device"
import type { SkillMeta } from "@/hooks/useSkillMetadata"
import { useSessionContext } from "@/contexts/SessionContext"
import { BashToolInput, CodexExecToolInput } from "./BashToolInput"
import { AskUserQuestionCard } from "./AskUserQuestionCard"
import {
  JsonResultHighlighted,
  ReadResultHighlighted,
  tryPrettyJson,
} from "./ToolCallResult"
import { getToolPresentation, getToolSummary, isCodexExecCall } from "../../../shared/session/toolSummary"

export { getToolSummary }

/**
 * Timeline tool name styles — used in the live session timeline (ToolCallCard).
 *
 * Colour encodes what a call does, never which tool it is: the name is spelled
 * out in words right beside it, so hue never carried identity in the first
 * place. Calls that change the world read at full strength, read-only calls
 * stay muted, and red is reserved for failures so it keeps meaning one thing.
 */
type ToolTier = "mutating" | "readOnly"

const TOOL_TIER_STYLES: Record<ToolTier, string> = {
  mutating: "text-foreground",
  readOnly: "text-muted-foreground",
}

/**
 * The timeline's error ink. `text-destructive` resolves to a near-black red in
 * this app's dark theme, which would make the one state that matters the least
 * legible of the three.
 */
const FAILED_TOOL_TEXT_STYLE = "text-red-400"

const TOOL_TIERS: Record<string, ToolTier> = {
  // Mutating — writes files, runs commands, spawns work, sends things out.
  Write: "mutating",
  Edit: "mutating",
  Bash: "mutating",
  exec: "mutating",
  Task: "mutating",
  Skill: "mutating",
  TodoWrite: "mutating",
  Image: "mutating",
  AskUserQuestion: "mutating",
  CronCreate: "mutating",
  CronDelete: "mutating",
  ScheduleWakeup: "mutating",
  RemoteTrigger: "mutating",
  PushNotification: "mutating",
  EnterWorktree: "mutating",
  ExitWorktree: "mutating",
  // Read-only — inspects the world without changing it.
  Read: "readOnly",
  Grep: "readOnly",
  Glob: "readOnly",
  WebFetch: "readOnly",
  WebSearch: "readOnly",
  ToolSearch: "readOnly",
  Monitor: "readOnly",
  CronList: "readOnly",
  Mcp: "readOnly",
  EnterPlanMode: "readOnly",
  ExitPlanMode: "readOnly",
}

/** Unknown tools stay quiet rather than claim attention they may not deserve. */
const DEFAULT_TOOL_TIER: ToolTier = "readOnly"

/** Tool name color. Bare text — no pill, no background, no border. */
export function getToolTextStyle(name: string, isError = false): string {
  if (isError) return FAILED_TOOL_TEXT_STYLE
  return TOOL_TIER_STYLES[TOOL_TIERS[name] ?? DEFAULT_TOOL_TIER]
}

// ── Reusable toggle button for expand/collapse sections ──────────────────

function ToggleButton({
  isOpen,
  onClick,
  label,
}: {
  isOpen: boolean
  onClick: () => void
  label: string
}): React.ReactElement {
  const Chevron = isOpen ? ChevronDown : ChevronRight
  return (
    <button
      type="button"
      onClick={onClick}
      className="text-[10px] flex items-center gap-0.5 text-muted-foreground transition-colors hover:text-foreground"
    >
      <Chevron className="w-3 h-3" />
      {label}
    </button>
  )
}

// ── Status icon for tool call completion state ───────────────────────────

/**
 * Success draws nothing. It is the ~98% case, and a marker that is almost never
 * actionable teaches the eye to skip exactly the column where failures appear.
 * Only the exceptions — failed, and still running — get ink.
 */
function StatusIcon({
  toolCall,
  isAgentActive,
}: {
  toolCall: ToolCall
  isAgentActive?: boolean
}): React.ReactElement | null {
  if (toolCall.isError) {
    return <XCircle role="img" aria-label="Tool call failed" className="w-4 h-4 text-red-400" />
  }
  if (toolCall.result === null && isAgentActive) {
    return <Loader2 role="img" aria-label="Tool call running" className="w-4 h-4 animate-spin text-blue-400" />
  }
  return null
}

// ── Main component ───────────────────────────────────────────────────────

interface ToolCallCardProps {
  toolCall: ToolCall
  expandAll: boolean
  isAgentActive?: boolean
  skillMetadata?: Map<string, SkillMeta>
}

const MOBILE_TOOL_LABELS: Record<string, string> = {
  AskUserQuestion: "Question",
  Bash: "Command",
  exec: "Command",
  Task: "Agent",
  WebFetch: "Fetch",
  WebSearch: "Search",
  EnterPlanMode: "Plan mode",
  ExitPlanMode: "Plan review",
  ToolSearch: "Tool search",
}

export const ToolCallCard = memo(function ToolCallCard({ toolCall, expandAll, isAgentActive, skillMetadata }: ToolCallCardProps) {
  const { session, pendingInteraction } = useSessionContext()
  const isMobile = useIsMobile()
  const [inputOpen, setInputOpen] = useState(false)
  const [resultOpen, setResultOpen] = useState(false)
  const [resultExpanded, setResultExpanded] = useState(false)
  const [diffOpen, setDiffOpen] = useState(false)
  // Historical tool calls are one-line rows on mobile. Live tools remain open
  // so questions, approvals, and streaming output stay actionable.
  const [mobileExpanded, setMobileExpanded] = useState(false)
  const isHistoricalTool = toolCall.result !== null || !isAgentActive
  const isCompactMobile = isMobile && isHistoricalTool && !expandAll && !mobileExpanded
  const presentation = useMemo(() => getToolPresentation(toolCall), [toolCall])
  const isCodexExec = isCodexExecCall(toolCall)
  // Abbreviate only when the presentation kept the raw tool name. A derived
  // label is already short and more accurate than the mobile stand-in.
  const displayName = isMobile && presentation.label === toolCall.name
    ? MOBILE_TOOL_LABELS[toolCall.name] ?? toolCall.name
    : presentation.label
  const nameTitle = presentation.label === toolCall.name
    ? toolCall.name
    : `${presentation.label} (${toolCall.name})`
  const nameClass = getToolTextStyle(presentation.styleName, toolCall.isError)
  // Wall-clock time is almost never scanned, but is occasionally needed. Hover
  // carries it so it costs no ink on every row. `title` is mouse-only, so the
  // desktop row also renders it as screen-reader-only text.
  const timeLabel = toolCall.timestamp
    ? new Date(toolCall.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })
    : undefined
  const timeIso = toolCall.timestamp ? new Date(toolCall.timestamp).toISOString() : undefined

  const showInput = expandAll || inputOpen
  const showResult = expandAll || resultOpen
  const showDiff = expandAll || diffOpen

  const summary = presentation.summary
  const skillMeta = toolCall.name === "Skill" && skillMetadata
    ? skillMetadata.get(summary) ?? null
    : null
  const resultText = toolCall.result ?? ""
  const isLongResult = resultText.length > 1000
  const visibleResult =
    isLongResult && !resultExpanded ? resultText.slice(0, 500) + "..." : resultText
  const prettyJson = useMemo(
    () => (!toolCall.isError && toolCall.name !== "Read") ? tryPrettyJson(resultText) : null,
    [toolCall.isError, toolCall.name, resultText],
  )
  const isJsonResult = prettyJson !== null

  const hasEditDiff =
    toolCall.name === "Edit" &&
    typeof toolCall.input.old_string === "string" &&
    typeof toolCall.input.new_string === "string" &&
    typeof toolCall.input.file_path === "string"

  const handleCompactTap = useCallback(() => {
    if (isCompactMobile) setMobileExpanded(true)
  }, [isCompactMobile])

  if (toolCall.name === "AskUserQuestion") {
    // Answerability comes from the session's pending interaction, never from
    // live-traffic heuristics: a question-blocked session emits no traffic, so
    // isAgentActive goes false exactly when the answer form is needed most.
    return (
      <AskUserQuestionCard
        toolCall={toolCall}
        expandAll={expandAll}
        isAwaitingAnswer={
          pendingInteraction?.type === "question" &&
          pendingInteraction.toolUseId === toolCall.id
        }
        sessionId={session?.sessionId}
      />
    )
  }

  return (
    <div
      className={cn(
        isCompactMobile ? "py-1" : "py-1.5",
        toolCall.isError && !isCompactMobile && "rounded-md bg-red-950/10 px-2",
      )}
    >
      {isCompactMobile ? (
        <button
          type="button"
          className="flex w-full items-center gap-1.5 rounded-sm text-left active:bg-white/[0.03]"
          onClick={handleCompactTap}
          aria-label={`Expand ${displayName} tool call`}
          title={timeLabel}
        >
          <div className="flex min-w-0 flex-1 items-center gap-1.5">
            <span
              className={cn("shrink-0 font-mono text-[10px]", nameClass)}
              title={nameTitle}
            >
              {displayName}
            </span>
            {summary && (
              <span className="truncate font-mono text-[11px] text-muted-foreground">
                {summary}
              </span>
            )}
          </div>
          <ChevronRight className="size-3 shrink-0 text-muted-foreground/50" />
          <StatusIcon toolCall={toolCall} isAgentActive={isAgentActive} />
        </button>
      ) : (
        <div className={cn("flex items-center", isMobile ? "gap-1.5" : "gap-2")} title={timeLabel}>
        {timeLabel && <time className="sr-only" dateTime={timeIso}>{timeLabel}</time>}
        <div className={cn("flex min-w-0 flex-1 items-center", isMobile ? "gap-1.5" : "gap-2")}>
          <span
            className={cn(
              "shrink-0 font-mono",
              isMobile ? "text-[10px]" : "text-[11px]",
              nameClass,
            )}
            title={nameTitle}
          >
            {displayName}
          </span>
          {summary && (
            <span className={cn("truncate font-mono text-muted-foreground", isMobile ? "text-[11px]" : "text-xs")}>
              {summary}
            </span>
          )}
        </div>
        <div className="flex items-center gap-1.5 flex-shrink-0">
          {toolCall.hookDurationMs !== undefined && toolCall.hookDurationMs > 0 && !isMobile && (
            <span className="text-[10px] text-muted-foreground/50 tabular-nums" title="PostToolUse hook duration">{toolCall.hookDurationMs}ms</span>
          )}
          {toolCall.outputReplacedByHook && (
            <span className="text-[10px] text-blue-400" title="Output replaced by hook">hook</span>
          )}
          <StatusIcon toolCall={toolCall} isAgentActive={isAgentActive} />
        </div>
      </div>
      )}

      {skillMeta && !isCompactMobile && (
        <div className="flex items-center gap-2 mt-0.5 text-[10px] text-muted-foreground/60 font-mono">
          <span>source: {skillMeta.source}</span>
          {skillMeta.filePath && !isRemoteDeviceActive() && (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation()
                authFetch("/api/open-in-editor", {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ path: skillMeta.filePath }),
                })
              }}
              className="flex items-center gap-0.5 text-indigo-400/70 hover:text-indigo-400 transition-colors"
              title={skillMeta.filePath}
            >
              <ExternalLink className="w-2.5 h-2.5" />
              Open SKILL.md
            </button>
          )}
        </div>
      )}

      {!isCompactMobile && (
        <div className="flex gap-3 mt-1">
          {hasEditDiff && (
            <ToggleButton
              isOpen={showDiff}
              onClick={() => setDiffOpen(!diffOpen)}
              label="Diff"
            />
          )}
          <ToggleButton
            isOpen={showInput}
            onClick={() => setInputOpen(!inputOpen)}
            label="Input"
          />
          {toolCall.result !== null && (
            <ToggleButton
              isOpen={showResult}
              onClick={() => setResultOpen(!resultOpen)}
              label="Result"
            />
          )}
        </div>
      )}

      {showDiff && hasEditDiff && (
        <EditDiffView
          oldString={toolCall.input.old_string as string}
          newString={toolCall.input.new_string as string}
          filePath={toolCall.input.file_path as string}
        />
      )}

      {showInput && (
        toolCall.name === "Bash" && (typeof toolCall.input.command === "string" || typeof toolCall.input.cmd === "string") ? (
          <BashToolInput input={toolCall.input} />
        ) : isCodexExec ? (
          <CodexExecToolInput input={toolCall.input} />
        ) : (
          <JsonResultHighlighted
            result={JSON.stringify(toolCall.input)}
            expanded={true}
          />
        )
      )}

      {(toolCall.name === "Task" || toolCall.name === "Agent") && toolCall.result === null && (
        <LiveSubagentTranscript toolUseId={toolCall.id} />
      )}

      {showResult && toolCall.result !== null && (
        <div className="mt-1.5">
          {toolCall.name === "Read" && !toolCall.isError && typeof toolCall.input.file_path === "string" ? (
            <ReadResultHighlighted
              result={resultText}
              filePath={toolCall.input.file_path as string}
              expanded={!isLongResult || resultExpanded}
            />
          ) : isJsonResult ? (
            <JsonResultHighlighted
              result={prettyJson!}
              expanded={!isLongResult || resultExpanded}
              alreadyPretty
            />
          ) : (
            <pre
              className={cn(
                "text-[11px] font-mono whitespace-pre-wrap break-all rounded p-2 max-h-96 overflow-y-auto border",
                toolCall.isError
                  ? "text-red-700 dark:text-red-300 bg-red-50 dark:bg-red-950/30 border-red-500/20"
                  : "text-muted-foreground bg-elevation-0 border-border/30"
              )}
            >
              {visibleResult}
            </pre>
          )}
          {isLongResult && (
            <button
              type="button"
              onClick={() => setResultExpanded(!resultExpanded)}
              className="mt-1 text-[10px] text-muted-foreground hover:text-foreground transition-colors"
            >
              {resultExpanded ? "Show less" : "Show more"}
            </button>
          )}
        </div>
      )}
    </div>
  )
})
