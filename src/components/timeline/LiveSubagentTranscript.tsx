import { memo, useCallback, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react"
import ReactMarkdown, { type Components } from "react-markdown"
import { useStreamingOverlay } from "@/contexts/StreamingOverlayContext"
import { messagesForToolUse } from "@/lib/streamingOverlay"
import { markdownComponents, markdownPlugins } from "./markdown-components"

/**
 * Live tail of a running subagent's streamed output, rendered inside its
 * Task/Agent ToolCallCard while the tool has no result yet. The pane scrolls
 * and sticks to the newest output, so the subagent's progress is visible as it
 * happens instead of only after it finishes.
 */

/** Caps the DOM: the pane re-renders on every overlay flush (~13 Hz). */
const MAX_TAIL_LINES = 400

/** Distance from the bottom, in px, still counted as "following". */
const FOLLOW_THRESHOLD_PX = 24

function compactHeading(Tag: "h1" | "h2" | "h3" | "h4" | "h5" | "h6") {
  return function CompactHeading({ children }: { children?: ReactNode }) {
    return <Tag className="mt-2 mb-1 text-xs font-semibold text-foreground first:mt-0">{children}</Tag>
  }
}

/**
 * The shared markdown renderer, minus the parts that misbehave on half-written
 * input: Shiki re-tokenizes a language-tagged fence on every flush (and flashes
 * unhighlighted in between) while the fence is still unterminated, and an image
 * whose path is mid-stream resolves to a 404. Headings are flattened to one
 * compact size — the document-scale defaults overwhelm a 256px pane.
 */
const liveMarkdownComponents: Components = {
  ...markdownComponents,
  h1: compactHeading("h1"),
  h2: compactHeading("h2"),
  h3: compactHeading("h3"),
  h4: compactHeading("h4"),
  h5: compactHeading("h5"),
  h6: compactHeading("h6"),
  code({ className, children }) {
    const isInline = !className && typeof children === "string" && !children.includes("\n")
    if (isInline) {
      return (
        <code className="text-[0.9em] font-mono px-1 py-0.5 rounded bg-elevation-2 text-orange-600 dark:text-orange-300">
          {children}
        </code>
      )
    }
    return (
      <pre className="my-1.5 overflow-x-auto rounded border border-border/40 bg-elevation-1 p-2 text-[11px] leading-[1.5] font-mono">
        <code>{String(children).replace(/\n$/, "")}</code>
      </pre>
    )
  },
  img: () => null,
}

export const LiveSubagentTranscript = memo(function LiveSubagentTranscript({
  toolUseId,
}: {
  toolUseId: string
}) {
  const overlay = useStreamingOverlay()
  const scrollRef = useRef<HTMLDivElement>(null)
  const [following, setFollowing] = useState(true)

  // Join all visible block text in arrival order, keep the tail.
  const text = messagesForToolUse(overlay, toolUseId)
    .flatMap((m) => m.blocks)
    .filter((b) => b.blockType !== "tool_use" && b.text)
    .map((b) => b.text)
    .join("\n")

  // Dropping lines off the top while the reader has scrolled up would slide the
  // text out from under them, so the cap only applies when we're following the
  // tail anyway — where trimming is invisible because we re-pin to the bottom.
  const lines = text.split("\n")
  const isTrimmed = following && lines.length > MAX_TAIL_LINES
  const markdownText = isTrimmed ? lines.slice(-MAX_TAIL_LINES).join("\n") : text

  // Keyed on the text so an unrelated lane's flush re-renders without paying
  // for a full remark parse.
  const rendered = useMemo(
    () => (
      <ReactMarkdown components={liveMarkdownComponents} remarkPlugins={markdownPlugins}>
        {markdownText}
      </ReactMarkdown>
    ),
    [markdownText],
  )

  const handleScroll = useCallback(() => {
    const el = scrollRef.current
    if (!el) return
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < FOLLOW_THRESHOLD_PX
    // Same-value updates bail out, so this stays free at streaming rates.
    setFollowing((prev) => (prev === atBottom ? prev : atBottom))
  }, [])

  useLayoutEffect(() => {
    const el = scrollRef.current
    if (!el || !following) return
    const bottom = el.scrollHeight - el.clientHeight
    if (el.scrollTop !== bottom) el.scrollTop = bottom
  }, [markdownText, following])

  if (!text) return null

  return (
    <div
      className="mt-2 rounded-md border border-border/40 bg-elevation-2/50 px-3 py-2"
      data-testid="live-subagent-transcript"
    >
      <div className="flex items-center gap-1.5 mb-1">
        <span className="size-1.5 rounded-full bg-emerald-400 animate-pulse" />
        <span className="text-[10px] uppercase tracking-wide text-muted-foreground">live</span>
      </div>
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        data-testid="live-subagent-scroll"
        role="region"
        aria-label="Live sub-agent output"
        tabIndex={0}
        className="text-xs break-words max-h-64 overflow-y-auto overscroll-contain pr-1"
      >
        {isTrimmed && <div className="text-muted-foreground/50">…</div>}
        {rendered}
      </div>
    </div>
  )
})
