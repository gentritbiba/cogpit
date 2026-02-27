import { memo, useMemo } from "react"
import { Brain, Cog } from "lucide-react"
import { cn } from "@/lib/utils"
import { ToolCallCard } from "./ToolCallCard"
import type { SubAgentMessage } from "@/lib/types"
import ReactMarkdown from "react-markdown"
import { markdownComponents, markdownPlugins } from "./markdown-components"

interface AgentMessageItemProps {
  message: SubAgentMessage
  expandAll: boolean
  barColor: string
  thinkingIconColor?: string
}

export const AgentMessageItem = memo(function AgentMessageItem({
  message,
  expandAll,
  barColor,
  thinkingIconColor = "text-violet-400",
}: AgentMessageItemProps): React.ReactElement | null {
  const markdownText = useMemo(() => message.text.join("\n\n"), [message.text])

  return (
    <div className="flex gap-0">
      <div className={cn("w-[3px] shrink-0 rounded-full", barColor)} />
      <div className="space-y-2 pl-3 min-w-0 flex-1">
        {message.thinking.length > 0 && (
          <div className="flex gap-2 items-start">
            <Brain className={cn("w-3.5 h-3.5 mt-0.5 shrink-0", thinkingIconColor)} />
            <div className="space-y-1">
              {message.thinking.map((t, i) => (
                <pre
                  key={i}
                  className="text-[11px] text-muted-foreground font-mono whitespace-pre-wrap break-words max-h-40 overflow-y-auto"
                >
                  {t}
                </pre>
              ))}
            </div>
          </div>
        )}

        {message.text.length > 0 && (
          <div className="flex gap-2 items-start">
            <Cog className="w-3.5 h-3.5 text-green-400 mt-0.5 shrink-0" />
            <div className="max-w-none text-xs break-words">
              <ReactMarkdown components={markdownComponents} remarkPlugins={markdownPlugins}>
                {markdownText}
              </ReactMarkdown>
            </div>
          </div>
        )}

        {message.toolCalls.length > 0 && (
          <div className="space-y-1.5">
            {message.toolCalls.map((tc) => (
              <ToolCallCard key={tc.id} toolCall={tc} expandAll={expandAll} />
            ))}
          </div>
        )}
      </div>
    </div>
  )
})
