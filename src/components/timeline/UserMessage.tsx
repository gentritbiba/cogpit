import { useState, useMemo, useCallback, memo, type ReactNode } from "react"
import { ChevronDown, ChevronRight, Eye, EyeOff, Hand, Maximize2, Terminal, Pencil, Users } from "lucide-react"
import ReactMarkdown from "react-markdown"
import { markdownComponents, markdownPlugins } from "./markdown-components"
import type { UserContent } from "@/lib/types"
import { getUserMessageText, getUserMessageImages } from "@/lib/parser"
import { parseTeammateMessage } from "@/lib/teammateMessage"
import {
  extractCommandArgs,
  extractCommandName,
  hasSystemTags,
  parseInterrupts,
  parseLocalCommandOutputs,
  parseTaskNotifications,
  stripSystemNotificationPreamble,
  stripSystemTags,
  type LocalCommandOutput,
  type TaskNotification,
} from "@/lib/userMessageContent"
import { cn } from "@/lib/utils"
import { CompletedIcon, FailedIcon, RunningIcon, ProcessingIcon } from "@/components/ui/StatusIcons"
import { ImageViewer, type ImageViewerItem } from "./ImageViewer"
import { useOptionalImageGallery } from "./SessionImageGallery"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible"

function LocalCommandOutputCard({ output }: { output: LocalCommandOutput }) {
  const isError = output.stream === "stderr"
  const isInput = output.stream === "input"
  return (
    <div className={cn(
      "rounded-md border px-3 py-2 my-1 font-mono text-xs",
      isError && "border-destructive/20 bg-destructive/5 text-destructive",
      isInput && "border-border bg-muted/50 text-foreground",
      !isError && !isInput && "border-border bg-muted/40 text-muted-foreground",
    )}>
      <div className="flex items-center gap-1.5">
        {isInput ? (
          <ChevronRight className="size-3 shrink-0 text-muted-foreground" data-icon="inline-start" />
        ) : (
          <Terminal className={cn("size-3 shrink-0", isError ? "text-destructive" : "text-muted-foreground")} data-icon="inline-start" />
        )}
        <span className="whitespace-pre-wrap break-words">{output.text}</span>
      </div>
    </div>
  )
}

const ERROR_STYLE = {
  Icon: FailedIcon,
  color: "text-destructive",
  bg: "border-destructive/20 bg-destructive/5",
  badgeVariant: "destructive",
} as const

const STATUS_STYLES = {
  completed: { Icon: CompletedIcon, color: "text-success", bg: "border-success/20 bg-success/5", badgeVariant: "secondary", label: "Completed" },
  failed: { ...ERROR_STYLE, label: "Failed" },
  error: { ...ERROR_STYLE, label: "Error" },
  running: { Icon: RunningIcon, color: "text-warning", bg: "border-warning/20 bg-warning/5", badgeVariant: "outline", label: "Running" },
} as const

function TaskNotificationCard({ notification }: { notification: TaskNotification }) {
  const [expanded, setExpanded] = useState(false)
  const statusStyle = STATUS_STYLES[notification.status as keyof typeof STATUS_STYLES] ?? STATUS_STYLES.running
  const { Icon: StatusIcon } = statusStyle
  const hasDetail = notification.result.length > 0 || notification.outputFile.length > 0
  const Chevron = expanded ? ChevronDown : ChevronRight

  return (
    <Collapsible
      open={expanded}
      onOpenChange={setExpanded}
      className={cn("my-1 rounded-lg border p-3", statusStyle.bg)}
    >
      <div className="flex items-start gap-2">
        <StatusIcon className={cn("mt-0.5 size-4 shrink-0", statusStyle.color)} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-medium text-foreground">{notification.summary}</span>
            <Badge variant={statusStyle.badgeVariant} className={statusStyle.color}>
              {statusStyle.label}
            </Badge>
          </div>
          {hasDetail && (
            <>
              <CollapsibleTrigger
                render={(
                  <Button
                    type="button"
                    variant="ghost"
                    size="xs"
                    className="mt-1.5 -ml-2 text-muted-foreground"
                  />
                )}
              >
                <Chevron data-icon="inline-start" />
                {expanded ? "Hide detail" : "Show detail"}
              </CollapsibleTrigger>
              <CollapsibleContent>
                <div className="mt-2 border-t border-border/30 pt-2 text-sm text-foreground/90">
                  {notification.result && (
                    <ReactMarkdown components={markdownComponents} remarkPlugins={markdownPlugins}>
                      {notification.result}
                    </ReactMarkdown>
                  )}
                  {notification.outputFile && (
                    <div className="mt-2">
                      <div className="text-xs font-medium text-muted-foreground">Output file</div>
                      <div className="mt-1 select-all break-all rounded bg-muted px-2 py-1 font-mono text-xs text-muted-foreground">
                        {notification.outputFile}
                      </div>
                    </div>
                  )}
                </div>
              </CollapsibleContent>
            </>
          )}
        </div>
      </div>
    </Collapsible>
  )
}

