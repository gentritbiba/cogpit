import { memo, useState } from "react"
import { ChevronDown, ChevronRight, History } from "lucide-react"
import ReactMarkdown from "react-markdown"
import { markdownComponents, markdownPlugins } from "./markdown-components"
import { Button } from "@/components/ui/button"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"

interface Props {
  content: string
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
    <Collapsible open={open} onOpenChange={setOpen} className="my-2 rounded-lg border bg-card">
      <CollapsibleTrigger render={<Button type="button" variant="ghost" className="h-auto w-full justify-start rounded-b-none p-2 text-left" />}>
        <Chev className="size-3.5 shrink-0 text-muted-foreground" data-icon="inline-start" />
        <History className="size-4 text-muted-foreground" data-icon="inline-start" />
        <span className="text-sm font-medium">Session recap</span>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="prose prose-sm dark:prose-invert max-w-none border-t px-3 pb-2 pt-2">
          <ReactMarkdown remarkPlugins={markdownPlugins} components={markdownComponents}>
            {content}
          </ReactMarkdown>
        </div>
      </CollapsibleContent>
    </Collapsible>
  )
})
