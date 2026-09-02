import { useState, memo } from "react"
import { ChevronRight, ChevronDown } from "lucide-react"
import type { ThinkingBlock as ThinkingBlockType } from "../../../shared/session/types"
import { Button } from "@/components/ui/button"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"

interface ThinkingBlockProps {
  blocks: ThinkingBlockType[]
  expandAll: boolean
}

export const ThinkingBlock = memo(function ThinkingBlock({ blocks, expandAll }: ThinkingBlockProps) {
  const [open, setOpen] = useState(false)
  const isOpen = expandAll || open

  if (blocks.length === 0) return null

  return (
    <Collapsible
      open={isOpen}
      onOpenChange={(nextOpen) => {
        if (!expandAll) setOpen(nextOpen)
      }}
    >
      {!expandAll && (
        <CollapsibleTrigger render={<Button type="button" variant="ghost" size="xs" className="-ml-2 text-muted-foreground" />}>
          {isOpen
            ? <ChevronDown data-icon="inline-start" />
            : <ChevronRight data-icon="inline-start" />}
          <span>Thinking... ({blocks.length} block{blocks.length > 1 ? "s" : ""})</span>
        </CollapsibleTrigger>
      )}
      <CollapsibleContent className="mt-1 flex flex-col gap-2">
        {blocks.map((block, i) => (
          <pre
            key={i}
            className="text-xs text-muted-foreground/70 font-mono whitespace-pre-wrap break-words max-h-96 overflow-y-auto"
          >
            {block.thinking}
          </pre>
        ))}
      </CollapsibleContent>
    </Collapsible>
  )
})
