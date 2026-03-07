import { memo, useMemo } from "react"
import ReactMarkdown from "react-markdown"
import { markdownComponents, markdownPlugins, preprocessImagePaths } from "./markdown-components"
import {
  Tooltip,
  TooltipTrigger,
  TooltipContent,
} from "@/components/ui/tooltip"
import type { TokenUsage } from "@/lib/types"
import { shortenModel, formatTokenCount } from "@/lib/format"

// ── Token usage tooltip ──────────────────────────────────────────────────

function TokenUsageBadge({ usage }: { usage: TokenUsage }): React.ReactElement {
  const totalInput = usage.input_tokens
    + (usage.cache_creation_input_tokens ?? 0)
    + (usage.cache_read_input_tokens ?? 0)
  const cacheRead = usage.cache_read_input_tokens ?? 0
  const cacheWrite = usage.cache_creation_input_tokens ?? 0

  return (
    <Tooltip>
      <TooltipTrigger render={<span className="text-[10px] text-muted-foreground cursor-default" />}>
          {formatTokenCount(totalInput + usage.output_tokens)} tokens
      </TooltipTrigger>
      <TooltipContent className="text-xs space-y-1">
        <div>Context: {formatTokenCount(totalInput)}</div>
        <div className="pl-2 text-muted-foreground">New: {formatTokenCount(usage.input_tokens)}</div>
        {cacheRead > 0 && (
          <div className="pl-2 text-muted-foreground">
            Cache read: {formatTokenCount(cacheRead)}
          </div>
        )}
        {cacheWrite > 0 && (
          <div className="pl-2 text-muted-foreground">
            Cache write: {formatTokenCount(cacheWrite)}
          </div>
        )}
        <div>Output: {formatTokenCount(usage.output_tokens)}</div>
      </TooltipContent>
    </Tooltip>
  )
}

// ── Main component ───────────────────────────────────────────────────────

interface AssistantTextProps {
  text: string
  model: string | null
  tokenUsage: TokenUsage | null
  timestamp?: string
}

export const AssistantText = memo(function AssistantText({
  text,
  model,
  tokenUsage,
  timestamp,
}: AssistantTextProps) {
  const markdownText = useMemo(() => preprocessImagePaths(text), [text])

  if (!text) return null

  return (
    <div className="group">
      {(model || tokenUsage || timestamp) && (
        <div className="flex items-center gap-1.5 justify-end mb-1">
          {tokenUsage && <TokenUsageBadge usage={tokenUsage} />}
          {model && (
            <span className="text-[10px] text-muted-foreground/40">
              {shortenModel(model)}
            </span>
          )}
          {model && timestamp && <span className="text-[10px] text-muted-foreground/20">·</span>}
          {timestamp && (
            <span className="text-[10px] text-muted-foreground/40">
              {new Date(timestamp).toLocaleTimeString()}
            </span>
          )}
        </div>
      )}
      <div className="text-sm break-words overflow-hidden">
        <ReactMarkdown components={markdownComponents} remarkPlugins={markdownPlugins}>{markdownText}</ReactMarkdown>
      </div>
    </div>
  )
})
