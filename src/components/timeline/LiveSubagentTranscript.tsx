import { memo, useCallback, useLayoutEffect, useRef, useState } from "react"
import { useStreamingOverlay } from "@/contexts/StreamingOverlayContext"
import { messagesForToolUse } from "@/lib/streamingOverlay"
import { StreamingMarkdown } from "./StreamingMarkdown"

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
        <StreamingMarkdown text={markdownText} compactHeadings />
      </div>
    </div>
  )
})
