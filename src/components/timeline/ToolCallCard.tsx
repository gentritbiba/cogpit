import { useState, memo } from "react"
import {
  CheckCircle,
  XCircle,
  ChevronRight,
  ChevronDown,
  Loader2,
} from "lucide-react"
import { Badge } from "@/components/ui/badge"
import type { ToolCall } from "@/lib/types"
import { cn } from "@/lib/utils"
import { EditDiffView } from "./EditDiffView"

const TOOL_BADGE_STYLES: Record<string, string> = {
  Read: "bg-blue-500/20 text-blue-400 border-blue-500/30",
  Write: "bg-green-500/20 text-green-400 border-green-500/30",
  Edit: "bg-amber-500/20 text-amber-400 border-amber-500/30",
  Bash: "bg-red-500/20 text-red-400 border-red-500/30",
  Grep: "bg-purple-500/20 text-purple-400 border-purple-500/30",
  Glob: "bg-cyan-500/20 text-cyan-400 border-cyan-500/30",
  Task: "bg-indigo-500/20 text-indigo-400 border-indigo-500/30",
  WebFetch: "bg-orange-500/20 text-orange-400 border-orange-500/30",
  WebSearch: "bg-orange-500/20 text-orange-400 border-orange-500/30",
  EnterPlanMode: "bg-purple-500/20 text-purple-400 border-purple-500/30",
  ExitPlanMode: "bg-purple-500/20 text-purple-400 border-purple-500/30",
  AskUserQuestion: "bg-pink-500/20 text-pink-400 border-pink-500/30",
}

const DEFAULT_BADGE_STYLE = "bg-zinc-500/20 text-zinc-400 border-zinc-500/30"

export function getToolBadgeStyle(name: string): string {
  return TOOL_BADGE_STYLES[name] ?? DEFAULT_BADGE_STYLE
}

function getToolSummary(tc: ToolCall): string {
  const input = tc.input
  switch (tc.name) {
    case "Read":
      return String(input.file_path ?? input.path ?? "")
    case "Write":
      return String(input.file_path ?? input.path ?? "")
    case "Edit":
      return String(input.file_path ?? input.path ?? "")
    case "Bash":
      return String(input.command ?? "")
    case "Grep":
      return String(input.pattern ?? "")
    case "Glob":
      return String(input.pattern ?? "")
    case "Task":
      return String(input.description ?? input.prompt ?? "")
    case "WebFetch":
      return String(input.url ?? "")
    case "WebSearch":
      return String(input.query ?? "")
    case "NotebookEdit":
      return String(input.notebook_path ?? "")
    case "EnterPlanMode":
      return "Entered plan mode"
    case "ExitPlanMode":
      return "Waiting for plan approval"
    case "AskUserQuestion": {
      const questions = input.questions as Array<{ question?: string }> | undefined
      return questions?.[0]?.question ?? ""
    }
    default: {
      const keys = Object.keys(input)
      if (keys.length === 0) return ""
      const first = input[keys[0]]
      return typeof first === "string"
        ? first.length > 80
          ? first.slice(0, 80) + "..."
          : first
        : ""
    }
  }
}

interface ToolCallCardProps {
  toolCall: ToolCall
  expandAll: boolean
  isAgentActive?: boolean
}

