import { useState, useMemo, memo } from "react"
import { User, Cog, ChevronDown, ChevronRight, Eye, EyeOff } from "lucide-react"
import ReactMarkdown from "react-markdown"
import { markdownComponents, markdownPlugins } from "./markdown-components"
import type { UserContent } from "@/lib/types"
import { getUserMessageText, getUserMessageImages } from "@/lib/parser"
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog"

const SYSTEM_TAG_RE =
  /<(?:system-reminder|local-command-caveat|command-name|teammate-message|env|claude_background_info|fast_mode_info|gitStatus)[^>]*>[\s\S]*?<\/(?:system-reminder|local-command-caveat|command-name|teammate-message|env|claude_background_info|fast_mode_info|gitStatus)>/g

function stripSystemTags(text: string): string {
  return text.replace(SYSTEM_TAG_RE, "").trim()
}

interface UserMessageProps {
  content: UserContent
  timestamp: string
  label?: string
  variant?: "user" | "agent"
}

export const UserMessage = memo(function UserMessage({ content, timestamp, label = "User", variant = "user" }: UserMessageProps) {
  const [expanded, setExpanded] = useState(false)
  const [showRaw, setShowRaw] = useState(false)
  const [modalImage, setModalImage] = useState<string | null>(null)

  const rawText = useMemo(() => getUserMessageText(content), [content])
  const cleanText = useMemo(() => stripSystemTags(rawText), [rawText])
  const images = useMemo(() => getUserMessageImages(content), [content])
  const imageUrls = useMemo(
    () => images.map((img) => `data:${img.source.media_type};base64,${img.source.data}`),
    [images]
  )
  const hasTags = rawText !== cleanText
  const displayText = showRaw ? rawText : cleanText

  const isTruncated = displayText.length > 500 && !expanded
  const visibleText = isTruncated ? displayText.slice(0, 500) + "..." : displayText

  return (
    <div className="flex gap-3 group">
      <div className="flex-shrink-0 mt-1">
        <div className={variant === "agent" ? "w-7 h-7 rounded-full bg-green-500/20 flex items-center justify-center" : "w-7 h-7 rounded-full bg-blue-500/20 flex items-center justify-center"}>
          {variant === "agent" ? <Cog className="w-4 h-4 text-green-400" /> : <User className="w-4 h-4 text-blue-400" />}
        </div>
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 mb-1">
          <span className={variant === "agent" ? "text-xs font-medium text-green-400" : "text-xs font-medium text-blue-400"}>{label}</span>
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

        {/* Image thumbnails */}
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

      {/* Full-size image modal */}
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
