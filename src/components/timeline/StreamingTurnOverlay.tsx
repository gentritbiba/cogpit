import { memo } from "react"
import { useStreamingOverlay } from "@/contexts/StreamingOverlayContext"
import { mainThreadMessages, type OverlayBlock } from "@/lib/streamingOverlay"
import { StreamingMarkdown } from "./StreamingMarkdown"

/**
 * Renders the in-flight (token-streamed) main-thread assistant output as a
 * continuation of the running turn. Mounted after the virtualized timeline
 * (the streaming message always belongs to the last turn) so growing text
 * never churns the virtualizer's measurements.
 *
 * Live text uses a streaming-safe Markdown renderer so formatting appears as
 * soon as syntax arrives. Expensive code highlighting and image loading wait
 * for the complete JSONL message and the normal timeline renderer.
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
      <div className="text-[13px] leading-relaxed text-muted-foreground/70 italic whitespace-pre-wrap break-words border-l border-border/40 pl-3 my-2">
        {block.text}
        {showCursor && <StreamCursor />}
      </div>
    )
  }

  if (!block.text) return null
  return (
    <div className="text-sm leading-relaxed break-words my-2">
      <StreamingMarkdown text={block.text} />
      {showCursor && <StreamCursor />}
    </div>
  )
}

function StreamCursor() {
  return (
    <span className="inline-block w-[7px] h-[15px] ml-0.5 align-text-bottom bg-blue-400/80 rounded-[1px]" />
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
