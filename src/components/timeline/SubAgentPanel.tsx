import { useState, memo } from "react"
import { Users, ChevronRight, ChevronDown, Brain, Cog } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { ToolCallCard } from "./ToolCallCard"
import type { SubAgentMessage } from "@/lib/types"
import ReactMarkdown from "react-markdown"

interface SubAgentPanelProps {
  messages: SubAgentMessage[]
  expandAll: boolean
}

export const SubAgentPanel = memo(function SubAgentPanel({ messages, expandAll }: SubAgentPanelProps) {
  const [open, setOpen] = useState(false)
  const isOpen = expandAll || open

  if (messages.length === 0) return null

  const agentIds = [...new Set(messages.map((m) => m.agentId))]

  return (
    <div className="rounded-md border border-dashed border-indigo-500/30 bg-indigo-950/10 p-3">
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center gap-2 w-full text-left"
      >
        <Users className="w-4 h-4 text-indigo-400" />
        <span className="text-xs font-medium text-indigo-400">
          Sub-agent activity
        </span>
        {agentIds.map((id) => (
          <Badge
            key={id}
            variant="outline"
            className="text-[10px] px-1.5 py-0 h-4 border-indigo-500/30 text-indigo-400"
          >
            {id.length > 12 ? id.slice(0, 12) + "..." : id}
          </Badge>
        ))}
        <span className="text-[10px] text-zinc-500">
          ({messages.length} message{messages.length > 1 ? "s" : ""})
        </span>
        <span className="ml-auto">
          {isOpen ? (
            <ChevronDown className="w-3.5 h-3.5 text-zinc-500" />
          ) : (
            <ChevronRight className="w-3.5 h-3.5 text-zinc-500" />
          )}
        </span>
      </button>

      {isOpen && (
        <div className="mt-3 space-y-3 pl-3 border-l border-indigo-500/20">
          {messages.map((msg, i) => (
            <SubAgentMessageItem key={i} message={msg} expandAll={expandAll} />
          ))}
        </div>
      )}
    </div>
  )
})

function SubAgentMessageItem({
  message,
  expandAll,
}: {
  message: SubAgentMessage
  expandAll: boolean
}) {
  return (
    <div className="space-y-2">
      {message.thinking.length > 0 && (
        <div className="flex gap-2 items-start">
          <Brain className="w-3.5 h-3.5 text-violet-400 mt-0.5 shrink-0" />
          <div className="space-y-1">
            {message.thinking.map((t, i) => (
              <pre
                key={i}
                className="text-[11px] text-zinc-500 font-mono whitespace-pre-wrap break-words max-h-40 overflow-y-auto"
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
          <div className="prose prose-invert prose-xs max-w-none text-zinc-300 text-xs break-words">
            <ReactMarkdown>{message.text.join("\n\n")}</ReactMarkdown>
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
  )
}
