import { useState, useRef, useEffect, memo, useCallback, startTransition } from "react"
import { useNearViewport } from "@/hooks/useNearViewport"
import { ChevronDown, ChevronRight, Code2, GitCompareArrows } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip"
import { EditDiffView } from "../timeline/EditDiffView"
import { cn } from "@/lib/utils"
import { fileExtension } from "@/lib/fileTypeColors"
import { ChangeBar } from "@/components/shared/ChangeCounts"
import { openFile } from "@/lib/fileOpener"
import { OpIndicator, SubAgentIndicator } from "./file-change-indicators"
import type { GroupedFile, IndividualEdit } from "./useFileChangesData"

export type DiffMode = "net" | "per-edit"

interface GroupedFileCardProps {
  file: GroupedFile
  defaultOpen: boolean
  isHighlighted?: boolean
  diffMode: DiffMode
}

export const GroupedFileCard = memo(function GroupedFileCard({ file, defaultOpen, isHighlighted, diffMode }: GroupedFileCardProps) {
  const { ref: nearRef, isNear } = useNearViewport()
  const [open, setOpen] = useState(defaultOpen)
  // Deferred open: the card header updates immediately, diff content renders
  // as a lower-priority transition so the UI stays responsive.
  const [deferredOpen, setDeferredOpen] = useState(defaultOpen)
  const prevDefaultRef = useRef(defaultOpen)

  const setOpenWithTransition = useCallback((value: boolean) => {
    setOpen(value)
    if (value) {
      startTransition(() => setDeferredOpen(true))
    } else {
      setDeferredOpen(false)
    }
  }, [])

  useEffect(() => {
    if (prevDefaultRef.current !== defaultOpen) {
      prevDefaultRef.current = defaultOpen
      setOpenWithTransition(defaultOpen)
    }
  }, [defaultOpen, setOpenWithTransition])

  // Open the card when highlighted (clicked from file changes list)
  useEffect(() => {
    if (isHighlighted) setOpenWithTransition(true)
  }, [isHighlighted, setOpenWithTransition])

  const ext = fileExtension(file.filePath)

  const oldString = file.netOriginal
  const newString = file.netCurrent
  const hasNetDiff = Boolean(oldString || newString)
  const hasPerEditDiff = file.edits.some((e) => Boolean(e.oldString || e.newString))
  const hasDiff = diffMode === "per-edit" ? hasPerEditDiff : hasNetDiff

  const showDiff = deferredOpen && isNear && hasDiff
  const [lastDiffHeight, setLastDiffHeight] = useState(0)
  const measureDiff = useCallback((node: HTMLDivElement | null) => {
    if (!node) return
    const height = node.offsetHeight
    setLastDiffHeight((current) => current === height ? current : height)
  }, [])

  const turnLabel = file.turnRange[0] === file.turnRange[1]
    ? `T${file.turnRange[0] + 1}`
    : `T${file.turnRange[0] + 1}–T${file.turnRange[1] + 1}`

  return (
    <div
      ref={nearRef}
      data-file-path={file.filePath}
      className={cn(
        "rounded-lg border bg-card transition-colors",
        isHighlighted
          ? "border-ring ring-2 ring-ring/20"
          : "border-border",
      )}
    >
      <div className="group sticky top-0 z-10 flex w-full items-center rounded-t-lg bg-card transition-colors hover:bg-accent">
        <Button
          type="button"
          variant="ghost"
          onClick={() => setOpenWithTransition(!open)}
          className="h-auto min-w-0 flex-1 justify-start gap-1.5 rounded-r-none px-2 py-1 font-normal"
          aria-expanded={open}
        >
          {open ? (
            <ChevronDown data-icon="inline-start" className="size-3 shrink-0 text-muted-foreground" />
          ) : (
            <ChevronRight data-icon="inline-start" className="size-3 shrink-0 text-muted-foreground" />
          )}
          <span className="shrink-0 font-mono text-xs font-bold text-muted-foreground">
            {ext}
          </span>
          <OpIndicator hasEdit={file.opTypes.includes("Edit")} hasWrite={file.opTypes.includes("Write")} />
          <span className="truncate font-mono text-xs text-muted-foreground">
            {file.shortPath}
          </span>
          <span className="shrink-0 text-xs text-muted-foreground">
            {turnLabel}
          </span>
          {file.editCount > 1 && (
            <Badge
              variant="outline"
              className="h-5 shrink-0 px-1 font-mono text-xs text-muted-foreground"
            >
              {file.editCount}x
            </Badge>
          )}
        </Button>
        <div className="flex items-center gap-1.5 pr-2 shrink-0">
          {file.subAgentId && <SubAgentIndicator agentId={file.subAgentId} />}
          <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
            <Tooltip>
              <TooltipTrigger render={<Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  onClick={() => openFile(file.filePath)}
                  aria-label="Open file in editor"
                />}>
                  <Code2 data-icon="inline-start" />
              </TooltipTrigger>
              <TooltipContent>Open in editor</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger render={<Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  onClick={() => openFile(file.filePath, { mode: "diff" })}
                  aria-label="View git diff"
                />}>
                  <GitCompareArrows data-icon="inline-start" />
              </TooltipTrigger>
              <TooltipContent>View git diff</TooltipContent>
            </Tooltip>
          </div>
          {file.addCount > 0 && (
            <span className="font-mono text-xs tabular-nums text-success">+{file.addCount}</span>
          )}
          {file.delCount > 0 && (
            <span className="font-mono text-xs tabular-nums text-destructive">-{file.delCount}</span>
          )}
          <ChangeBar add={file.addCount} del={file.delCount} />
        </div>
      </div>
      <DiffContent
        showDiff={showDiff}
        open={open}
        hasDiff={hasDiff}
        diffRef={measureDiff}
        lastDiffHeight={lastDiffHeight}
        oldString={oldString}
        newString={newString}
        filePath={file.filePath}
        diffMode={diffMode}
        edits={file.edits}
        netStartLine={file.netStartLine}
      />
    </div>
  )
})