// ── Expanded command content ─────────────────────────────────────────────

function ExpandedCommandContent({ loading, content }: { loading: boolean; content: string | null }): ReactNode {
  let inner: ReactNode
  if (loading) {
    inner = (
      <span className="inline-flex items-center gap-1.5 text-muted-foreground/60 font-mono">
        <ProcessingIcon className="w-3 h-3 text-muted-foreground/60" /> Loading...
      </span>
    )
  } else if (content) {
    inner = <ReactMarkdown components={markdownComponents} remarkPlugins={markdownPlugins}>{content}</ReactMarkdown>
  } else {
    inner = <span className="text-muted-foreground/60 font-mono">Could not load command content</span>
  }

  return (
    <div className="mt-2 max-h-80 overflow-auto rounded-md border border-border bg-muted/40 p-3 text-xs text-muted-foreground">
      {inner}
    </div>
  )
}

// ── Main component ───────────────────────────────────────────────────────

interface UserMessageProps {
  content: UserContent
  timestamp: string
  onEditCommand?: (commandName: string) => void
  onExpandCommand?: (commandName: string, args?: string) => Promise<string | null>
  compact?: boolean
}

export const UserMessage = memo(function UserMessage({ content, timestamp, onEditCommand, onExpandCommand, compact = false }: UserMessageProps) {
  const imageGallery = useOptionalImageGallery()
  const [expanded, setExpanded] = useState(false)
  const [showRaw, setShowRaw] = useState(false)
  const [commandExpanded, setCommandExpanded] = useState(false)
  const [commandContent, setCommandContent] = useState<string | null>(null)
  const [commandLoading, setCommandLoading] = useState(false)
  const [standaloneViewer, setStandaloneViewer] = useState<{ index: number; open: boolean } | null>(null)

  const rawText = useMemo(() => getUserMessageText(content), [content])
  const commandName = useMemo(() => extractCommandName(rawText), [rawText])
  const commandArgs = useMemo(() => extractCommandArgs(rawText), [rawText])
  const { teammateId, isTeammate, text: unwrappedText } = useMemo(() => parseTeammateMessage(rawText), [rawText])
  const cleanText = useMemo(() => stripSystemTags(unwrappedText), [unwrappedText])
  const { text: textAfterBanner, isSystemNotification } = useMemo(
    () => stripSystemNotificationPreamble(cleanText),
    [cleanText],
  )
  const { notifications, remainingText: textAfterNotifications } = useMemo(() => parseTaskNotifications(textAfterBanner), [textAfterBanner])
  const { outputs: cmdOutputs, remainingText: textAfterOutputs } = useMemo(() => parseLocalCommandOutputs(textAfterNotifications), [textAfterNotifications])
  const { interrupts, remainingText: textAfterInterrupts } = useMemo(() => parseInterrupts(textAfterOutputs), [textAfterOutputs])

  const handleCommandOpenChange = useCallback(async (nextOpen: boolean) => {
    if (!nextOpen) {
      setCommandExpanded(false)
      return
    }
    if (commandContent !== null) {
      setCommandExpanded(true)
      return
    }
    if (!onExpandCommand || !commandName) return
    setCommandLoading(true)
    setCommandExpanded(true)
    try {
      const result = await onExpandCommand(commandName, commandArgs ?? undefined)
      setCommandContent(result)
    } finally {
      setCommandLoading(false)
    }
  }, [commandContent, onExpandCommand, commandName, commandArgs])

  const images = useMemo(() => getUserMessageImages(content), [content])
  const imageUrls = useMemo(
    () => images.map((img) => `data:${img.source.media_type};base64,${img.source.data}`),
    [images]
  )
  const viewerImages = useMemo<ImageViewerItem[]>(
    () => imageUrls.map((src, index) => ({
      id: `message-attachment-${index}`,
      src,
      alt: `Attachment ${index + 1}`,
      label: imageUrls.length > 1 ? `Attachment ${index + 1}` : "Attached image",
    })),
    [imageUrls],
  )
  // Ask the parser directly rather than diffing raw against clean: the diff also
  // fires on plain whitespace trimming, offering "Show raw" when nothing is
  // hidden. The teammate envelope and the notification banner are genuinely
  // hidden, so they still count.
  const hasTags = useMemo(
    () => hasSystemTags(rawText) || isSystemNotification || isTeammate,
    [rawText, isSystemNotification, isTeammate],
  )
  const displayText = showRaw ? rawText : textAfterInterrupts

  const isTruncated = displayText.length > 500 && !expanded
  const visibleText = isTruncated ? displayText.slice(0, 500) + "..." : displayText

  const openImage = (index: number) => {
    const image = viewerImages[index]
    if (!image) return
    if (imageGallery) {
      imageGallery.openImage(image)
    } else {
      setStandaloneViewer({ index, open: true })
    }
  }

  return (
    <div className="group">
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 mb-1">
          {hasTags && (
            <Button
              type="button"
              variant="ghost"
              size="xs"
              onClick={() => setShowRaw(!showRaw)}
              className="-ml-2 text-muted-foreground"
            >
              {showRaw ? (
                <>
                  <EyeOff data-icon="inline-start" /> Hide raw
                </>
              ) : (
                <>
                  <Eye data-icon="inline-start" /> Show raw
                </>
              )}
            </Button>
          )}
        </div>

        {!showRaw && isSystemNotification && (
          <div className="mb-2">
            <Badge variant="outline" className="text-muted-foreground">
              <Terminal data-icon="inline-start" />
              System event
            </Badge>
          </div>
        )}

        {!showRaw && isTeammate && (
          <div className="mb-2">
            <Badge variant="outline" className="text-muted-foreground">
              <Users data-icon="inline-start" />
              {teammateId ? `From ${teammateId}` : "Teammate message"}
            </Badge>
          </div>
        )}

        {commandName && (
          <Collapsible
            open={commandExpanded}
            onOpenChange={(nextOpen) => void handleCommandOpenChange(nextOpen)}
            className="mb-2"
          >
            <div className="flex items-center gap-2">
              <Badge variant="outline" className="font-mono text-foreground">
                <Terminal data-icon="inline-start" />
                /{commandName}
                {commandArgs && (
                  <span className="text-muted-foreground">{commandArgs}</span>
                )}
              </Badge>
              {onExpandCommand && (
                <CollapsibleTrigger
                  render={(
                    <Button
                      type="button"
                      variant="ghost"
                      size="xs"
                      className="text-muted-foreground"
                    />
                  )}
                >
                  {commandExpanded ? <ChevronDown data-icon="inline-start" /> : <ChevronRight data-icon="inline-start" />}
                  {commandExpanded ? "Collapse" : "Expand"}
                </CollapsibleTrigger>
              )}
              {commandExpanded && onEditCommand && (
                <Button
                  type="button"
                  variant="ghost"
                  size="xs"
                  onClick={() => onEditCommand(commandName)}
                  className="text-muted-foreground"
                >
                  <Pencil data-icon="inline-start" />
                  Edit
                </Button>
              )}
            </div>
            <CollapsibleContent>
              <ExpandedCommandContent loading={commandLoading} content={commandContent} />
            </CollapsibleContent>
          </Collapsible>
        )}

        {imageUrls.length > 0 && (
          <div className="mb-3 flex flex-wrap gap-2">
            {imageUrls.map((url, i) => (
              <Button
                key={`${images[i].source.media_type}-${images[i].source.data.slice(0, 24)}-${i}`}
                type="button"
                variant="ghost"
                onClick={() => openImage(i)}
                aria-label={`Open attached image ${i + 1}`}
                className={cn(
                  "group/image relative h-auto max-w-full overflow-hidden rounded-lg border border-border bg-background p-1 text-left",
                  "transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40",
                )}
              >
                <img
                  src={url}
                  alt={`Attachment ${i + 1}`}
                  loading="lazy"
                  decoding="async"
                  className="max-h-64 max-w-full rounded-lg object-contain sm:max-w-md"
                />
                <span className="absolute right-2 top-2 flex size-7 items-center justify-center rounded-md border border-white/10 bg-black/45 text-white/70 opacity-80 backdrop-blur transition-[color,background-color,opacity] group-hover/image:bg-black/65 group-hover/image:text-white sm:opacity-0 sm:group-hover/image:opacity-100 sm:group-focus-visible/image:opacity-100">
                  <Maximize2 className="size-3.5" data-icon="icon" />
                </span>
                {imageUrls.length > 1 && (
                  <span className="absolute bottom-2 right-2 rounded-md bg-black/55 px-1.5 py-0.5 font-mono text-xs text-white/80">
                    {i + 1} / {imageUrls.length}
                  </span>
                )}
              </Button>
            ))}
          </div>
        )}

        {!showRaw && notifications.length > 0 && (
          <div className="mb-2 flex flex-col gap-2">
            {notifications.map((n) => (
              <TaskNotificationCard key={n.taskId} notification={n} />
            ))}
          </div>
        )}

        {!showRaw && cmdOutputs.length > 0 && (
          <div className="mb-2 flex flex-col gap-1">
            {cmdOutputs.map((o, i) => (
              <LocalCommandOutputCard key={i} output={o} />
            ))}
          </div>
        )}

        {!showRaw && interrupts.length > 0 && (
          <div className="mb-2 flex flex-col gap-1">
            {interrupts.map((text, i) => (
              <div key={i} className="flex items-center gap-1.5 text-xs font-medium text-destructive">
                <Hand className="size-3 shrink-0" data-icon="inline-start" />
                <span>{text}</span>
              </div>
            ))}
          </div>
        )}

        {visibleText && (
          <div className="max-w-none overflow-hidden break-words text-sm leading-relaxed">
            <ReactMarkdown components={markdownComponents} remarkPlugins={markdownPlugins}>{visibleText}</ReactMarkdown>
          </div>
        )}
        {displayText.length > 500 && (
          <Button
            type="button"
            variant="ghost"
            size="xs"
            onClick={() => setExpanded(!expanded)}
            className="mt-1 -ml-2 text-muted-foreground"
          >
            {expanded ? (
              <>
                <ChevronDown data-icon="inline-start" /> Show less
              </>
            ) : (
              <>
                <ChevronRight data-icon="inline-start" /> Show more
              </>
            )}
          </Button>
        )}
        {!compact && timestamp && (
          <div className="flex items-center mt-1.5 ml-auto">
            <span className="text-xs text-muted-foreground">
              {new Date(timestamp).toLocaleTimeString()}
            </span>
          </div>
        )}
      </div>

      {standaloneViewer !== null && (
        <ImageViewer
          key={standaloneViewer.index}
          open={standaloneViewer.open}
          images={viewerImages}
          initialIndex={standaloneViewer.index}
          onClose={() => setStandaloneViewer((current) => current ? { ...current, open: false } : null)}
          onCloseComplete={() => setStandaloneViewer(null)}
        />
      )}
    </div>
  )
})
