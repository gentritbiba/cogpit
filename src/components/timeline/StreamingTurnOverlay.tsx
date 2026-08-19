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
      <div className="my-2 whitespace-pre-wrap break-words border-l pl-3 text-sm italic leading-relaxed text-muted-foreground">
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
    <span className="ml-0.5 inline-block h-[15px] w-[7px] rounded-[1px] bg-foreground/70 align-text-bottom" />
  )
}

export const StreamingTurnOverlay = memo(function StreamingTurnOverlay() {
  const overlay = useStreamingOverlay()
  const messages = mainThreadMessages(overlay)
  if (messages.length === 0) return null
  const messageOccurrences = new Map<string, number>()

  return (
    <div className="px-4" data-testid="streaming-turn-overlay">
      {messages.map((msg) => {
        const occurrence = messageOccurrences.get(msg.messageId) ?? 0
        messageOccurrences.set(msg.messageId, occurrence + 1)
        const lastVisibleIdx = msg.blocks.reduce(
          (acc, b, i) => (b.blockType !== "tool_use" && b.text ? i : acc),
          -1,
        )
        return (
          <div key={`${msg.messageId}:${occurrence}`}>
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