const DiffContent = memo(function DiffContent({
  showDiff,
  open,
  hasDiff,
  diffRef,
  lastDiffHeight,
  oldString,
  newString,
  filePath,
  diffMode,
  edits,
  netStartLine,
}: {
  showDiff: boolean
  open: boolean
  hasDiff: boolean
  diffRef: React.RefCallback<HTMLDivElement>
  lastDiffHeight: number
  oldString: string
  newString: string
  filePath: string
  diffMode: DiffMode
  edits: IndividualEdit[]
  netStartLine: number
}): React.ReactElement | null {
  if (showDiff) {
    return (
      <div key={diffMode} ref={diffRef} className="motion-enter overflow-hidden rounded-b">
        {diffMode === "per-edit" ? (
          <PerEditDiffs edits={edits} filePath={filePath} />
        ) : (
          <EditDiffView
            oldString={oldString}
            newString={newString}
            filePath={filePath}
            compact={false}
            startLine={netStartLine}
            hideHeader
          />
        )}
      </div>
    )
  }
  if (open && lastDiffHeight > 0) {
    return <div style={{ height: lastDiffHeight }} />
  }
  if (open && !hasDiff) {
    return (
      <div className="motion-enter px-3 py-2 text-xs italic text-muted-foreground">
        {diffMode === "per-edit" ? "No edits" : "No net changes (all edits cancelled out)"}
      </div>
    )
  }
  return null
})

const PER_EDIT_INITIAL = 3
const PER_EDIT_BATCH = 5

const PerEditDiffs = memo(function PerEditDiffs({ edits, filePath }: { edits: IndividualEdit[]; filePath: string }) {
  const total = edits.length
  const contentEdits = edits.filter((e) => Boolean(e.oldString || e.newString))
  const needsProgressive = contentEdits.length > PER_EDIT_INITIAL
  const [renderedCount, setRenderedCount] = useState(
    needsProgressive ? PER_EDIT_INITIAL : contentEdits.length
  )

  // Progressive rendering: render first batch, rest via rAF
  useEffect(() => {
    if (renderedCount >= contentEdits.length) return
    const frame = requestAnimationFrame(() => {
      setRenderedCount((prev) => Math.min(prev + PER_EDIT_BATCH, contentEdits.length))
    })
    return () => cancelAnimationFrame(frame)
  }, [renderedCount, contentEdits.length])

  const editsToRender = needsProgressive ? contentEdits.slice(0, renderedCount) : contentEdits

  return (
    <div className="divide-y divide-border/30">
      {editsToRender.map((edit, i) => (
        <div key={edit.id}>
          {total > 1 && (
            <div className="flex items-center gap-2 bg-muted/30 px-2.5 py-1">
              <span className="font-mono text-xs text-muted-foreground">
                {edit.toolName} {i + 1}/{total}
              </span>
              <span className="text-xs text-muted-foreground">
                T{edit.turnIndex + 1}
              </span>
              {edit.agentId && <SubAgentIndicator agentId={edit.agentId} />}
            </div>
          )}
          <EditDiffView
            oldString={edit.oldString}
            newString={edit.newString}
            filePath={filePath}
            compact={false}
            startLine={edit.startLine}
            hideHeader
          />
        </div>
      ))}
      {renderedCount < contentEdits.length && (
        <div className="py-1.5 text-center text-xs text-muted-foreground">
          Loading {contentEdits.length - renderedCount} more edits…
        </div>
      )}
    </div>
  )
})
