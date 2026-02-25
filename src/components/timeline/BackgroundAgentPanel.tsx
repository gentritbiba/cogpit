import { useState, memo } from "react"
import { Users, ChevronRight, ChevronDown, Brain, Cog } from "lucide-react"
import { ToolCallCard } from "./ToolCallCard"
import type { SubAgentMessage } from "@/lib/types"
import { buildAgentLabelMap } from "./agent-utils"
import ReactMarkdown from "react-markdown"
import { markdownComponents, markdownPlugins } from "./markdown-components"

interface BackgroundAgentPanelProps {
  messages: SubAgentMessage[]
  expandAll: boolean
}

const AGENT_COLORS = [
  { badge: "bg-violet-500/15 text-violet-300 border-violet-500/30", bar: "bg-violet-400" },
  { badge: "bg-fuchsia-500/15 text-fuchsia-300 border-fuchsia-500/30", bar: "bg-fuchsia-400" },
  { badge: "bg-purple-500/15 text-purple-300 border-purple-500/30", bar: "bg-purple-400" },
  { badge: "bg-pink-500/15 text-pink-300 border-pink-500/30", bar: "bg-pink-400" },
  { badge: "bg-sky-500/15 text-sky-300 border-sky-500/30", bar: "bg-sky-400" },
]

export const BackgroundAgentPanel = memo(function BackgroundAgentPanel({ messages, expandAll }: BackgroundAgentPanelProps) {
  const [open, setOpen] = useState(false)
  const isOpen = expandAll || open

  if (messages.length === 0) return null

  const agentIds = [...new Set(messages.map((m) => m.agentId))]
  const agentColorMap = new Map(agentIds.map((id, i) => [id, AGENT_COLORS[i % AGENT_COLORS.length]]))
  const agentLabelMap = buildAgentLabelMap(messages)
  const multipleAgents = agentIds.length > 1

  return (
    <div className="rounded-md border border-dashed border-violet-500/30 bg-elevation-1 depth-low p-3">
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center gap-2 w-full text-left"
      >
        <Users className="w-4 h-4 text-violet-400 shrink-0" />
        <span className="text-xs font-medium text-violet-400">
          Background agent activity
        </span>
        {multipleAgents && (
          <span className="text-[10px] font-semibold text-violet-300 bg-violet-500/20 px-1.5 py-0.5 rounded-full">
            {agentIds.length} agents active
          </span>
        )}
        {agentIds.map((id) => {
          const color = agentColorMap.get(id)!
          return (
            <span
              key={id}
              className={`text-[10px] px-1.5 py-0 h-4 inline-flex items-center gap-1 rounded border ${color.badge}`}
            >
              <span className={`w-1.5 h-1.5 rounded-full ${color.bar}`} />
              {agentLabelMap.get(id)}
            </span>
          )
        })}
        <span className="text-[10px] text-muted-foreground">
          ({messages.length} message{messages.length > 1 ? "s" : ""})
        </span>
        <span className="ml-auto">
          {isOpen ? (
            <ChevronDown className="w-3.5 h-3.5 text-muted-foreground" />
          ) : (
            <ChevronRight className="w-3.5 h-3.5 text-muted-foreground" />
          )}
        </span>
      </button>

      {isOpen && (
        <div className="mt-3 space-y-2">
          {messages.map((msg, i) => {
            const color = agentColorMap.get(msg.agentId) ?? AGENT_COLORS[0]
            return (
              <BackgroundAgentMessageItem
                key={i}
                message={msg}
                expandAll={expandAll}
                barColor={color.bar}
              />
            )
          })}
        </div>
      )}
    </div>
  )
})

function BackgroundAgentMessageItem({
  message,
  expandAll,
  barColor,
}: {
  message: SubAgentMessage
  expandAll: boolean
  barColor: string
}) {
  return (
    <div className={`flex gap-0`}>
      {/* Colored left bar indicating which agent */}
      <div className={`w-[3px] shrink-0 rounded-full ${barColor}`} />
      <div className="space-y-2 pl-3 min-w-0 flex-1">
        {message.thinking.length > 0 && (
          <div className="flex gap-2 items-start">
            <Brain className="w-3.5 h-3.5 text-violet-400 mt-0.5 shrink-0" />
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
            <div className="prose dark:prose-invert prose-xs max-w-none text-foreground text-xs break-words">
              <ReactMarkdown components={markdownComponents} remarkPlugins={markdownPlugins}>{message.text.join("\n\n")}</ReactMarkdown>
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
}
