import { useState, memo } from "react"
import { Users, ChevronRight, ChevronDown, Brain, Cog } from "lucide-react"
import { ToolCallCard } from "./ToolCallCard"
import type { SubAgentMessage } from "@/lib/types"
import ReactMarkdown from "react-markdown"

interface SubAgentPanelProps {
  messages: SubAgentMessage[]
  expandAll: boolean
}

const AGENT_COLORS = [
  { badge: "bg-indigo-500/15 text-indigo-300 border-indigo-500/30", bar: "bg-indigo-400" },
  { badge: "bg-cyan-500/15 text-cyan-300 border-cyan-500/30", bar: "bg-cyan-400" },
  { badge: "bg-amber-500/15 text-amber-300 border-amber-500/30", bar: "bg-amber-400" },
  { badge: "bg-rose-500/15 text-rose-300 border-rose-500/30", bar: "bg-rose-400" },
  { badge: "bg-emerald-500/15 text-emerald-300 border-emerald-500/30", bar: "bg-emerald-400" },
]

function shortId(id: string) {
  return id.length > 8 ? id.slice(0, 8) : id
}

export const SubAgentPanel = memo(function SubAgentPanel({ messages, expandAll }: SubAgentPanelProps) {
  const [open, setOpen] = useState(false)
  const isOpen = expandAll || open

  if (messages.length === 0) return null

  const agentIds = [...new Set(messages.map((m) => m.agentId))]
  const agentColorMap = new Map(agentIds.map((id, i) => [id, AGENT_COLORS[i % AGENT_COLORS.length]]))
  const multipleAgents = agentIds.length > 1

  return (
    <div className="rounded-md border border-dashed border-indigo-500/30 bg-elevation-1 depth-low p-3">
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center gap-2 w-full text-left"
      >
        <Users className="w-4 h-4 text-indigo-400 shrink-0" />
        <span className="text-xs font-medium text-indigo-400">
          Sub-agent activity
        </span>
        {multipleAgents && (
          <span className="text-[10px] font-semibold text-indigo-300 bg-indigo-500/20 px-1.5 py-0.5 rounded-full">
            {agentIds.length} subagents active
          </span>
        )}
        {agentIds.map((id) => {
          const color = agentColorMap.get(id)!
          return (
            <span
              key={id}
              className={`text-[10px] px-1.5 py-0 h-4 inline-flex items-center gap-1 rounded border font-mono ${color.badge}`}
            >
              <span className={`w-1.5 h-1.5 rounded-full ${color.bar}`} />
              {shortId(id)}
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
              <SubAgentMessageItem
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

function SubAgentMessageItem({
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
    </div>
  )
}
