import { useState, useMemo, memo, useCallback } from "react"
import {
  CheckCircle,
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
import { getToolSummary } from "../../../shared/session/toolSummary"

export { getToolSummary }

/**
 * Timeline tool badge styles — used in the live session timeline (ToolCallCard).
 *
 * Bare tinted text — no pill, background, or border — so a dense streaming list
 * stays quiet. Primary action tools (Write/Edit/Bash) render at full strength to
 * draw attention; secondary/read-only tools are dimmed.
 */
const TOOL_TEXT_STYLES: Record<string, string> = {
  // Full strength — primary action tools
  Write: "text-green-400",
  Edit: "text-amber-400",
  Bash: "text-red-400",
  // Dimmed — secondary tools
  Read: "text-blue-400/70",
  Grep: "text-purple-400/70",
  Glob: "text-cyan-400/70",
  Task: "text-indigo-400/70",
  WebFetch: "text-orange-400/70",
  WebSearch: "text-orange-400/70",
  EnterPlanMode: "text-purple-400/70",
  ExitPlanMode: "text-purple-400/70",
  AskUserQuestion: "text-pink-400/70",
  // Scheduling / automation tools
  Monitor: "text-cyan-400/70",
  CronCreate: "text-violet-400/70",
  CronDelete: "text-violet-400/70",
  CronList: "text-violet-400/70",
  ScheduleWakeup: "text-violet-400/70",
  RemoteTrigger: "text-blue-400/70",
  PushNotification: "text-pink-400/80",
  EnterWorktree: "text-emerald-400/70",
  ExitWorktree: "text-emerald-400/70",
  Skill: "text-indigo-400/80",
  ToolSearch: "text-slate-400/70",
}

const DEFAULT_TOOL_TEXT_STYLE = "text-muted-foreground/60"

/** Tool name color. Bare tinted text — no pill, no background, no border. */
export function getToolTextStyle(name: string): string {
  return TOOL_TEXT_STYLES[name] ?? DEFAULT_TOOL_TEXT_STYLE
}

// ── Reusable toggle button for expand/collapse sections ──────────────────

function ToggleButton({
  isOpen,
  onClick,
  label,
  activeClass,
}: {
  isOpen: boolean
  onClick: () => void
  label: string
  activeClass?: string
}): React.ReactElement {
  const Chevron = isOpen ? ChevronDown : ChevronRight
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "text-[10px] flex items-center gap-0.5 transition-colors",
        isOpen && activeClass ? activeClass : "text-muted-foreground hover:text-foreground",
      )}
    >
      <Chevron className="w-3 h-3" />
      {label}
    </button>
  )
}

// ── Status icon for tool call completion state ───────────────────────────

function StatusIcon({
  toolCall,
  isAgentActive,
}: {
  toolCall: ToolCall
  isAgentActive?: boolean
}): React.ReactElement | null {
  if (toolCall.isError) {
    return <XCircle className="w-4 h-4 text-red-400" />
  }
  if (toolCall.result !== null) {
    return <CheckCircle className="w-4 h-4 text-green-500/60" />
  }
  if (isAgentActive) {
    return <Loader2 className="w-4 h-4 text-blue-400" />
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
  const displayName = isMobile ? (MOBILE_TOOL_LABELS[toolCall.name] ?? toolCall.name) : toolCall.name

  const showInput = expandAll || inputOpen
  const showResult = expandAll || resultOpen
  const showDiff = expandAll || diffOpen

  const summary = getToolSummary(toolCall)
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
        >
          <div className="flex min-w-0 flex-1 items-center gap-1.5">
            <span
              className={cn("shrink-0 font-mono text-[10px]", getToolTextStyle(toolCall.name))}
              title={toolCall.name}
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
        <div className={cn("flex items-center", isMobile ? "gap-1.5" : "gap-2")}>
        <div className={cn("flex min-w-0 flex-1 items-center", isMobile ? "gap-1.5" : "gap-2")}>
          <span
            className={cn(
              "shrink-0 font-mono",
              isMobile ? "text-[10px]" : "text-[11px]",
              getToolTextStyle(toolCall.name)
            )}
            title={toolCall.name}
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
          {toolCall.timestamp && !isMobile && (
            <span className="text-[10px] text-muted-foreground/40 font-mono tabular-nums">
              {new Date(toolCall.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}
            </span>
          )}
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
              activeClass="text-amber-400"
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
        ) : (toolCall.name === "exec" || /(?:^|__|[.:/])exec$/.test(toolCall.name)) && typeof toolCall.input.raw === "string" ? (
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
