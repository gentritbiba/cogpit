import { useMemo, memo, useId } from "react"
import {
  ChevronRight,
  ExternalLink,
  Loader2,
} from "lucide-react"
import type { ToolCall } from "../../../shared/session/types"
import { cn } from "@/lib/utils"
import { LiveSubagentTranscript, streamsSubagentOnRow } from "@/components/timeline/LiveSubagentTranscript"
import { EditDiffView } from "./EditDiffView"
import { isRemoteDeviceActive } from "@/lib/device"
import { isBuiltInEditorEnabled, openFile } from "@/lib/fileOpener"
import { LocalImage } from "./LocalImage"
import { ElidedResultImage } from "./ElidedResultImage"
import { readElided } from "../../../shared/session/resultProjection"
import { isLocalImagePath } from "./localMedia"
import type { SkillMeta } from "@/hooks/useSkillMetadata"
import { DisclosureScope, useDisclosure, useDisclosureKey } from "./disclosure"
import { useTimelineRowFacts } from "./TimelineRowsProvider"
import { ToolCallInput } from "./ToolCallInput"
import { CodexExecToolInput } from "./CodexExecToolInput"
import {
  BashCommandCard,
  bashSections,
} from "./BashCommandCard"
import { AskUserQuestionCard } from "./AskUserQuestionCard"
import { JsonResultHighlighted, ToolResultPanel } from "./ToolCallResult"
import { isCodexExecCall } from "../../../shared/session/codex-exec"
import { getCommandText, getToolPresentation } from "../../../shared/session/toolSummary"
import { Button } from "@/components/ui/button"
import { Collapsible, CollapsibleContent } from "@/components/ui/collapsible"
import { ToolCallStatus, ToolOperationIcon } from "./ToolCallStatus"
import { ToolFileDiffs } from "./ToolFileDiffs"
import { toolCallFailed, toolVerb } from "@/lib/toolActivity"
import { computeDiff } from "@/lib/rendering/diff"
import { crewCallSentence, describeCrewCall, type CrewCall } from "@/lib/crewCommands"
import { revealSessionById } from "@/lib/revealSession"
import { useSessionNamer } from "@/hooks/useSessionNamer"

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

/** What the call acted on, after its verb: a path keeps its file name when the folders give way. */
function ToolTarget({ summary, filePath, monospace }: { summary: string; filePath: boolean; monospace: boolean }) {
  const separator = Math.max(summary.lastIndexOf("/"), summary.lastIndexOf("\\"))
  if (filePath && separator >= 0) {
    return (
      <span className="flex min-w-0 font-mono text-xs" title={summary}>
        <span className="truncate text-muted-foreground/80">{summary.slice(0, separator + 1)}</span>
        <span className="max-w-full shrink-0 truncate text-foreground/80">{summary.slice(separator + 1)}</span>
      </span>
    )
  }
  return <span className={cn("min-w-0 truncate text-muted-foreground", monospace && "font-mono text-xs")} title={summary}>{summary}</span>
}

