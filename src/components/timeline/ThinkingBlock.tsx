import { memo } from "react"
import type { ThinkingBlock as ThinkingBlockType } from "../../../shared/session/types"

interface ThinkingBlockProps {
  blocks: ThinkingBlockType[]
}

export const ThinkingBlock = memo(function ThinkingBlock({ blocks }: ThinkingBlockProps) {
  if (blocks.length === 0) return null

  return (
    <div className="flex flex-col gap-2">
      {blocks.map((block, i) => (
        <pre
          key={i}
          className="text-xs text-muted-foreground/70 font-mono whitespace-pre-wrap break-words max-h-96 overflow-y-auto"
        >
          {block.thinking}
        </pre>
      ))}
    </div>
  )
})
