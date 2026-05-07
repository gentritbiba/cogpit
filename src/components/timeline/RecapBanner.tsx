import { memo, useState } from "react"
import { ChevronDown, ChevronRight, History } from "lucide-react"
import ReactMarkdown from "react-markdown"
import remarkGfm from "remark-gfm"
import { markdownComponents } from "./markdown-components"
import { cn } from "@/lib/utils"

interface Props {
  content: string
  timestamp?: string
}

/**
 * Renders an away_summary / recap block produced by the /recap command or
 * automatically when Claude Code returns to a long-running session.
 *
 * Real shape (observed in JSONL, Claude Code v2.1.114+):
 *   { type: "system", subtype: "away_summary", content: "plain-text summary" }
 *
 * Content is treated as plain text but rendered through ReactMarkdown in case
 * future versions emit markdown-formatted summaries.
 */
export const RecapBanner = memo(function RecapBanner({ content }: Props) {
  const [open, setOpen] = useState(true)
  const Chev = open ? ChevronDown : ChevronRight

  return (
    <div className={cn("my-2 rounded-lg border border-blue-500/20 bg-blue-950/5")}>
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center gap-2 w-full text-left p-2 hover:bg-blue-500/5"
      >
        <Chev className="w-3.5 h-3.5 shrink-0 text-muted-foreground" />
        <History className="w-4 h-4 text-blue-400" />
        <span className="text-sm font-medium">Session recap</span>
      </button>
      {open && (
        <div className="px-3 pb-2 prose prose-sm dark:prose-invert max-w-none border-t border-blue-500/10 pt-2">
          <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
            {content}
          </ReactMarkdown>
        </div>
      )}
    </div>
  )
})
