import { useState, useMemo, memo, useCallback, useId } from "react"
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
import { isRemoteDeviceActive } from "@/lib/device"
import { isBuiltInEditorEnabled, openFile } from "@/lib/fileOpener"
import { LocalImage, isLocalImagePath } from "./LocalImage"
import type { SkillMeta } from "@/hooks/useSkillMetadata"
import { useSessionContext } from "@/contexts/SessionContext"
import { BashToolInput, CodexExecToolInput } from "./BashToolInput"
import { AskUserQuestionCard } from "./AskUserQuestionCard"
import {
  JsonResultHighlighted,
  ReadResultHighlighted,
  type ToolResultVariant,
  tryPrettyJson,
} from "./ToolCallResult"
import { getToolPresentation, getToolSummary, isCodexExecCall } from "../../../shared/session/toolSummary"
import { Button } from "@/components/ui/button"
import { Collapsible, CollapsibleContent } from "@/components/ui/collapsible"

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

const FAILED_TOOL_TEXT_STYLE = "text-destructive"
const DESKTOP_RESULT_LINE_LIMIT = 8
const DESKTOP_RESULT_CLASS =
  "whitespace-pre-wrap break-all border-l border-border pl-3 font-mono text-[11px] leading-relaxed text-muted-foreground"
const MOBILE_RESULT_CLASS =
  "max-h-96 overflow-y-auto whitespace-pre-wrap break-all rounded-md border p-2 font-mono text-xs leading-relaxed"

function splitLogicalLines(text: string): string[] {
  return text.split(/\r\n|\r|\n/)
}

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
  Agent: "mutating",
  SendMessage: "mutating",
  EndConversation: "mutating",
  TaskCreate: "mutating",
  TaskUpdate: "mutating",
  TaskStop: "mutating",
  // A workflow run spawns a whole fleet of agents that edit the repo.
  Workflow: "mutating",
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
  ListAgents: "readOnly",
  TaskList: "readOnly",
  TaskOutput: "readOnly",
  LSP: "readOnly",
  StructuredOutput: "readOnly",
  ReportFindings: "readOnly",
}

/** Unknown tools stay quiet rather than claim attention they may not deserve. */
const DEFAULT_TOOL_TIER: ToolTier = "readOnly"

/** What a call does, which is what its colour encodes. */
export function getToolTier(name: string): ToolTier {
  return TOOL_TIERS[name] ?? DEFAULT_TOOL_TIER
}

/** Tool name color. Bare text — no pill, no background, no border. */
export function getToolTextStyle(name: string, isError = false): string {
  if (isError) return FAILED_TOOL_TEXT_STYLE
  return TOOL_TIER_STYLES[getToolTier(name)]
}

// ── Reusable toggle button for expand/collapse sections ──────────────────

function ToggleButton({
  isOpen,
  onClick,
  label,
  controlsId,
}: {
  isOpen: boolean
  onClick: () => void
  label: string
  controlsId: string
}): React.ReactElement {
  const Chevron = isOpen ? ChevronDown : ChevronRight
  return (
    <Button
      type="button"
      variant="ghost"
      size="xs"
      onClick={onClick}
      className="-ml-2 text-muted-foreground"
      aria-expanded={isOpen}
      aria-controls={controlsId}
    >
      <Chevron data-icon="inline-start" />
      {label}
    </Button>
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
    return <XCircle role="img" aria-label="Tool call failed" className="size-4 text-destructive" data-icon="icon" />
  }
  if (toolCall.result === null && isAgentActive) {
    return <Loader2 role="img" aria-label="Tool call running" className="size-4 animate-spin text-info" data-icon="icon" />
  }
  return null
}

