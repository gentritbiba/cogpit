import { useState, useMemo, memo, useId } from "react"
import {
  XCircle,
  ChevronRight,
  Loader2,
  ExternalLink,
} from "lucide-react"
import type { ToolCall } from "../../../shared/session/types"
import { cn } from "@/lib/utils"
import { LiveSubagentTranscript } from "@/components/timeline/LiveSubagentTranscript"
import { EditDiffView } from "./EditDiffView"
import { isRemoteDeviceActive } from "@/lib/device"
import { isBuiltInEditorEnabled, openFile } from "@/lib/fileOpener"
import { LocalImage, isLocalImagePath } from "./LocalImage"
import type { SkillMeta } from "@/hooks/useSkillMetadata"
import { useSessionContext } from "@/contexts/SessionContext"
import { ToolCallInput } from "./ToolCallInput"
import { CodexExecToolInput } from "./CodexExecToolInput"
import {
  BashCommandCard,
  bashSections,
  CHIP_TONE_CLASS,
  sectionChips,
  type SectionChip,
} from "./BashCommandCard"
import { Badge } from "@/components/ui/badge"
import { AskUserQuestionCard } from "./AskUserQuestionCard"
import { JsonResultHighlighted, ToolResultPanel } from "./ToolCallResult"
import { isCodexExecCall } from "../../../shared/session/codex-exec"
import { getCommandText, getToolPresentation, getToolTier } from "../../../shared/session/toolSummary"
import { Button } from "@/components/ui/button"
import { Collapsible, CollapsibleContent } from "@/components/ui/collapsible"

const HEADER_SECTION_CHIP_LIMIT = 4

export function getToolTextStyle(name: string, isError = false): string {
  if (isError) return "text-destructive"
  return getToolTier(name) === "mutating" ? "text-foreground" : "text-muted-foreground"
}

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

function SectionChips({ chips }: { chips: SectionChip[] }): React.ReactElement {
  const shown = chips.slice(0, HEADER_SECTION_CHIP_LIMIT)
  const hidden = chips.length - shown.length
  return (
    <span className="flex min-w-0 items-center gap-1 overflow-hidden" aria-label={`Sections: ${chips.map((chip) => `${chip.name}${chip.count > 1 ? ` ×${chip.count}` : ""}`).join(", ")}`}>
      {shown.map((chip, index) => (
        <Badge key={index} variant="outline" className={cn("h-4 shrink-0 px-1.5 font-mono text-[10px]", CHIP_TONE_CLASS[chip.tone])}>
          {chip.name}{chip.count > 1 ? ` ×${chip.count}` : ""}
        </Badge>
      ))}
      {hidden > 0 && (
        <span className="shrink-0 text-[10px] text-muted-foreground">+{hidden}</span>
      )}
    </span>
  )
}

/** Section chips when the call is a sectioned batch, the plain summary otherwise. */
function HeaderSummary({
  chips,
  summary,
}: {
  chips?: SectionChip[]
  summary: string
}): React.ReactElement | null {
  if (chips) return <SectionChips chips={chips} />
  if (!summary) return null
  return (
    <span className="min-w-0 truncate font-mono text-xs text-muted-foreground">
      {summary}
    </span>
  )
}

