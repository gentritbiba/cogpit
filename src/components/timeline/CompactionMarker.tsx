import { useState, memo } from "react"
import { ChevronRight, ChevronDown, Minimize2 } from "lucide-react"
import ReactMarkdown from "react-markdown"
import { markdownComponents, markdownPlugins } from "./markdown-components"
import { Button } from "@/components/ui/button"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { formatTokenCount } from "@/lib/format"
import type { CompactionMeta } from "../../../shared/session/types"

interface Props {
  /** Summary written by the compacting model; absent when the transcript only recorded the boundary. */
  summary?: string
  meta?: CompactionMeta
}

function describe(meta?: CompactionMeta): string | null {
  if (!meta) return null
  const trigger = meta.trigger === "manual" ? "manual" : "auto"
  if (meta.postTokens != null) {
    return `${trigger} · ${formatTokenCount(meta.preTokens)} → ${formatTokenCount(meta.postTokens)}`
  }
  return `${trigger} · ${formatTokenCount(meta.preTokens)}`
}

/**
 * Divider marking where the conversation was compacted, expanding to the
 * summary the compacting model wrote.
 */
export const CompactionMarker = memo(function CompactionMarker({ summary, meta }: Props) {
  const [open, setOpen] = useState(false)
  const detail = describe(meta)
  const body = summary?.trim()

  const label = (
    <div className="flex items-center gap-1.5 text-xs text-muted-foreground transition-colors group-hover:text-foreground">
      {body && (open
        ? <ChevronDown className="size-3" data-icon="inline-start" />
        : <ChevronRight className="size-3" data-icon="inline-start" />)}
      <Minimize2 className="size-3" data-icon="inline-start" />
      <span className="font-medium">Compacted</span>
      {detail && (
        <>
          <span>&middot;</span>
          <span>{detail}</span>
        </>
      )}
    </div>
  )

  if (!body) {
    return (
      <div className="flex items-center gap-3 px-4 py-2">
        <div className="h-px flex-1 bg-border" />
        {label}
        <div className="h-px flex-1 bg-border" />
      </div>
    )
  }

  return (
    <Collapsible open={open} onOpenChange={setOpen} className="px-4 py-2">
      <CollapsibleTrigger render={<Button type="button" variant="ghost" className="group h-auto w-full gap-3 px-0" />}>
        <div className="h-px flex-1 bg-border" />
        {label}
        <div className="h-px flex-1 bg-border" />
      </CollapsibleTrigger>

      <CollapsibleContent>
        <div className="prose prose-sm dark:prose-invert mx-8 mt-2 max-w-none rounded-md border bg-muted/30 px-3 py-2">
          <ReactMarkdown remarkPlugins={markdownPlugins} components={markdownComponents}>
            {body}
          </ReactMarkdown>
        </div>
      </CollapsibleContent>
    </Collapsible>
  )
})
