import { memo } from "react"
import { useStreamingOverlay } from "@/contexts/StreamingOverlayContext"
import { mainThreadMessages, type OverlayBlock } from "@/lib/streamingOverlay"

/**
 * Renders the in-flight (token-streamed) main-thread assistant output as a
 * continuation of the running turn. Mounted after the virtualized timeline
 * (the streaming message always belongs to the last turn) so growing text
 * never churns the virtualizer's measurements.
 *
 * Deliberately plain rendering: pre-wrapped text with a cursor, no markdown.
 * The fully formatted version appears when the complete JSONL line lands and
 * the overlay reconciles away.
 */

function StreamingBlock({ block, showCursor }: { block: OverlayBlock; showCursor: boolean }) {
  if (block.blockType === "tool_use") {
    return (
      <div className="text-xs text-muted-foreground italic py-1">
        Preparing {block.toolName ?? "tool"}…
      </div>
    )
  }

  if (block.blockType === "thinking") {
    if (!block.text) return null
    return (
      <div className="text-[13px] leading-relaxed text-muted-foreground/70 italic whitespace-pre-wrap break-words border-l-2 border-border/40 pl-3 my-2">
        {block.text}
        {showCursor && <StreamCursor />}
      </div>
    )
  }

  if (!block.text) return null
  return (
    <div className="text-sm leading-relaxed whitespace-pre-wrap break-words my-2">
      {block.text}
      {showCursor && <StreamCursor />}
    </div>
  )
}

function StreamCursor() {
  return (
    <span className="inline-block w-[7px] h-[15px] ml-0.5 align-text-bottom bg-blue-400/80 animate-pulse rounded-[1px]" />
  )
}

export const StreamingTurnOverlay = memo(function StreamingTurnOverlay() {
  const overlay = useStreamingOverlay()
  const messages = mainThreadMessages(overlay)
  if (messages.length === 0) return null

  return (
    <div className="px-4" data-testid="streaming-turn-overlay">
      {messages.map((msg) => {
        const lastVisibleIdx = msg.blocks.reduce(
          (acc, b, i) => (b.blockType !== "tool_use" && b.text ? i : acc),
          -1,
        )
        return (
          <div key={msg.messageId}>
            {msg.blocks.map((block, i) => (
              <StreamingBlock
                key={block.index}
                block={block}
                showCursor={!msg.stopped && i === lastVisibleIdx}
              />
            ))}
          </div>
        )
      })}
    </div>
  )
})
