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
  {
    badge: "bg-indigo-500/15 text-indigo-300 border-indigo-500/30",
    label: "text-indigo-400",
    border: "border-indigo-500/20",
    dot: "bg-indigo-400",
    thinking: "text-violet-400",
    cog: "text-green-400",
  },
  {
    badge: "bg-cyan-500/15 text-cyan-300 border-cyan-500/30",
    label: "text-cyan-400",
    border: "border-cyan-500/20",
    dot: "bg-cyan-400",
    thinking: "text-sky-400",
    cog: "text-teal-400",
  },
  {
    badge: "bg-amber-500/15 text-amber-300 border-amber-500/30",
    label: "text-amber-400",
    border: "border-amber-500/20",
    dot: "bg-amber-400",
    thinking: "text-yellow-400",
    cog: "text-orange-400",
  },
  {
    badge: "bg-rose-500/15 text-rose-300 border-rose-500/30",
    label: "text-rose-400",
    border: "border-rose-500/20",
    dot: "bg-rose-400",
    thinking: "text-pink-400",
    cog: "text-red-400",
  },
  {
    badge: "bg-emerald-500/15 text-emerald-300 border-emerald-500/30",
    label: "text-emerald-400",
    border: "border-emerald-500/20",
    dot: "bg-emerald-400",
    thinking: "text-green-400",
    cog: "text-lime-400",
  },
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
    <div className="rounded-md border border-dashed border-indigo-500/30 bg-indigo-950/10 p-3">
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
              className={`text-[10px] px-1.5 py-0 h-4 inline-flex items-center rounded border font-mono ${color.badge}`}
            >
              {shortId(id)}
            </span>
          )
        })}
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
          {messages.map((msg, i) => {
            const color = agentColorMap.get(msg.agentId) ?? AGENT_COLORS[0]
            return (
              <SubAgentMessageItem
                key={i}
                message={msg}
                expandAll={expandAll}
                color={color}
                showAgentLabel
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
  color,
  showAgentLabel,
}: {
  message: SubAgentMessage
  expandAll: boolean
  color: typeof AGENT_COLORS[0]
  showAgentLabel: boolean
}) {
  const hasContent = message.thinking.length > 0 || message.text.length > 0 || message.toolCalls.length > 0

  return (
    <div className="space-y-2">
      {showAgentLabel && hasContent && (
        <div className="flex items-center gap-1.5">
          <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${color.dot}`} />
          <span className={`text-[10px] font-mono font-semibold ${color.label}`}>
            {shortId(message.agentId)}
          </span>
        </div>
      )}

      {message.thinking.length > 0 && (
        <div className="flex gap-2 items-start pl-3">
          <Brain className={`w-3.5 h-3.5 mt-0.5 shrink-0 ${color.thinking}`} />
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
        <div className="flex gap-2 items-start pl-3">
          <Cog className={`w-3.5 h-3.5 mt-0.5 shrink-0 ${color.cog}`} />
          <div className="prose prose-invert prose-xs max-w-none text-zinc-300 text-xs break-words">
            <ReactMarkdown>{message.text.join("\n\n")}</ReactMarkdown>
          </div>
        </div>
      )}

      {message.toolCalls.length > 0 && (
        <div className="space-y-1.5 pl-3">
          {message.toolCalls.map((tc) => (
            <ToolCallCard key={tc.id} toolCall={tc} expandAll={expandAll} />
          ))}
        </div>
      )}
    </div>
  )
}
