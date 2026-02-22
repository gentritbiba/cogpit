import { memo } from "react"
import { Cog } from "lucide-react"
import ReactMarkdown from "react-markdown"
import { Badge } from "@/components/ui/badge"
import {
  Tooltip,
  TooltipTrigger,
  TooltipContent,
} from "@/components/ui/tooltip"
import type { TokenUsage } from "@/lib/types"
import { shortenModel, formatTokenCount } from "@/lib/format"

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
  if (!text) return null

  return (
    <div className="flex gap-3 group">
      <div className="flex-shrink-0 mt-1">
        <div className="w-7 h-7 rounded-full bg-green-500/20 flex items-center justify-center">
          <Cog className="w-4 h-4 text-green-400" />
        </div>
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 mb-1">
          <span className="text-xs font-medium text-green-400">Agent</span>
          {model && (
            <Badge
              variant="outline"
              className="text-[10px] px-1.5 py-0 h-4 border-border/50 text-muted-foreground"
            >
              {shortenModel(model)}
            </Badge>
          )}
          {tokenUsage && (() => {
            const totalInput = tokenUsage.input_tokens
              + (tokenUsage.cache_creation_input_tokens ?? 0)
              + (tokenUsage.cache_read_input_tokens ?? 0)
            return (
              <Tooltip>
                <TooltipTrigger asChild>
                  <span className="text-[10px] text-muted-foreground cursor-default">
                    {formatTokenCount(totalInput + tokenUsage.output_tokens)} tokens
                  </span>
                </TooltipTrigger>
                <TooltipContent className="text-xs space-y-1">
                  <div>Context: {formatTokenCount(totalInput)}</div>
                  <div className="pl-2 text-muted-foreground">New: {formatTokenCount(tokenUsage.input_tokens)}</div>
                  {(tokenUsage.cache_read_input_tokens ?? 0) > 0 && (
                    <div className="pl-2 text-muted-foreground">
                      Cache read: {formatTokenCount(tokenUsage.cache_read_input_tokens ?? 0)}
                    </div>
                  )}
                  {(tokenUsage.cache_creation_input_tokens ?? 0) > 0 && (
                    <div className="pl-2 text-muted-foreground">
                      Cache write: {formatTokenCount(tokenUsage.cache_creation_input_tokens ?? 0)}
                    </div>
                  )}
                  <div>Output: {formatTokenCount(tokenUsage.output_tokens)}</div>
                </TooltipContent>
              </Tooltip>
            )
          })()}
          {timestamp && (
            <span className="text-[10px] text-muted-foreground ml-auto">
              {new Date(timestamp).toLocaleTimeString()}
            </span>
          )}
        </div>
        <div className="prose dark:prose-invert prose-sm max-w-none text-foreground break-words overflow-hidden [&_pre]:bg-elevation-1 [&_pre]:rounded [&_pre]:p-2 [&_pre]:overflow-x-auto [&_code]:text-foreground [&_code]:bg-elevation-1 [&_code]:px-1 [&_code]:rounded [&_a]:text-blue-400 [&_h1]:text-base [&_h2]:text-sm [&_h3]:text-sm">
          <ReactMarkdown>{text}</ReactMarkdown>
        </div>
      </div>
    </div>
  )
})
