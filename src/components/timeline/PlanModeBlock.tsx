import { memo, useState } from "react"
import { ChevronRight, ChevronDown, NotebookPen, CheckCircle, Clock, XCircle } from "lucide-react"
import ReactMarkdown from "react-markdown"
import remarkGfm from "remark-gfm"
import type { ToolCall } from "@/lib/types"
import { ToolCallCard } from "./ToolCallCard"
import { markdownComponents } from "./markdown-components"
import { cn } from "@/lib/utils"

interface Props {
  plan: string
  planFilePath?: string
  status: "pending" | "approved" | "rejected"
  toolCalls: ToolCall[]
}

export const PlanModeBlock = memo(function PlanModeBlock({ plan, planFilePath, status, toolCalls }: Props) {
  const [open, setOpen] = useState(true)
  const [callsOpen, setCallsOpen] = useState(false)

  const Icon = status === "approved" ? CheckCircle : status === "rejected" ? XCircle : Clock
  const Chev = open ? ChevronDown : ChevronRight
  const CallsChev = callsOpen ? ChevronDown : ChevronRight

  return (
    <div
      className={cn(
        "my-2 rounded-lg border",
        status === "approved"
          ? "border-purple-500/20 bg-purple-950/5"
          : status === "rejected"
            ? "border-red-500/20 bg-red-950/5"
            : "border-amber-500/20 bg-amber-950/5",
      )}
    >
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center gap-2 w-full text-left p-2"
      >
        <Chev className="w-3.5 h-3.5 shrink-0 text-muted-foreground" />
        <NotebookPen className="w-4 h-4 text-purple-400" />
        <span className="text-sm font-medium">Plan Mode</span>
        <Icon
          className={cn(
            "w-4 h-4",
            status === "approved"
              ? "text-green-500/60"
              : status === "rejected"
                ? "text-red-400"
                : "text-amber-400",
          )}
        />
        <span className="text-xs text-muted-foreground capitalize">{status}</span>
        {planFilePath && (
          <span className="text-[10px] text-muted-foreground/50 font-mono ml-auto truncate">
            {planFilePath}
          </span>
        )}
      </button>

      {open && (
        <div className="px-3 pb-2">
          <div className="prose prose-sm dark:prose-invert max-w-none border-t border-purple-500/10 pt-2">
            <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
              {plan}
            </ReactMarkdown>
          </div>

          {toolCalls.length > 0 && (
            <div className="mt-2">
              <button
                onClick={() => setCallsOpen(!callsOpen)}
                className="text-[11px] text-muted-foreground hover:text-foreground flex items-center gap-1"
              >
                <CallsChev className="w-3 h-3" />
                {toolCalls.length} call{toolCalls.length === 1 ? "" : "s"} during planning
              </button>
              {callsOpen && (
                <div className="mt-1 ml-4 space-y-1">
                  {toolCalls.map((tc) => (
                    <ToolCallCard key={tc.id} toolCall={tc} expandAll={false} />
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  )
})
