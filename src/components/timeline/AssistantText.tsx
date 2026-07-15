import { memo, useMemo } from "react"
import { Check, Copy } from "lucide-react"
import ReactMarkdown from "react-markdown"
import { Button } from "@/components/ui/button"
import { markdownComponents, markdownPlugins, preprocessImagePaths } from "./markdown-components"
import {
  Tooltip,
  TooltipTrigger,
  TooltipContent,
} from "@/components/ui/tooltip"
import type { TokenUsage } from "@/lib/types"
import { shortenModel, formatTokenCount } from "@/lib/format"
import { useCopyWithFeedback } from "@/hooks/useCopyWithFeedback"

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
  const [copied, copy] = useCopyWithFeedback()

  if (!text) return null

  return (
    <div className="group">
      <div className="mb-1 flex min-h-6 items-center justify-end gap-1.5">
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
        <Button
          variant="ghost"
          size="icon-sm"
          className="opacity-60 transition-opacity hover:opacity-100 focus-visible:opacity-100 sm:opacity-0 sm:group-hover:opacity-100"
          onClick={() => copy(text)}
          aria-label={copied ? "Response copied" : "Copy response"}
          title={copied ? "Copied" : "Copy response"}
        >
          {copied ? <Check data-icon="inline-start" /> : <Copy data-icon="inline-start" />}
        </Button>
      </div>
      <div className="text-sm break-words overflow-hidden">
        <ReactMarkdown components={markdownComponents} remarkPlugins={markdownPlugins}>{markdownText}</ReactMarkdown>
      </div>
    </div>
  )
})