export const ToolCallCard = memo(function ToolCallCard({ toolCall, expandAll, isAgentActive }: ToolCallCardProps) {
  const [inputOpen, setInputOpen] = useState(false)
  const [resultOpen, setResultOpen] = useState(false)
  const [resultExpanded, setResultExpanded] = useState(false)
  const [diffOpen, setDiffOpen] = useState(false)

  const showInput = expandAll || inputOpen
  const showResult = expandAll || resultOpen
  const showDiff = expandAll || diffOpen

  const summary = getToolSummary(toolCall)
  const resultText = toolCall.result ?? ""
  const isLongResult = resultText.length > 1000
  const visibleResult =
    isLongResult && !resultExpanded ? resultText.slice(0, 500) + "..." : resultText

  // Check if this is an Edit tool with diff-able content
  const isEdit = toolCall.name === "Edit"
  const hasEditDiff =
    isEdit &&
    typeof toolCall.input.old_string === "string" &&
    typeof toolCall.input.new_string === "string" &&
    typeof toolCall.input.file_path === "string"

  return (
    <div
      className={cn(
        "rounded-md border bg-zinc-900/50 p-2.5",
        toolCall.isError
          ? "border-red-500/30 bg-red-950/20"
          : "border-zinc-800"
      )}
    >
      <div className="flex items-start gap-2">
        <div className="flex items-center gap-2 flex-1 min-w-0">
          <Badge
            variant="outline"
            className={cn(
              "text-[11px] px-1.5 py-0 h-5 font-mono shrink-0",
              getToolBadgeStyle(toolCall.name)
            )}
          >
            {toolCall.name}
          </Badge>
          {summary && (
            <span className="text-xs text-zinc-400 truncate font-mono">
              {summary}
            </span>
          )}
        </div>
        <div className="flex items-center gap-1.5 flex-shrink-0">
          {toolCall.timestamp && (
            <span className="text-[10px] text-zinc-500 font-mono tabular-nums">
              {new Date(toolCall.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}
            </span>
          )}
          {toolCall.isError ? (
            <XCircle className="w-4 h-4 text-red-400" />
          ) : toolCall.result !== null ? (
            <CheckCircle className="w-4 h-4 text-green-500/60" />
          ) : isAgentActive ? (
            <Loader2 className="w-4 h-4 text-blue-400 animate-spin" />
          ) : null}
        </div>
      </div>

      <div className="flex gap-3 mt-1.5">
        {hasEditDiff && (
          <button
            onClick={() => setDiffOpen(!diffOpen)}
            className={cn(
              "text-[10px] flex items-center gap-0.5 transition-colors",
              showDiff
                ? "text-amber-400"
                : "text-zinc-500 hover:text-zinc-300"
            )}
          >
            {showDiff ? (
              <ChevronDown className="w-3 h-3" />
            ) : (
              <ChevronRight className="w-3 h-3" />
            )}
            Diff
          </button>
        )}
        <button
          onClick={() => setInputOpen(!inputOpen)}
          className="text-[10px] text-zinc-500 hover:text-zinc-300 flex items-center gap-0.5 transition-colors"
        >
          {showInput ? (
            <ChevronDown className="w-3 h-3" />
          ) : (
            <ChevronRight className="w-3 h-3" />
          )}
          Input
        </button>
        {toolCall.result !== null && (
          <button
            onClick={() => setResultOpen(!resultOpen)}
            className="text-[10px] text-zinc-500 hover:text-zinc-300 flex items-center gap-0.5 transition-colors"
          >
            {showResult ? (
              <ChevronDown className="w-3 h-3" />
            ) : (
              <ChevronRight className="w-3 h-3" />
            )}
            Result
          </button>
        )}
      </div>

      {showDiff && hasEditDiff && (
        <EditDiffView
          oldString={toolCall.input.old_string as string}
          newString={toolCall.input.new_string as string}
          filePath={toolCall.input.file_path as string}
        />
      )}

      {showInput && (
        <pre className="mt-1.5 text-[11px] text-zinc-400 font-mono whitespace-pre-wrap break-all bg-zinc-950/50 rounded p-2 max-h-64 overflow-y-auto border border-zinc-800/50">
          {JSON.stringify(toolCall.input, null, 2)}
        </pre>
      )}

      {showResult && toolCall.result !== null && (
        <div className="mt-1.5">
          <pre
            className={cn(
              "text-[11px] font-mono whitespace-pre-wrap break-all rounded p-2 max-h-96 overflow-y-auto border",
              toolCall.isError
                ? "text-red-300 bg-red-950/30 border-red-500/20"
                : "text-zinc-400 bg-zinc-950/50 border-zinc-800/50"
            )}
          >
            {visibleResult}
          </pre>
          {isLongResult && (
            <button
              onClick={() => setResultExpanded(!resultExpanded)}
              className="mt-1 text-[10px] text-zinc-500 hover:text-zinc-300 transition-colors"
            >
              {resultExpanded ? "Show less" : "Show more"}
            </button>
          )}
        </div>
      )}
    </div>
  )
})
