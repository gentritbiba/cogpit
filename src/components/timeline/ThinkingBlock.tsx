import { useState, memo } from "react"
import { ChevronRight, ChevronDown } from "lucide-react"
import type { ThinkingBlock as ThinkingBlockType } from "@/lib/types"

interface ThinkingBlockProps {
  blocks: ThinkingBlockType[]
  expandAll: boolean
}

export const ThinkingBlock = memo(function ThinkingBlock({ blocks, expandAll }: ThinkingBlockProps) {
  const [open, setOpen] = useState(false)
  const isOpen = expandAll || open

  if (blocks.length === 0) return null

  return (
    <div className="group">
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center gap-1.5 text-xs font-medium text-violet-400 hover:text-violet-300 transition-colors"
      >
        {isOpen ? (
          <ChevronDown className="w-3.5 h-3.5" />
        ) : (
          <ChevronRight className="w-3.5 h-3.5" />
        )}
        Thinking...
        <span className="text-zinc-500 font-normal">
          ({blocks.length} block{blocks.length > 1 ? "s" : ""})
        </span>
      </button>
      {isOpen && (
        <div className="mt-2 space-y-2">
          {blocks.map((block) => (
            <pre
              key={block.signature}
              className="text-xs text-zinc-400 font-mono whitespace-pre-wrap break-words bg-zinc-900/50 rounded-md p-3 border border-zinc-800 max-h-96 overflow-y-auto"
            >
              {block.thinking}
            </pre>
          ))}
        </div>
      )}
    </div>
  )
})
