import { useState, useMemo, useCallback, useEffect, memo, type ReactNode } from "react"
import { ChevronDown, ChevronRight, ChevronLeft, Eye, EyeOff, Terminal, Pencil, X } from "lucide-react"
import ReactMarkdown from "react-markdown"
import { markdownComponents, markdownPlugins } from "./markdown-components"
import type { UserContent } from "@/lib/types"
import { getUserMessageText, getUserMessageImages } from "@/lib/parser"
import { cn } from "@/lib/utils"
import { CompletedIcon, FailedIcon, RunningIcon, ProcessingIcon } from "@/components/ui/StatusIcons"

const SYSTEM_TAG_RE =
  /<(?:system-reminder|local-command-caveat|command-name|command-message|command-args|teammate-message|env|claude_background_info|fast_mode_info|gitStatus)[^>]*>[\s\S]*?<\/(?:system-reminder|local-command-caveat|command-name|command-message|command-args|teammate-message|env|claude_background_info|fast_mode_info|gitStatus)>/g

const COMMAND_MESSAGE_RE = /<command-message>([^<]+)<\/command-message>/
const COMMAND_ARGS_RE = /<command-args>([\s\S]*?)<\/command-args>/

// ── Local command output parsing ────────────────────────────────────────
const LOCAL_CMD_OUTPUT_RE = /<local-command-(stdout|stderr)>([\s\S]*?)<\/local-command-\1>/g

interface LocalCommandOutput {
  text: string
  stream: "stdout" | "stderr"
}

function parseLocalCommandOutputs(text: string): { outputs: LocalCommandOutput[]; remainingText: string } {
  const outputs: LocalCommandOutput[] = []
  const remaining = text
    .replace(LOCAL_CMD_OUTPUT_RE, (_, stream, inner) => {
      outputs.push({ text: inner.trim(), stream: stream as "stdout" | "stderr" })
      return ""
    })
    .trim()
  return { outputs, remainingText: remaining }
}

function LocalCommandOutputCard({ output }: { output: LocalCommandOutput }) {
  const isError = output.stream === "stderr"
  return (
    <div className={cn(
      "rounded-md border px-3 py-2 my-1 font-mono text-xs",
      isError
        ? "border-red-500/20 bg-red-500/10 text-red-300"
        : "border-border/40 bg-elevation-2 text-muted-foreground",
    )}>
      <div className="flex items-center gap-1.5">
        <Terminal className={cn("w-3 h-3 flex-shrink-0", isError ? "text-red-400" : "text-muted-foreground/60")} />
        <span>{output.text}</span>
      </div>
    </div>
  )
}

// ── Task notification parsing ───────────────────────────────────────────

const TASK_NOTIFICATION_RE = /<task-notification>([\s\S]*?)<\/task-notification>/g

interface TaskNotification {
  taskId: string
  toolUseId: string
  status: string
  summary: string
  result: string
}

