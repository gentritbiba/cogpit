import { useState, useMemo, useCallback, memo, type ReactNode } from "react"
import { User, Cog, ChevronDown, ChevronRight, Eye, EyeOff, Terminal, Pencil, Loader2 } from "lucide-react"
import ReactMarkdown from "react-markdown"
import { markdownComponents, markdownPlugins } from "./markdown-components"
import type { UserContent } from "@/lib/types"
import { getUserMessageText, getUserMessageImages } from "@/lib/parser"
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog"

const SYSTEM_TAG_RE =
  /<(?:system-reminder|local-command-caveat|command-name|command-message|command-args|teammate-message|env|claude_background_info|fast_mode_info|gitStatus)[^>]*>[\s\S]*?<\/(?:system-reminder|local-command-caveat|command-name|command-message|command-args|teammate-message|env|claude_background_info|fast_mode_info|gitStatus)>/g

const COMMAND_MESSAGE_RE = /<command-message>([^<]+)<\/command-message>/
const COMMAND_ARGS_RE = /<command-args>([\s\S]*?)<\/command-args>/

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

// ── Variant styles ───────────────────────────────────────────────────────

const VARIANT_STYLES = {
  user: {
    avatar: "w-7 h-7 rounded-full bg-blue-500/20 flex items-center justify-center",
    Icon: User,
    icon: "w-4 h-4 text-blue-400",
    label: "text-xs font-medium text-blue-400",
  },
  agent: {
    avatar: "w-7 h-7 rounded-full bg-green-500/20 flex items-center justify-center",
    Icon: Cog,
    icon: "w-4 h-4 text-green-400",
    label: "text-xs font-medium text-green-400",
  },
} as const

// ── Expanded command content ─────────────────────────────────────────────

function ExpandedCommandContent({ loading, content }: { loading: boolean; content: string | null }): ReactNode {
  let inner: ReactNode
  if (loading) {
    inner = (
      <span className="inline-flex items-center gap-1.5 text-muted-foreground/60 font-mono">
        <Loader2 className="w-3 h-3 animate-spin" /> Loading...
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

// ── Main component ───────────────────────────────────────────────────────

interface UserMessageProps {
  content: UserContent
  timestamp: string
  label?: string
  variant?: "user" | "agent"
  onEditCommand?: (commandName: string) => void
  onExpandCommand?: (commandName: string, args?: string) => Promise<string | null>
}

export const UserMessage = memo(function UserMessage({ content, timestamp, label = "User", variant = "user", onEditCommand, onExpandCommand }: UserMessageProps) {
  const [expanded, setExpanded] = useState(false)
  const [showRaw, setShowRaw] = useState(false)
  const [commandExpanded, setCommandExpanded] = useState(false)
  const [commandContent, setCommandContent] = useState<string | null>(null)
  const [commandLoading, setCommandLoading] = useState(false)
  const [modalImage, setModalImage] = useState<string | null>(null)

  const rawText = useMemo(() => getUserMessageText(content), [content])
  const commandName = useMemo(() => extractCommandName(rawText), [rawText])
  const commandArgs = useMemo(() => extractCommandArgs(rawText), [rawText])
  const cleanText = useMemo(() => stripSystemTags(rawText), [rawText])

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
  const displayText = showRaw ? rawText : cleanText

  const isTruncated = displayText.length > 500 && !expanded
  const visibleText = isTruncated ? displayText.slice(0, 500) + "..." : displayText

  const styles = VARIANT_STYLES[variant]
  const { Icon } = styles

  return (
    <div className="flex gap-3 group">
      <div className="flex-shrink-0 mt-1">
        <div className={styles.avatar}>
          <Icon className={styles.icon} />
        </div>
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 mb-1">
          <span className={styles.label}>{label}</span>
          {timestamp && (
            <span className="text-xs text-muted-foreground">
              {new Date(timestamp).toLocaleTimeString()}
            </span>
          )}
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
                onClick={() => setModalImage(url)}
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
      </div>

      <Dialog open={modalImage !== null} onOpenChange={(open) => !open && setModalImage(null)}>
        <DialogContent className="max-w-[90vw] max-h-[90vh] p-2 bg-elevation-1 border-border/50">
          <DialogTitle className="sr-only">Full size image</DialogTitle>
          {modalImage && (
            <img
              src={modalImage}
              alt="Full size"
              className="max-w-full max-h-[85vh] object-contain mx-auto"
            />
          )}
        </DialogContent>
      </Dialog>
    </div>
  )
})
