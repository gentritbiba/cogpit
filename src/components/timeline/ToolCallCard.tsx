import { useState, useEffect, useMemo, memo, useCallback } from "react"
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
import { useIsMobile } from "@/hooks/useIsMobile"
import { EditDiffView } from "./EditDiffView"
import { highlightCode, getLangFromPath } from "@/lib/shiki"
import { useIsDarkMode } from "@/hooks/useIsDarkMode"

const TOOL_BADGE_STYLES: Record<string, string> = {
  // High saturation — primary action tools
  Write: "bg-green-500/20 text-green-400 border-green-500/30",
  Edit: "bg-amber-500/20 text-amber-400 border-amber-500/30",
  Bash: "bg-red-500/20 text-red-400 border-red-500/30",
  // Low saturation — secondary tools
  Read: "bg-blue-500/5 text-blue-400/40 border-blue-500/10",
  Grep: "bg-purple-500/5 text-purple-400/40 border-purple-500/10",
  Glob: "bg-cyan-500/5 text-cyan-400/40 border-cyan-500/10",
  Task: "bg-indigo-500/5 text-indigo-400/40 border-indigo-500/10",
  WebFetch: "bg-orange-500/5 text-orange-400/40 border-orange-500/10",
  WebSearch: "bg-orange-500/5 text-orange-400/40 border-orange-500/10",
  EnterPlanMode: "bg-purple-500/5 text-purple-400/40 border-purple-500/10",
  ExitPlanMode: "bg-purple-500/5 text-purple-400/40 border-purple-500/10",
  AskUserQuestion: "bg-pink-500/5 text-pink-400/40 border-pink-500/10",
}

const DEFAULT_BADGE_STYLE = "bg-muted/5 text-muted-foreground/40 border-muted-foreground/10"

export function getToolBadgeStyle(name: string): string {
  return TOOL_BADGE_STYLES[name] ?? DEFAULT_BADGE_STYLE
}

function getToolSummary(tc: ToolCall): string {
  const input = tc.input
  switch (tc.name) {
    case "Read":
    case "Write":
    case "Edit":
      return String(input.file_path ?? input.path ?? "")
    case "Bash":
      return String(input.command ?? "")
    case "Grep":
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
      if (typeof first !== "string") return ""
      return first.length > 80 ? first.slice(0, 80) + "..." : first
    }
  }
}

// ── Reusable toggle button for expand/collapse sections ──────────────────

function ToggleButton({
  isOpen,
  onClick,
  label,
  activeClass,
}: {
  isOpen: boolean
  onClick: () => void
  label: string
  activeClass?: string
}): React.ReactElement {
  const Chevron = isOpen ? ChevronDown : ChevronRight
  return (
    <button
      onClick={onClick}
      className={cn(
        "text-[10px] flex items-center gap-0.5 transition-colors",
        isOpen && activeClass ? activeClass : "text-muted-foreground hover:text-foreground",
      )}
    >
      <Chevron className="w-3 h-3" />
      {label}
    </button>
  )
}

// ── Status icon for tool call completion state ───────────────────────────

function StatusIcon({
  toolCall,
  isAgentActive,
}: {
  toolCall: ToolCall
  isAgentActive?: boolean
}): React.ReactElement | null {
  if (toolCall.isError) {
    return <XCircle className="w-4 h-4 text-red-400" />
  }
  if (toolCall.result !== null) {
    return <CheckCircle className="w-4 h-4 text-green-500/60" />
  }
  if (isAgentActive) {
    return <Loader2 className="w-4 h-4 text-blue-400 animate-spin" />
  }
  return null
}

// ── Syntax-highlighted Read result ─────────────────────────────────────

type TokenLine = Array<{ content: string; color?: string }>

/** Regex to match the `cat -n` line-number prefix: spaces + number + arrow */
const LINE_PREFIX_RE = /^(\s*\d+)→(.*)$/

function parseReadResult(text: string): { lineNums: string[]; codeLines: string[] } {
  const lines = text.split("\n")
  const lineNums: string[] = []
  const codeLines: string[] = []
  for (const line of lines) {
    const m = line.match(LINE_PREFIX_RE)
    if (m) {
      lineNums.push(m[1])
      codeLines.push(m[2])
    } else {
      lineNums.push("")
      codeLines.push(line)
    }
  }
  return { lineNums, codeLines }
}

function ReadResultHighlighted({
  result,
  filePath,
  expanded,
}: {
  result: string
  filePath: string
  expanded: boolean
}) {
  const isDark = useIsDarkMode()
  const [tokens, setTokens] = useState<TokenLine[] | null>(null)
  const lang = getLangFromPath(filePath)

  const slicedResult = expanded ? result : result.slice(0, 500)
  const { lineNums, codeLines } = useMemo(() => parseReadResult(slicedResult), [slicedResult])
  const code = useMemo(() => codeLines.join("\n"), [codeLines])

  useEffect(() => {
    if (!lang) {
      setTokens(null)
      return
    }
    let cancelled = false
    highlightCode(code, lang, isDark).then((r) => {
      if (!cancelled) setTokens(r)
    })
    return () => { cancelled = true }
  }, [code, lang, isDark])

  return (
    <pre className="text-[11px] font-mono whitespace-pre-wrap break-all rounded p-2 max-h-96 overflow-y-auto border text-muted-foreground bg-elevation-0 border-border/30 leading-[1.6]">
      <code className="block">
        {codeLines.map((line, i) => {
          const tokenLine = tokens?.[i]
          return (
            <span key={i} className="block">
              {lineNums[i] && (
                <span className="inline-block w-10 text-right mr-2 text-muted-foreground/30 select-none">
                  {lineNums[i]}
                </span>
              )}
              {tokenLine
                ? tokenLine.map((token, j) => (
                    <span key={j} style={{ color: token.color }}>
                      {token.content}
                    </span>
                  ))
                : line || "\u00A0"
              }
            </span>
          )
        })}
      </code>
    </pre>
  )
}

