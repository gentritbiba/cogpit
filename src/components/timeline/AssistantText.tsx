import { memo } from "react"
import { Cog } from "lucide-react"
import ReactMarkdown from "react-markdown"
import { markdownComponents, markdownPlugins } from "./markdown-components"
import { Badge } from "@/components/ui/badge"
import {
  Tooltip,
  TooltipTrigger,
  TooltipContent,
} from "@/components/ui/tooltip"
import type { TokenUsage } from "@/lib/types"
import { shortenModel, formatTokenCount } from "@/lib/format"

// ── Variant styles ───────────────────────────────────────────────────────

const VARIANT_STYLES = {
  agent: {
    avatar: "w-7 h-7 rounded-full bg-green-500/20 flex items-center justify-center",
    icon: "w-4 h-4 text-green-400",
    label: "text-xs font-medium text-green-400",
  },
  subagent: {
    avatar: "w-7 h-7 rounded-full bg-indigo-500/20 flex items-center justify-center",
    icon: "w-4 h-4 text-indigo-400",
    label: "text-xs font-medium text-indigo-400",
  },
} as const

// ── Token usage tooltip ──────────────────────────────────────────────────

function TokenUsageBadge({ usage }: { usage: TokenUsage }): React.ReactElement {
  const totalInput = usage.input_tokens
    + (usage.cache_creation_input_tokens ?? 0)
    + (usage.cache_read_input_tokens ?? 0)
  const cacheRead = usage.cache_read_input_tokens ?? 0
  const cacheWrite = usage.cache_creation_input_tokens ?? 0

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="text-[10px] text-muted-foreground cursor-default">
          {formatTokenCount(totalInput + usage.output_tokens)} tokens
        </span>
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
  label?: string
  variant?: "agent" | "subagent"
}

export const AssistantText = memo(function AssistantText({
  text,
  model,
  tokenUsage,
  timestamp,
  label = "Agent",
  variant = "agent",
}: AssistantTextProps) {
  if (!text) return null

  const styles = VARIANT_STYLES[variant]

  return (
    <div className="flex gap-3 group">
      <div className="flex-shrink-0 mt-1">
        <div className={styles.avatar}>
          <Cog className={styles.icon} />
        </div>
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 mb-1">
          <span className={styles.label}>{label}</span>
          {model && (
            <Badge
              variant="outline"
              className="text-[10px] px-1.5 py-0 h-4 border-border/50 text-muted-foreground"
            >
              {shortenModel(model)}
            </Badge>
          )}
          {tokenUsage && <TokenUsageBadge usage={tokenUsage} />}
          {timestamp && (
            <span className="text-[10px] text-muted-foreground ml-auto">
              {new Date(timestamp).toLocaleTimeString()}
            </span>
          )}
        </div>
        <div className="max-w-none text-sm break-words overflow-hidden">
          <ReactMarkdown components={markdownComponents} remarkPlugins={markdownPlugins}>{text}</ReactMarkdown>
        </div>
      </div>
    </div>
  )
})