/** Lines an edit added and removed, when that is cheap to know. */
function editStat(toolCall: ToolCall, hasEditDiff: boolean): { add: number; del: number } | null {
  if (toolCall.isError) return null
  if (toolCall.diffLineCounts) return toolCall.diffLineCounts
  if (toolCall.fileDiffs?.length) {
    let add = 0
    let del = 0
    for (const hunk of toolCall.fileDiffs.flatMap((diff) => diff.hunks)) {
      for (const line of hunk.lines) {
        if (line.startsWith("+")) add++
        else if (line.startsWith("-")) del++
      }
    }
    return add || del ? { add, del } : null
  }
  if (!hasEditDiff) return null
  const before = toolCall.input.old_string as string
  const after = toolCall.input.new_string as string
  if (before.length + after.length > 40_000) return null
  let add = 0
  let del = 0
  for (const line of computeDiff(before, after)) {
    if (line.type === "added") add++
    else if (line.type === "removed") del++
  }
  return add || del ? { add, del } : null
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

/**
 * A crew call's line with the sessions it names. Only crew calls subscribe
 * to the session list for names, so other cards do not re-render on its polls.
 */
function CrewCallHeadline({ call }: { call: CrewCall }) {
  const sentence = crewCallSentence(call, useSessionNamer())
  return <span className="min-w-0 truncate text-foreground/90" title={sentence}>{sentence}</span>
}

/** The sessions a crew call acted on, each a link to open it. */
function CrewCallSessions({ call }: { call: CrewCall }) {
  const nameOf = useSessionNamer()
  if (call.sessionIds.length === 0) return null
  return (
    <div className="mb-2 flex flex-wrap items-center gap-1.5" aria-label="Sessions this call acted on">
      {call.sessionIds.map((sessionId, index) => (
        <Button
          key={sessionId}
          type="button"
          variant="outline"
          size="xs"
          onClick={() => void revealSessionById(sessionId)}
        >
          {nameOf(sessionId) ?? (call.verb === "new" ? call.names[index] : undefined) ?? sessionId.slice(0, 8)}
          <ChevronRight data-icon="inline-end" />
        </Button>
      ))}
    </div>
  )
}

// ── Main component ───────────────────────────────────────────────────────

interface ToolCallCardProps {
  toolCall: ToolCall
  expandToolPayloads?: boolean
  isAgentActive?: boolean
  skillMetadata?: Map<string, SkillMeta>
}

/**
 * One tool call. Its disclosure state is keyed by the call's id, which is
 * unique in the session, so it survives regrouping, folds and remounts.
 */
export const ToolCallCard = memo(function ToolCallCard(props: ToolCallCardProps) {
  return (
    <DisclosureScope id={`call:${props.toolCall.id}`} underTurn>
      <ToolCallCardBody {...props} />
    </DisclosureScope>
  )
})

function ToolCallCardBody({
  toolCall,
  expandToolPayloads = false,
  isAgentActive,
  skillMetadata,
}: ToolCallCardProps) {
  const facts = useTimelineRowFacts()
  const [panelOpen, setPanelOpen] = useDisclosure(useDisclosureKey("panel"), false)
  const [inputOpen, setInputOpen] = useDisclosure(useDisclosureKey("input"), false)
  const panelId = useId()
  const inputId = useId()
  const statusId = useId()
  const isCodexExec = isCodexExecCall(toolCall)
  const hasCommand = !isCodexExec &&
    (toolCall.name === "Bash" || /(?:^|[._])exec_command$/.test(toolCall.name)) &&
    Boolean(getCommandText(toolCall.input))
  const presentation = useMemo(() => getToolPresentation(toolCall), [toolCall])
  const sections = useMemo(
    () => hasCommand ? bashSections(toolCall) : null,
    [hasCommand, toolCall],
  )
  const failed = useMemo(() => toolCallFailed(toolCall), [toolCall])
  // A lead drives its crew from the shell; its calls read as what they did.
  const crewCall = useMemo(
    () => (hasCommand ? describeCrewCall(getCommandText(toolCall.input), toolCall.result) : null),
    [hasCommand, toolCall.input, toolCall.result],
  )
  const displayName = crewCall ? "Crew" : presentation.label
  const nameTitle = presentation.label === toolCall.name
    ? toolCall.name
    : `${presentation.label} (${toolCall.name})`
  const timeLabel = toolCall.timestamp
    ? new Date(toolCall.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })
    : undefined
  const timeIso = toolCall.timestamp ? new Date(toolCall.timestamp).toISOString() : undefined

  const showPanel = expandToolPayloads || panelOpen

  const summary = crewCall
    ? crewCallSentence(crewCall, () => undefined)
    : hasCommand && typeof toolCall.input.description === "string" && toolCall.input.description.trim()
    ? toolCall.input.description
    : sections && sections.length > 1
      ? `${sections.length} commands · ${sections.map((section) => section.label || section.command.split(/\s+/)[0]).join(", ")}`
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

  const diffStat = useMemo(() => editStat(toolCall, hasEditDiff), [toolCall, hasEditDiff])

  const imagePath = imageReadPath(toolCall)
  const hasResultImages = Boolean(toolCall.resultImages?.length)
  const hasImagePreview = imagePath !== null && toolCall.result?.trim() === "" && !hasResultImages
  const showResult = toolCall.result !== null && !hasImagePreview && !hasCommand &&
    (!hasResultImages || Boolean(toolCall.result?.trim())) &&
    (!hasEditDiff || toolCall.isError || toolCall.awaitingReview)

  if (toolCall.name === "AskUserQuestion") {
    // Answerability comes from the session's pending interaction, never from
    // live-traffic heuristics: a question-blocked session emits no traffic, so
    // isAgentActive goes false exactly when the answer form is needed most.
    return (
      <AskUserQuestionCard
        toolCall={toolCall}
        expandToolPayloads={expandToolPayloads}
        isAwaitingAnswer={facts?.openQuestionId === toolCall.id}
        sessionId={facts?.sessionId ?? undefined}
        canAnswer={facts?.canAnswer ?? false}
      />
    )
  }

  const running = toolCall.result === null && Boolean(isAgentActive) && !toolCall.awaitingReview
  const verb = toolVerb(presentation.label, running)
  const isPathTarget = [toolCall.input.file_path, toolCall.input.path, toolCall.input.notebook_path].includes(summary)
  const target = summary && summary !== verb ? summary : ""

  return (
    <div className="min-w-0" data-tool-call-id={toolCall.id} data-scroll-anchor="">
      <button
        type="button"
        className={cn(
          "group/tool flex min-h-8 w-full min-w-0 items-center gap-2 rounded-md px-2 py-1 text-left text-[13px] leading-5 transition-colors hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
          showPanel && "bg-muted/40",
        )}
        title={timeLabel ? `${nameTitle} · ${timeLabel}` : nameTitle}
        aria-label={`Toggle ${displayName} details${summary ? `: ${summary}` : ""}`}
        aria-expanded={showPanel}
        aria-controls={panelId}
        aria-describedby={statusId}
        onClick={() => {
          if (!expandToolPayloads) setPanelOpen((open) => !open)
        }}
      >
        <span className={cn("flex size-4 shrink-0 items-center justify-center text-muted-foreground", failed && "text-destructive", running && "text-info")}>
          {running
            ? <Loader2 className="size-3.5 motion-safe:animate-spin" aria-hidden="true" />
            : <ToolOperationIcon styleName={crewCall ? "Crew" : presentation.styleName} />}
        </span>
        <span className="flex min-w-0 flex-1 items-baseline gap-1.5">
          {crewCall ? (
            <CrewCallHeadline call={crewCall} />
          ) : (
            <>
              <span className={cn("shrink-0 font-medium", failed ? "text-destructive" : "text-foreground/90")}>{verb}</span>
              {target && (
                <ToolTarget
                  summary={target}
                  filePath={isPathTarget}
                  monospace={!hasCommand || !toolCall.input.description}
                />
              )}
              {diffStat && (
                <span className="shrink-0 font-mono text-xs tabular-nums">
                  {diffStat.add > 0 && <span className="text-success">+{diffStat.add}</span>}
                  {diffStat.add > 0 && diffStat.del > 0 && " "}
                  {diffStat.del > 0 && <span className="text-destructive">−{diffStat.del}</span>}
                </span>
              )}
            </>
          )}
        </span>
        <span id={statusId} className="flex shrink-0 items-center gap-2">
          {Boolean(toolCall.hookDurationMs && toolCall.hookDurationMs > 0) && <span className="text-xs tabular-nums text-muted-foreground" title="PostToolUse hook duration">{toolCall.hookDurationMs}ms</span>}
          {toolCall.outputReplacedByHook && <span className="text-xs text-info" title="Output replaced by hook">hook</span>}
          <ToolCallStatus toolCall={toolCall} failed={failed} isAgentActive={isAgentActive} />
        </span>
        <ChevronRight className={cn("size-3.5 shrink-0 text-muted-foreground opacity-0 transition-[transform,opacity] group-hover/tool:opacity-100 group-focus-visible/tool:opacity-100", showPanel && "rotate-90 opacity-100")} aria-hidden="true" />
        {timeLabel && <time className="sr-only" dateTime={timeIso}>{timeLabel}</time>}
      </button>

      {hasImagePreview && (
        <LocalImage
          src={imagePath}
          alt={imagePath.slice(imagePath.lastIndexOf("/") + 1)}
          id={`tool-image:${toolCall.id}`}
          className="my-1.5"
          maxHeightRem={10}
        />
      )}

      {toolCall.resultImages?.map((image, index) => {
        const elided = readElided(image.source.data)
        return elided ? (
          <ElidedResultImage
            key={elided.stub.ref}
            stub={elided.stub}
            mediaType={image.source.media_type}
            alt={`Tool result image ${index + 1}`}
            id={`tool-result-image:${toolCall.id}:${index}`}
          />
        ) : (
          <LocalImage
            key={`${image.source.media_type}-${image.source.data.length}-${image.source.data.slice(0, 32)}-${image.source.data.slice(-32)}`}
            src={`data:${image.source.media_type};base64,${image.source.data}`}
            alt={`Tool result image ${index + 1}`}
            id={`tool-result-image:${toolCall.id}:${index}`}
            className="my-1.5"
            maxHeightRem={10}
          />
        )
      })}

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
          <div className="min-w-0 pb-2 pl-8 pr-2 pt-1">
            {hasEditDiff && <EditToolDiff toolCall={toolCall} />}
            {crewCall && <CrewCallSessions call={crewCall} />}
            {hasCommand ? (
              <BashCommandCard
                toolCall={toolCall}
                cwd={facts?.cwd}
                expandAll={expandToolPayloads}
                isAgentActive={Boolean(isAgentActive)}
              />
            ) : isCodexExec ? (
              <CodexExecToolInput input={toolCall.input} />
            ) : !hasEditDiff ? <ToolCallInput input={toolCall.input} /> : null}
            <ToolFileDiffs fileDiffs={toolCall.fileDiffs} additionalFileDiffs={toolCall.additionalFileDiffs} />
            {showResult && (
              <ToolResultPanel
                result={toolCall.result ?? ""}
                resultRef={toolCall.resultRef}
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
                Raw input
              </Button>
              <CollapsibleContent id={inputId}>
                <JsonResultHighlighted
                  result={JSON.stringify(toolCall.input)}
                />
              </CollapsibleContent>
            </Collapsible>
          </div>
        </CollapsibleContent>
      </Collapsible>

      {streamsSubagentOnRow(toolCall) && <LiveSubagentTranscript toolUseId={toolCall.id} />}
    </div>
  )
}