function ToolResultPanel({
  toolCall,
  resultExpanded,
  onToggleExpanded,
  isMobile,
}: {
  toolCall: ToolCall
  resultExpanded: boolean
  onToggleExpanded: () => void
  isMobile: boolean
}): React.ReactElement {
  const resultText = toolCall.result ?? ""
  const isLongResult = resultText.length > 1000
  const mobileVisibleResult = isLongResult && !resultExpanded
    ? resultText.slice(0, 500) + "..."
    : resultText
  const prettyJson = useMemo(
    () => (!toolCall.isError && toolCall.name !== "Read") ? tryPrettyJson(resultText) : null,
    [toolCall.isError, toolCall.name, resultText],
  )
  const desktopResult = prettyJson ?? resultText
  const desktopLines = useMemo(() => splitLogicalLines(desktopResult), [desktopResult])
  const hiddenLineCount = Math.max(0, desktopLines.length - DESKTOP_RESULT_LINE_LIMIT)
  const desktopVisibleResult = resultExpanded
    ? desktopResult
    : desktopLines.slice(0, DESKTOP_RESULT_LINE_LIMIT).join("\n")
  const showExpander = isMobile ? isLongResult : hiddenLineCount > 0
  const highlightedExpanded = !isMobile || !isLongResult || resultExpanded
  const highlightedVariant: ToolResultVariant = isMobile ? "boxed" : "unboxed"

  return (
    <div className="mt-1.5">
      {toolCall.name === "Read" &&
      !toolCall.isError &&
      typeof toolCall.input.file_path === "string" ? (
        <ReadResultHighlighted
          result={isMobile ? resultText : desktopVisibleResult}
          filePath={toolCall.input.file_path}
          expanded={highlightedExpanded}
          variant={highlightedVariant}
        />
      ) : prettyJson !== null ? (
        <JsonResultHighlighted
          result={isMobile ? prettyJson : desktopVisibleResult}
          expanded={highlightedExpanded}
          alreadyPretty
          variant={highlightedVariant}
        />
      ) : (
        <pre
          className={cn(
            isMobile ? MOBILE_RESULT_CLASS : DESKTOP_RESULT_CLASS,
            toolCall.isError
              ? cn(
                  "border-destructive/20 text-destructive",
                  isMobile && "bg-destructive/5",
                )
              : isMobile && "border-border bg-muted/30 text-muted-foreground",
          )}
        >
          {isMobile ? mobileVisibleResult : desktopVisibleResult}
        </pre>
      )}
      {showExpander && (
        <button
          type="button"
          onClick={onToggleExpanded}
          className="mt-1 text-[10px] text-muted-foreground hover:text-foreground transition-colors"
        >
          {resultExpanded
            ? "Show less"
            : isMobile
              ? "Show more"
              : `+${hiddenLineCount} lines`}
        </button>
      )}
    </div>
  )
}

function ToolCallHeaderContent({
  toolCall,
  isMobile,
  isAgentActive,
  displayName,
  summary,
  nameTitle,
  nameClass,
  timeLabel,
  timeIso,
}: {
  toolCall: ToolCall
  isMobile: boolean
  isAgentActive?: boolean
  displayName: string
  summary: string
  nameTitle: string
  nameClass: string
  timeLabel?: string
  timeIso?: string
}): React.ReactElement {
  return (
    <>
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
    </>
  )
}

/** Absolute path of the image a read opened, or null when it read something else. */
function imageReadPath(toolCall: ToolCall): string | null {
  if (toolCall.isError) return null
  const path = toolCall.name === "Read"
    ? toolCall.input.file_path
    : toolCall.name === "view_image"
      ? toolCall.input.path
      : null
  return typeof path === "string" && isLocalImagePath(path) ? path : null
}

function EditToolDiff({ toolCall }: { toolCall: ToolCall }): React.ReactElement {
  return (
    <EditDiffView
      oldString={toolCall.input.old_string as string}
      newString={toolCall.input.new_string as string}
      filePath={toolCall.input.file_path as string}
    />
  )
}

// ── Main component ───────────────────────────────────────────────────────

