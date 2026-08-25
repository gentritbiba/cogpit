import { memo, useCallback, useLayoutEffect, useRef, useState } from "react"
import { useAgentProgress, useStreamingOverlay } from "@/contexts/StreamingOverlayContext"
import { messagesForToolUse } from "@/lib/streamingOverlay"
import { StreamingMarkdown } from "./StreamingMarkdown"

/**
 * Live tail of a running subagent's streamed output, rendered inside its
 * Task/Agent ToolCallCard while the tool has no result yet. The pane scrolls
 * and sticks to the newest output, so the subagent's progress is visible as it
 * happens instead of only after it finishes.
 *
 * When `agentProgressSummaries` is on, the CLI also forks the subagent every
 * ~30s for a one-line "what am I doing now". That line is shown in place of
 * the "Live" label. It is absent for the first ~30s of every run and for runs
 * that finish inside one window, so it is never given reserved space.
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
  const summary = useAgentProgress(toolUseId)
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

  // A summary can land before the subagent's first token — showing it alone is
  // better than showing nothing, so the pane only bails when it has neither.
  if (!text && !summary) return null

  return (
    <div
      className="mt-2 rounded-md border bg-muted/30 px-3 py-2"
      data-testid="live-subagent-transcript"
    >
      <div
        data-testid={summary ? "live-subagent-summary" : undefined}
        className="mb-1 text-xs font-medium text-muted-foreground"
      >
        {summary ?? <span className="uppercase tracking-wide">Live</span>}
      </div>
      {text && (
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
      )}
    </div>
  )
})