function extractTag(xml: string, tag: string): string {
  const re = new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`)
  const m = xml.match(re)
  return m ? m[1].trim() : ""
}

function parseTaskNotifications(text: string): { notifications: TaskNotification[]; remainingText: string } {
  const notifications: TaskNotification[] = []
  const remainingText = text.replace(TASK_NOTIFICATION_RE, (_, inner) => {
    notifications.push({
      taskId: extractTag(inner, "task-id"),
      toolUseId: extractTag(inner, "tool-use-id"),
      status: extractTag(inner, "status"),
      summary: extractTag(inner, "summary"),
      result: extractTag(inner, "result"),
    })
    return ""
  }).trim()
  return { notifications, remainingText }
}

const ERROR_STYLE = { Icon: FailedIcon, color: "text-red-400", bg: "bg-red-500/10 border-red-500/20" } as const

const STATUS_STYLES = {
  completed: { Icon: CompletedIcon, color: "text-emerald-400", bg: "bg-emerald-500/10 border-emerald-500/20", label: "Completed" },
  failed: { ...ERROR_STYLE, label: "Failed" },
  error: { ...ERROR_STYLE, label: "Error" },
  running: { Icon: RunningIcon, color: "text-amber-400", bg: "bg-amber-500/10 border-amber-500/20", label: "Running" },
} as const

function getStatusStyle(status: string) {
  return STATUS_STYLES[status as keyof typeof STATUS_STYLES] ?? STATUS_STYLES.running
}

function TaskNotificationCard({ notification }: { notification: TaskNotification }) {
  const [expanded, setExpanded] = useState(false)
  const statusStyle = getStatusStyle(notification.status)
  const { Icon: StatusIcon } = statusStyle
  const hasResult = notification.result.length > 0
  const Chevron = expanded ? ChevronDown : ChevronRight

  return (
    <div className={`rounded-lg border ${statusStyle.bg} p-3 my-1`}>
      <div className="flex items-start gap-2">
        <StatusIcon className={`w-4 h-4 mt-0.5 flex-shrink-0 ${statusStyle.color}`} />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-sm font-medium text-foreground">{notification.summary}</span>
            <span className={`text-[10px] px-1.5 py-0.5 rounded font-medium ${statusStyle.color} ${statusStyle.bg}`}>
              {statusStyle.label}
            </span>
          </div>
          {hasResult && (
            <>
              <button
                onClick={() => setExpanded(!expanded)}
                className="mt-1.5 text-xs text-muted-foreground hover:text-foreground flex items-center gap-1 transition-colors"
              >
                <Chevron className="w-3 h-3" />
                {expanded ? "Hide result" : "Show result"}
              </button>
              {expanded && (
                <div className="mt-2 text-sm text-foreground/90 border-t border-border/30 pt-2">
                  <ReactMarkdown components={markdownComponents} remarkPlugins={markdownPlugins}>
                    {notification.result}
                  </ReactMarkdown>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  )
}

function stripSystemTags(text: string): string {
  return text.replace(SYSTEM_TAG_RE, "").trim()
}

function extractCommandName(text: string): string | null {
  const match = text.match(COMMAND_MESSAGE_RE)
  return match ? match[1] : null
}

function extractCommandArgs(text: string): string | null {
  const match = text.match(COMMAND_ARGS_RE)
  return match ? match[1].trim() : null
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
    <div className="mt-2 rounded-md border border-border/50 bg-elevation-2 p-3 text-xs text-muted-foreground overflow-auto max-h-80">
      {inner}
    </div>
  )
}

// ── Image Lightbox ───────────────────────────────────────────────────────

function ImageLightbox({
  images,
  initialIndex,
  onClose,
}: {
  images: string[]
  initialIndex: number
  onClose: () => void
}) {
  const [index, setIndex] = useState(initialIndex)
  const hasMultiple = images.length > 1

  const goPrev = useCallback(() => setIndex((i) => (i - 1 + images.length) % images.length), [images.length])
  const goNext = useCallback(() => setIndex((i) => (i + 1) % images.length), [images.length])

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose()
      if (e.key === "ArrowLeft") goPrev()
      if (e.key === "ArrowRight") goNext()
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [onClose, goPrev, goNext])

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center" onClick={onClose}>
      {/* Overlay */}
      <div className="absolute inset-0 bg-black/80 backdrop-blur-sm" />

      {/* Close button */}
      <button
        onClick={onClose}
        className="absolute top-4 right-4 z-10 rounded-full bg-white/10 hover:bg-white/20 p-2 text-white transition-colors"
      >
        <X className="w-5 h-5" />
      </button>

      {/* Counter */}
      {hasMultiple && (
        <div className="absolute top-4 left-1/2 -translate-x-1/2 z-10 text-white/70 text-sm font-medium bg-black/40 rounded-full px-3 py-1">
          {index + 1} / {images.length}
        </div>
      )}

      {/* Left arrow */}
      {hasMultiple && (
        <button
          onClick={(e) => { e.stopPropagation(); goPrev() }}
          className="absolute left-4 z-10 rounded-full bg-white/10 hover:bg-white/20 p-2 text-white transition-colors"
        >
          <ChevronLeft className="w-6 h-6" />
        </button>
      )}

      {/* Image */}
      <img
        src={images[index]}
        alt={`Image ${index + 1}`}
        className="relative z-[1] max-w-[90vw] max-h-[90vh] object-contain rounded-lg"
        onClick={(e) => e.stopPropagation()}
      />

      {/* Right arrow */}
      {hasMultiple && (
        <button
          onClick={(e) => { e.stopPropagation(); goNext() }}
          className="absolute right-4 z-10 rounded-full bg-white/10 hover:bg-white/20 p-2 text-white transition-colors"
        >
          <ChevronRight className="w-6 h-6" />
        </button>
      )}
    </div>
  )
}

// ── Main component ───────────────────────────────────────────────────────

interface UserMessageProps {
  content: UserContent
  timestamp: string
  onEditCommand?: (commandName: string) => void
  onExpandCommand?: (commandName: string, args?: string) => Promise<string | null>
}

export const UserMessage = memo(function UserMessage({ content, timestamp, onEditCommand, onExpandCommand }: UserMessageProps) {
  const [expanded, setExpanded] = useState(false)
  const [showRaw, setShowRaw] = useState(false)
  const [commandExpanded, setCommandExpanded] = useState(false)
  const [commandContent, setCommandContent] = useState<string | null>(null)
  const [commandLoading, setCommandLoading] = useState(false)
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null)

  const rawText = useMemo(() => getUserMessageText(content), [content])
  const commandName = useMemo(() => extractCommandName(rawText), [rawText])
  const commandArgs = useMemo(() => extractCommandArgs(rawText), [rawText])
  const cleanText = useMemo(() => stripSystemTags(rawText), [rawText])
  const { notifications, remainingText: textAfterNotifications } = useMemo(() => parseTaskNotifications(cleanText), [cleanText])
  const { outputs: cmdOutputs, remainingText: textAfterOutputs } = useMemo(() => parseLocalCommandOutputs(textAfterNotifications), [textAfterNotifications])

  const handleToggleExpand = useCallback(async () => {
    if (commandExpanded) {
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
    const result = await onExpandCommand(commandName, commandArgs ?? undefined)
    setCommandContent(result)
    setCommandLoading(false)
  }, [commandExpanded, commandContent, onExpandCommand, commandName, commandArgs])

  const images = useMemo(() => getUserMessageImages(content), [content])
  const imageUrls = useMemo(
    () => images.map((img) => `data:${img.source.media_type};base64,${img.source.data}`),
    [images]
  )
  const hasTags = rawText !== cleanText
  const displayText = showRaw ? rawText : textAfterOutputs

  const isTruncated = displayText.length > 500 && !expanded
  const visibleText = isTruncated ? displayText.slice(0, 500) + "..." : displayText

  return (
    <div className="group">
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 mb-1">
          {hasTags && (
            <button
              onClick={() => setShowRaw(!showRaw)}
              className="text-xs text-muted-foreground hover:text-foreground flex items-center gap-1 transition-colors"
            >
              {showRaw ? (
                <>
                  <EyeOff className="w-3 h-3" /> Hide raw
                </>
              ) : (
                <>
                  <Eye className="w-3 h-3" /> Show raw
                </>
              )}
            </button>
          )}
        </div>

        {commandName && (
          <div className="mb-2">
            <div className="flex items-center gap-2">
              <span className="inline-flex items-center gap-1.5 rounded-md border border-blue-500/25 bg-blue-500/10 px-2 py-1 text-xs font-mono text-blue-400">
                <Terminal className="w-3 h-3" />
                /{commandName}
                {commandArgs && (
                  <span className="text-blue-400/60">{commandArgs}</span>
                )}
              </span>
              {onExpandCommand && (
                <button
                  onClick={handleToggleExpand}
                  className="inline-flex items-center gap-1 rounded-md px-1.5 py-1 text-[11px] text-muted-foreground hover:text-foreground hover:bg-elevation-3 transition-colors"
                >
                  {commandExpanded ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
                  {commandExpanded ? "Collapse" : "Expand"}
                </button>
              )}
              {commandExpanded && onEditCommand && (
                <button
                  onClick={() => onEditCommand(commandName)}
                  className="inline-flex items-center gap-1 rounded-md px-1.5 py-1 text-[11px] text-muted-foreground hover:text-foreground hover:bg-elevation-3 transition-colors"
                >
                  <Pencil className="w-3 h-3" />
                  Edit
                </button>
              )}
            </div>
            {commandExpanded && (
              <ExpandedCommandContent loading={commandLoading} content={commandContent} />
            )}
          </div>
        )}

        {imageUrls.length > 0 && (
          <div className="flex flex-wrap gap-2 mb-2">
            {imageUrls.map((url, i) => (
              <button
                key={i}
                onClick={() => setLightboxIndex(i)}
                className="rounded-lg overflow-hidden border border-border/50 hover:border-blue-500/50 transition-colors cursor-pointer"
              >
                <img
                  src={url}
                  alt={`Attached image ${i + 1}`}
                  className="max-h-40 max-w-60 object-contain bg-elevation-2"
                />
              </button>
            ))}
          </div>
        )}

        {!showRaw && notifications.length > 0 && (
          <div className="space-y-2 mb-2">
            {notifications.map((n) => (
              <TaskNotificationCard key={n.taskId} notification={n} />
            ))}
          </div>
        )}

        {!showRaw && cmdOutputs.length > 0 && (
          <div className="space-y-1 mb-2">
            {cmdOutputs.map((o, i) => (
              <LocalCommandOutputCard key={i} output={o} />
            ))}
          </div>
        )}

        {visibleText && (
          <div className="max-w-none text-sm break-words overflow-hidden">
            <ReactMarkdown components={markdownComponents} remarkPlugins={markdownPlugins}>{visibleText}</ReactMarkdown>
          </div>
        )}
        {displayText.length > 500 && (
          <button
            onClick={() => setExpanded(!expanded)}
            className="mt-1 text-xs text-muted-foreground hover:text-foreground flex items-center gap-1 transition-colors"
          >
            {expanded ? (
              <>
                <ChevronDown className="w-3 h-3" /> Show less
              </>
            ) : (
              <>
                <ChevronRight className="w-3 h-3" /> Show more
              </>
            )}
          </button>
        )}
        {timestamp && (
          <div className="flex items-center mt-1.5 ml-auto">
            <span className="text-[10px] text-muted-foreground/50">
              {new Date(timestamp).toLocaleTimeString()}
            </span>
          </div>
        )}
      </div>

      {lightboxIndex !== null && (
        <ImageLightbox
          images={imageUrls}
          initialIndex={lightboxIndex}
          onClose={() => setLightboxIndex(null)}
        />
      )}
    </div>
  )
})
