import { memo, useMemo, useRef } from "react"
import { Check, Copy, MessageSquareQuote } from "lucide-react"
import ReactMarkdown from "react-markdown"
import { Button } from "@/components/ui/button"
import { markdownComponents, markdownPlugins, preprocessMediaPaths } from "./markdown-components"
import { CogpitBlockScope } from "./cogpit-blocks/kinds"
import { shortenModel } from "@/lib/format"
import { useCopyWithFeedback } from "@/hooks/useCopyWithFeedback"
import { cn } from "@/lib/utils"

// ── Main component ───────────────────────────────────────────────────────

interface AssistantTextProps {
  text: string
  model: string | null
  /** Reasoning effort the turn ran at, when the transcript recorded one. */
  effort?: string
  timestamp?: string
  messageKey?: string
  compact?: boolean
  /** Quote the reply, or the part of it selected, into the composer. */
  onQuote?: (text: string) => void
  /**
   * The turn's answer, which carries the model and time under it. Text the
   * agent wrote between its steps only offers copy and quote, on hover.
   */
  showMeta?: boolean
}

/** The text selected inside `root`, or null when the selection is elsewhere or empty. */
function selectionWithin(root: HTMLElement | null): string | null {
  const selection = window.getSelection()
  if (!root || !selection || selection.isCollapsed || selection.rangeCount === 0) return null
  const range = selection.getRangeAt(0)
  if (!root.contains(range.commonAncestorContainer)) return null
  const text = selection.toString().trim()
  return text || null
}

export const AssistantText = memo(function AssistantText({
  text,
  model,
  effort,
  timestamp,
  messageKey,
  compact = false,
  onQuote,
  showMeta = false,
}: AssistantTextProps) {
  const contentRef = useRef<HTMLDivElement>(null)
  const markdownText = useMemo(() => preprocessMediaPaths(text), [text])
  const blockScope = useMemo(() => ({ messageKey: messageKey ?? timestamp ?? `${text.length}:${text.slice(0, 64)}`, markdown: markdownText }), [messageKey, timestamp, text, markdownText])
  const [copied, copy] = useCopyWithFeedback()

  if (!text) return null

  const actions = !compact && (
    <>
      <Button
        variant="ghost"
        size="icon-sm"
        className="text-muted-foreground hover:text-foreground"
        onClick={() => copy(text)}
        aria-label={copied ? "Response copied" : "Copy response"}
        title={copied ? "Copied" : "Copy response"}
      >
        {copied ? <Check data-icon="inline-start" /> : <Copy data-icon="inline-start" />}
      </Button>
      {onQuote && (
        <Button
          variant="ghost"
          size="icon-sm"
          className="text-muted-foreground hover:text-foreground"
          onClick={() => onQuote(selectionWithin(contentRef.current) ?? text)}
          aria-label="Quote in reply (the selected part, or the whole response)"
          title="Quote in reply"
        >
          <MessageSquareQuote data-icon="inline-start" />
        </Button>
      )}
    </>
  )
  // `<synthetic>` marks a message the CLI wrote itself, such as an error; it is not a model.
  const meta = [model && !model.startsWith("<") && shortenModel(model), effort, timestamp && new Date(timestamp).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })].filter(Boolean)

  return (
    <div className="group/text relative min-w-0">
      <div ref={contentRef} className={cn("overflow-hidden break-words text-sm", compact && "leading-relaxed")}>
        <CogpitBlockScope.Provider value={blockScope}>
          <ReactMarkdown components={markdownComponents} remarkPlugins={markdownPlugins}>{markdownText}</ReactMarkdown>
        </CogpitBlockScope.Provider>
      </div>
      {actions && (showMeta ? (
        <div data-reply-meta className="mt-1 flex min-h-7 items-center gap-1 text-xs text-muted-foreground">
          {meta.length > 0 && (
            <span className="pr-1 tabular-nums" title={effort ? `Reasoning effort: ${effort}` : undefined}>{meta.join(" · ")}</span>
          )}
          <span className="flex items-center gap-0.5 transition-opacity sm:opacity-0 sm:group-hover/text:opacity-100 sm:focus-within:opacity-100">{actions}</span>
        </div>
      ) : (
        <div className="absolute -top-1 right-0 flex items-center rounded-md bg-background/90 opacity-0 shadow-sm ring-1 ring-border/60 backdrop-blur transition-opacity focus-within:opacity-100 group-hover/text:opacity-100">
          {actions}
        </div>
      ))}
    </div>
  )
})