// ── Main component ───────────────────────────────────────────────────────

interface ToolCallCardProps {
  toolCall: ToolCall
  expandAll: boolean
  isAgentActive?: boolean
}

/** Low-signal tools that are collapsed to a single line on mobile by default. */
const COMPACT_MOBILE_TOOLS = new Set(["Read", "Grep", "Glob", "WebFetch", "WebSearch", "Task", "EnterPlanMode", "ExitPlanMode"])

export const ToolCallCard = memo(function ToolCallCard({ toolCall, expandAll, isAgentActive }: ToolCallCardProps) {
  const isMobile = useIsMobile()
  const [inputOpen, setInputOpen] = useState(false)
  const [resultOpen, setResultOpen] = useState(false)
  const [resultExpanded, setResultExpanded] = useState(false)
  const [diffOpen, setDiffOpen] = useState(false)
  // On mobile, low-signal tools are collapsed to a single line by default
  const [mobileExpanded, setMobileExpanded] = useState(false)
  const isCompactMobile = isMobile && COMPACT_MOBILE_TOOLS.has(toolCall.name) && !expandAll && !mobileExpanded

  const showInput = expandAll || inputOpen
  const showResult = expandAll || resultOpen
  const showDiff = expandAll || diffOpen

  const summary = getToolSummary(toolCall)
  const resultText = toolCall.result ?? ""
  const isLongResult = resultText.length > 1000
  const visibleResult =
    isLongResult && !resultExpanded ? resultText.slice(0, 500) + "..." : resultText

  const hasEditDiff =
    toolCall.name === "Edit" &&
    typeof toolCall.input.old_string === "string" &&
    typeof toolCall.input.new_string === "string" &&
    typeof toolCall.input.file_path === "string"

  const handleCompactTap = useCallback(() => {
    if (isCompactMobile) setMobileExpanded(true)
  }, [isCompactMobile])

  return (
    <div
      className={cn(
        "py-1.5",
        toolCall.isError && "bg-red-950/10 rounded-md px-2",
        isCompactMobile && "cursor-pointer active:bg-white/[0.03] rounded-sm",
      )}
      onClick={isCompactMobile ? handleCompactTap : undefined}
    >
      <div className="flex items-center gap-2">
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
            <span className="text-xs text-muted-foreground truncate font-mono">
              {summary}
            </span>
          )}
        </div>
        <div className="flex items-center gap-1.5 flex-shrink-0">
          {/* Hide timestamp on mobile compact mode to save space */}
          {toolCall.timestamp && !isCompactMobile && (
            <span className="text-[10px] text-muted-foreground/40 font-mono tabular-nums">
              {new Date(toolCall.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}
            </span>
          )}
          <StatusIcon toolCall={toolCall} isAgentActive={isAgentActive} />
        </div>
      </div>

      {!isCompactMobile && (
        <div className="flex gap-3 mt-1">
          {hasEditDiff && (
            <ToggleButton
              isOpen={showDiff}
              onClick={() => setDiffOpen(!diffOpen)}
              label="Diff"
              activeClass="text-amber-400"
            />
          )}
          <ToggleButton
            isOpen={showInput}
            onClick={() => setInputOpen(!inputOpen)}
            label="Input"
          />
          {toolCall.result !== null && (
            <ToggleButton
              isOpen={showResult}
              onClick={() => setResultOpen(!resultOpen)}
              label="Result"
            />
          )}
        </div>
      )}

      {showDiff && hasEditDiff && (
        <EditDiffView
          oldString={toolCall.input.old_string as string}
          newString={toolCall.input.new_string as string}
          filePath={toolCall.input.file_path as string}
        />
      )}

      {showInput && (
        <pre className="mt-1.5 text-[11px] text-muted-foreground font-mono whitespace-pre-wrap break-all bg-elevation-0 rounded p-2 max-h-64 overflow-y-auto border border-border/30">
          {JSON.stringify(toolCall.input, null, 2)}
        </pre>
      )}

      {showResult && toolCall.result !== null && (
        <div className="mt-1.5">
          {toolCall.name === "Read" && !toolCall.isError && typeof toolCall.input.file_path === "string" ? (
            <ReadResultHighlighted
              result={resultText}
              filePath={toolCall.input.file_path as string}
              expanded={!isLongResult || resultExpanded}
            />
          ) : (
            <pre
              className={cn(
                "text-[11px] font-mono whitespace-pre-wrap break-all rounded p-2 max-h-96 overflow-y-auto border",
                toolCall.isError
                  ? "text-red-700 dark:text-red-300 bg-red-50 dark:bg-red-950/30 border-red-500/20"
                  : "text-muted-foreground bg-elevation-0 border-border/30"
              )}
            >
              {visibleResult}
            </pre>
          )}
          {isLongResult && (
            <button
              onClick={() => setResultExpanded(!resultExpanded)}
              className="mt-1 text-[10px] text-muted-foreground hover:text-foreground transition-colors"
            >
              {resultExpanded ? "Show less" : "Show more"}
            </button>
          )}
        </div>
      )}
    </div>
  )
})