interface ToolCallCardProps {
  toolCall: ToolCall
  expandAll: boolean
  expandToolPayloads?: boolean
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

export const ToolCallCard = memo(function ToolCallCard({
  toolCall,
  expandAll,
  expandToolPayloads = false,
  isAgentActive,
  skillMetadata,
}: ToolCallCardProps) {
  const { session, pendingInteraction } = useSessionContext()
  const isMobile = useIsMobile()
  const [inputOpen, setInputOpen] = useState(false)
  const [resultOpen, setResultOpen] = useState(false)
  const [resultExpanded, setResultExpanded] = useState(false)
  const [diffOpen, setDiffOpen] = useState(false)
  const [desktopPanelOpen, setDesktopPanelOpen] = useState(false)
  const [desktopInputOpen, setDesktopInputOpen] = useState(false)
  const mobileDiffId = useId()
  const mobileInputId = useId()
  const mobileResultId = useId()
  const desktopPanelId = useId()
  const desktopInputId = useId()
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

  const payloadsExpanded = expandToolPayloads || (isMobile && expandAll)
  const showMobileInput = payloadsExpanded || inputOpen
  const showMobileResult = payloadsExpanded || resultOpen
  const showMobileDiff = payloadsExpanded || diffOpen

  const summary = presentation.summary
  const skillMeta = toolCall.name === "Skill" && skillMetadata
    ? skillMetadata.get(summary) ?? null
    : null
  const skillFilePath = skillMeta?.filePath
  const hasEditDiff =
    toolCall.name === "Edit" &&
    typeof toolCall.input.old_string === "string" &&
    typeof toolCall.input.new_string === "string" &&
    typeof toolCall.input.file_path === "string"

  const desktopPrimaryPanel = hasEditDiff
    ? "diff"
    : toolCall.name === "Bash" || isCodexExec
      ? "command"
      : "result"
  const showDesktopPanel = expandToolPayloads || desktopPanelOpen
  // An image read returns its pixels as a block the text parser drops, so the
  // preview below stands in for a result well that would always be empty.
  const imagePath = imageReadPath(toolCall)
  const hasImagePreview = imagePath !== null && toolCall.result?.trim() === ""
  const renderedResult = toolCall.result !== null && !hasImagePreview ? (
    <ToolResultPanel
      toolCall={toolCall}
      resultExpanded={resultExpanded}
      onToggleExpanded={() => setResultExpanded(!resultExpanded)}
      isMobile={isMobile}
    />
  ) : null

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
        expandToolPayloads={payloadsExpanded}
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
        toolCall.isError && !isCompactMobile && "rounded-md bg-destructive/5 px-2",
      )}
    >
      {isCompactMobile ? (
        <Button
          type="button"
          variant="ghost"
          size="xs"
          className="h-auto w-full justify-start px-1 py-1 text-left"
          onClick={handleCompactTap}
          aria-label={`Expand ${displayName} tool call`}
          title={timeLabel}
        >
          <div className="flex min-w-0 flex-1 items-center gap-1.5">
            <span
              className={cn("shrink-0 font-mono text-xs", nameClass)}
              title={nameTitle}
            >
              {displayName}
            </span>
            {summary && (
              <span className="truncate font-mono text-xs text-muted-foreground">
                {summary}
              </span>
            )}
          </div>
          <ChevronRight className="size-3 shrink-0 text-muted-foreground" data-icon="inline-end" />
          <StatusIcon toolCall={toolCall} isAgentActive={isAgentActive} />
        </Button>
      ) : isMobile ? (
        <div className="flex items-center gap-1.5" title={timeLabel}>
          <ToolCallHeaderContent
            toolCall={toolCall}
            isMobile
            isAgentActive={isAgentActive}
            displayName={displayName}
            summary={summary}
            nameTitle={nameTitle}
            nameClass={nameClass}
            timeLabel={timeLabel}
            timeIso={timeIso}
          />
        </div>
      ) : (
        <button
          type="button"
          className="flex w-full items-center gap-2 rounded-sm text-left hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          title={timeLabel}
          aria-label={`Toggle ${displayName} details${summary ? `: ${summary}` : ""}`}
          aria-expanded={showDesktopPanel}
          aria-controls={desktopPanelId}
          onClick={() => {
            if (!expandToolPayloads) setDesktopPanelOpen((open) => !open)
          }}
        >
          <ToolCallHeaderContent
            toolCall={toolCall}
            isMobile={false}
            isAgentActive={isAgentActive}
            displayName={displayName}
            summary={summary}
            nameTitle={nameTitle}
            nameClass={nameClass}
            timeLabel={timeLabel}
            timeIso={timeIso}
          />
        </button>
      )}

      {hasImagePreview && !isCompactMobile && (
        <LocalImage
          src={imagePath}
          alt={imagePath.slice(imagePath.lastIndexOf("/") + 1)}
          id={`tool-image:${toolCall.id}`}
          className="my-1.5"
          thumbnailClassName="max-h-40"
        />
      )}

      {!isCompactMobile && toolCall.resultImages?.map((image, index) => (
        <LocalImage
          key={`${image.source.media_type}-${image.source.data.length}-${image.source.data.slice(0, 32)}-${image.source.data.slice(-32)}`}
          src={`data:${image.source.media_type};base64,${image.source.data}`}
          alt={`Tool result image ${index + 1}`}
          id={`tool-result-image:${toolCall.id}:${index}`}
          className="my-1.5"
          thumbnailClassName="max-h-40"
        />
      ))}