function ToolCallHeaderContent({
  toolCall,
  isAgentActive,
  displayName,
  summary,
  sectionChips: chips,
  nameTitle,
  nameClass,
  timeLabel,
  timeIso,
}: {
  toolCall: ToolCall
  isAgentActive?: boolean
  displayName: string
  summary: string
  sectionChips?: SectionChip[]
  nameTitle: string
  nameClass: string
  timeLabel?: string
  timeIso?: string
}): React.ReactElement {
  return (
    <>
      {timeLabel && <time className="sr-only" dateTime={timeIso}>{timeLabel}</time>}
      <div className="flex min-w-0 flex-1 items-center gap-2">
        <span
          className={cn(
            "max-w-[50%] shrink-0 truncate font-mono text-xs",
            nameClass,
          )}
          title={nameTitle}
        >
          {displayName}
        </span>
        <HeaderSummary chips={chips} summary={summary} />
      </div>
      <div className="flex items-center gap-1.5 flex-shrink-0">
        {toolCall.hookDurationMs !== undefined && toolCall.hookDurationMs > 0 && (
          <span className="text-[10px] text-muted-foreground/50 tabular-nums" title="PostToolUse hook duration">{toolCall.hookDurationMs}ms</span>
        )}
        {toolCall.outputReplacedByHook && (
          <span className="text-[10px] text-info" title="Output replaced by hook">hook</span>
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
    : /(?:^|[._])view_image$/.test(toolCall.name)
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
  groupedBashCalls?: ToolCall[]
  expandToolPayloads?: boolean
  isAgentActive?: boolean
  skillMetadata?: Map<string, SkillMeta>
}

export const ToolCallCard = memo(function ToolCallCard({
  toolCall,
  groupedBashCalls,
  expandToolPayloads = false,
  isAgentActive,
  skillMetadata,
}: ToolCallCardProps) {
  const { session, pendingInteraction } = useSessionContext()
  const [panelOpen, setPanelOpen] = useState(false)
  const [inputOpen, setInputOpen] = useState(false)
  const panelId = useId()
  const inputId = useId()
  const isCodexExec = isCodexExecCall(toolCall)
  const hasCommand = !isCodexExec &&
    (toolCall.name === "Bash" || /(?:^|[._])exec_command$/.test(toolCall.name)) &&
    Boolean(getCommandText(toolCall.input))
  const bashCalls = useMemo(
    () => groupedBashCalls ?? (hasCommand ? [toolCall] : []),
    [groupedBashCalls, hasCommand, toolCall],
  )
  const presentation = useMemo(() => getToolPresentation(toolCall), [toolCall])
  const sections = useMemo(
    () => bashCalls.length > 0 ? bashCalls.flatMap(bashSections) : null,
    [bashCalls],
  )
  const chips = useMemo(() => (sections && (sections.length > 1 || sections.some((section) => section.label)) ? sectionChips(sections) : undefined), [sections])
  const displayName = bashCalls.length > 1 ? `${presentation.label} ×${bashCalls.length}` : presentation.label
  const nameTitle = presentation.label === toolCall.name
    ? toolCall.name
    : `${presentation.label} (${toolCall.name})`
  const nameClass = getToolTextStyle(
    presentation.styleName,
    toolCall.isError || bashCalls.some((call) => call.isError),
  )
  const statusToolCall = useMemo(() => {
    if (bashCalls.length <= 1) return toolCall
    return {
      ...toolCall,
      result: bashCalls.some((call) => call.result === null) ? null : toolCall.result,
      isError: bashCalls.some((call) => call.isError),
      outputReplacedByHook: bashCalls.some((call) => call.outputReplacedByHook),
      hookDurationMs: bashCalls.reduce((sum, call) => sum + (call.hookDurationMs ?? 0), 0),
    }
  }, [bashCalls, toolCall])
  const timeLabel = toolCall.timestamp
    ? new Date(toolCall.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })
    : undefined
  const timeIso = toolCall.timestamp ? new Date(toolCall.timestamp).toISOString() : undefined

  const showPanel = expandToolPayloads || panelOpen

  const summary = bashCalls.length > 1
    ? `${sections?.length ?? bashCalls.length} commands`
    : presentation.summary
  const skillMeta = toolCall.name === "Skill" && skillMetadata
    ? skillMetadata.get(summary) ?? null
    : null
  const skillFilePath = skillMeta?.filePath
  const hasEditDiff =
    toolCall.name === "Edit" &&
    typeof toolCall.input.old_string === "string" &&
    typeof toolCall.input.new_string === "string" &&
    typeof toolCall.input.file_path === "string"

  const imagePath = imageReadPath(toolCall)
  const hasResultImages = Boolean(toolCall.resultImages?.length)
  const hasImagePreview = imagePath !== null && toolCall.result?.trim() === "" && !hasResultImages
  const showResult = toolCall.result !== null && !hasImagePreview && bashCalls.length === 0 &&
    (!hasResultImages || Boolean(toolCall.result?.trim())) &&
    (!hasEditDiff || toolCall.isError)

  if (toolCall.name === "AskUserQuestion") {
    // Answerability comes from the session's pending interaction, never from
    // live-traffic heuristics: a question-blocked session emits no traffic, so
    // isAgentActive goes false exactly when the answer form is needed most.
    return (
      <AskUserQuestionCard
        toolCall={toolCall}
        expandToolPayloads={expandToolPayloads}
        isAwaitingAnswer={
          pendingInteraction?.type === "question" &&
          pendingInteraction.toolUseId === toolCall.id
        }
        sessionId={session?.sessionId}
      />
    )
  }

  return (
    <div className={cn("min-w-0 py-1", statusToolCall.isError && "rounded-md bg-destructive/5 px-2")}>
      <button
        type="button"
        className="flex min-h-11 w-full min-w-0 items-center gap-2 rounded-sm text-left hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring sm:min-h-7"
        title={timeLabel}
        aria-label={`Toggle ${displayName} details${summary ? `: ${summary}` : ""}`}
        aria-expanded={showPanel}
        aria-controls={panelId}
        onClick={() => {
          if (!expandToolPayloads) setPanelOpen((open) => !open)
        }}
      >
        <ChevronRight className={cn("size-3 shrink-0 text-muted-foreground transition-transform", showPanel && "rotate-90")} aria-hidden="true" />
        <ToolCallHeaderContent
          toolCall={statusToolCall}
          isAgentActive={isAgentActive}
          displayName={displayName}
          summary={summary}
          sectionChips={chips}
          nameTitle={nameTitle}
          nameClass={nameClass}
          timeLabel={timeLabel}
          timeIso={timeIso}
        />
      </button>

      {hasImagePreview && (
        <LocalImage
          src={imagePath}
          alt={imagePath.slice(imagePath.lastIndexOf("/") + 1)}
          id={`tool-image:${toolCall.id}`}
          className="my-1.5"
          thumbnailClassName="max-h-40"
        />
      )}

      {toolCall.resultImages?.map((image, index) => (
        <LocalImage
          key={`${image.source.media_type}-${image.source.data.length}-${image.source.data.slice(0, 32)}-${image.source.data.slice(-32)}`}
          src={`data:${image.source.media_type};base64,${image.source.data}`}
          alt={`Tool result image ${index + 1}`}
          id={`tool-result-image:${toolCall.id}:${index}`}
          className="my-1.5"
          thumbnailClassName="max-h-40"
        />
      ))}

      {skillMeta && (
        <div className="mt-1 flex min-w-0 flex-wrap items-center gap-2 font-mono text-xs text-muted-foreground">
          <span>source: {skillMeta.source}</span>
          {skillFilePath && (!isRemoteDeviceActive() || isBuiltInEditorEnabled()) && (
            <Button
              type="button"
              variant="link"
              size="xs"
              onClick={() => openFile(skillFilePath)}
              title={skillFilePath}
            >
              <ExternalLink data-icon="inline-start" />
              Open SKILL.md
            </Button>
          )}
        </div>
      )}

      <Collapsible open={showPanel}>
        <CollapsibleContent id={panelId}>
          {hasEditDiff && <EditToolDiff toolCall={toolCall} />}
          {bashCalls.length > 0 ? (
            <BashCommandCard
              toolCalls={bashCalls}
              cwd={session?.cwd}
              expandAll={expandToolPayloads}
              isAgentActive={Boolean(isAgentActive)}
            />
          ) : isCodexExec ? (
            <CodexExecToolInput input={toolCall.input} />
          ) : !hasEditDiff ? <ToolCallInput input={toolCall.input} /> : null}
          {showResult && (
            <ToolResultPanel
              result={toolCall.result ?? ""}
              isError={toolCall.isError}
              filePath={toolCall.name === "Read" && typeof toolCall.input.file_path === "string" ? toolCall.input.file_path : undefined}
            />
          )}
          <Collapsible open={inputOpen}>
            <Button
              type="button"
              variant="ghost"
              size="xs"
              className="mt-1"
              aria-expanded={inputOpen}
              aria-controls={inputId}
              onClick={() => setInputOpen((open) => !open)}
            >
              <ChevronRight data-icon="inline-start" className={cn(inputOpen && "rotate-90")} />
              Input
            </Button>
            <CollapsibleContent id={inputId}>
              <JsonResultHighlighted
                result={JSON.stringify(bashCalls.length > 1 ? bashCalls.map((call) => call.input) : toolCall.input)}
              />
            </CollapsibleContent>
          </Collapsible>
        </CollapsibleContent>
      </Collapsible>

      {(toolCall.name === "Task" || toolCall.name === "Agent") && toolCall.result === null && (
        <LiveSubagentTranscript toolUseId={toolCall.id} />
      )}
    </div>
  )
})
