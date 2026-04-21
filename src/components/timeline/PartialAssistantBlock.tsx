import { memo } from "react"
import { AssistantText } from "./AssistantText"
import type { PartialRenderTurn } from "@/lib/partialMessages"

interface PartialAssistantBlockProps {
  partial: PartialRenderTurn
}

/**
 * Renders an in-flight (partial) assistant message at the end of the timeline.
 * Lives *below* the last canonical `TurnSection` until the canonical assistant
 * message arrives via JSONL — at which point `useLiveSession` drops the
 * partial from state (see `dropByMessageIds`) and this component unmounts,
 * with the canonical `TurnSection` taking its place.
 *
 * Reuses `AssistantText` so partial text renders identically to canonical
 * text (same markdown, same styling, same typography). Thinking partials
 * render as a lightweight preformatted block — the canonical grouped
 * "Thinking..." collapsible is overkill during streaming and would constantly
 * remount as new deltas arrive.
 */
export const PartialAssistantBlock = memo(function PartialAssistantBlock({
  partial,
}: PartialAssistantBlockProps) {
  if (partial.textBlocks.length === 0 && partial.thinkingBlocks.length === 0) {
    return null
  }

  return (
    <div
      className="group relative py-5 px-4 space-y-3"
      data-partial-message-id={partial.messageId}
    >
      {partial.thinkingBlocks.length > 0 && (
        <div className="border-l-2 border-border/40 pl-3 ml-1 space-y-2">
          {partial.thinkingBlocks.map((text, i) => (
            <pre
              key={`thinking-${i}`}
              className="text-xs text-muted-foreground/70 font-mono whitespace-pre-wrap break-words"
            >
              {text}
            </pre>
          ))}
        </div>
      )}
      {partial.textBlocks.map((text, i) => (
        <div key={`text-${i}`}>
          <AssistantText
            text={text}
            model={null}
            tokenUsage={null}
          />
        </div>
      ))}
    </div>
  )
})
