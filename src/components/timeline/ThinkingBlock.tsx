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
        <p
          key={i}
          className="max-h-96 overflow-y-auto whitespace-pre-wrap break-words text-xs italic leading-5 text-muted-foreground"
        >
          {block.thinking}
        </p>
      ))}
    </div>
  )
})