      {skillMeta && !isCompactMobile && (
        <div className="mt-1 flex items-center gap-2 font-mono text-xs text-muted-foreground">
          <span>source: {skillMeta.source}</span>
          {skillFilePath && (!isRemoteDeviceActive() || isBuiltInEditorEnabled()) && (
            <Button
              type="button"
              variant="link"
              size="xs"
              onClick={(e) => {
                e.stopPropagation()
                openFile(skillFilePath)
              }}
              className="h-auto px-0 text-muted-foreground"
              title={skillFilePath}
            >
              <ExternalLink data-icon="inline-start" />
              Open SKILL.md
            </Button>
          )}
        </div>
      )}

      {isMobile && !isCompactMobile && (
        <div className="flex gap-3 mt-1">
          {hasEditDiff && (
            <ToggleButton
              isOpen={showMobileDiff}
              onClick={() => setDiffOpen(!diffOpen)}
              label="Diff"
              controlsId={mobileDiffId}
            />
          )}
          <ToggleButton
            isOpen={showMobileInput}
            onClick={() => setInputOpen(!inputOpen)}
            label="Input"
            controlsId={mobileInputId}
          />
          {renderedResult && (
            <ToggleButton
              isOpen={showMobileResult}
              onClick={() => setResultOpen(!resultOpen)}
              label="Result"
              controlsId={mobileResultId}
            />
          )}
        </div>
      )}

      {isMobile && !isCompactMobile && hasEditDiff && (
        <Collapsible open={showMobileDiff}>
          <CollapsibleContent id={mobileDiffId}>
            <EditToolDiff toolCall={toolCall} />
          </CollapsibleContent>
        </Collapsible>
      )}

      {isMobile && !isCompactMobile && (
        <Collapsible open={showMobileInput}>
          <CollapsibleContent id={mobileInputId}>
            {toolCall.name === "Bash" &&
            (typeof toolCall.input.command === "string" ||
              typeof toolCall.input.cmd === "string") ? (
              <BashToolInput input={toolCall.input} />
            ) : isCodexExec ? (
              <CodexExecToolInput input={toolCall.input} />
            ) : (
              <JsonResultHighlighted
                result={JSON.stringify(toolCall.input)}
                expanded={true}
              />
            )}
          </CollapsibleContent>
        </Collapsible>
      )}

      {(toolCall.name === "Task" || toolCall.name === "Agent") &&
        toolCall.result === null && (
          <LiveSubagentTranscript toolUseId={toolCall.id} />
        )}

      {isMobile && !isCompactMobile && renderedResult && (
        <Collapsible open={showMobileResult}>
          <CollapsibleContent id={mobileResultId}>
            {renderedResult}
          </CollapsibleContent>
        </Collapsible>
      )}

      {!isMobile && (
        <Collapsible open={showDesktopPanel}>
          <CollapsibleContent
            id={desktopPanelId}
            onClick={(event) => event.stopPropagation()}
          >
            {desktopPrimaryPanel === "diff" && hasEditDiff && (
              <EditToolDiff toolCall={toolCall} />
            )}

            {desktopPrimaryPanel === "command" &&
              (toolCall.name === "Bash" ? (
                <BashToolInput input={toolCall.input} />
              ) : (
                <CodexExecToolInput input={toolCall.input} />
              ))}

            {(desktopPrimaryPanel === "result" ||
              desktopPrimaryPanel === "command") && renderedResult}

            <button
              type="button"
              className="mt-1 text-[10px] text-muted-foreground/50 transition-colors hover:text-muted-foreground"
              aria-expanded={desktopInputOpen}
              aria-controls={desktopInputId}
              onClick={(event) => {
                event.stopPropagation()
                setDesktopInputOpen((open) => !open)
              }}
            >
              input
            </button>
            <Collapsible open={desktopInputOpen}>
              <CollapsibleContent id={desktopInputId}>
                <JsonResultHighlighted
                  result={JSON.stringify(toolCall.input)}
                  expanded
                />
              </CollapsibleContent>
            </Collapsible>
          </CollapsibleContent>
        </Collapsible>
      )}
    </div>
  )
})
