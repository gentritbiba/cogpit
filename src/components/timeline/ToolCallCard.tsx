import { useState, useEffect, useMemo, memo, useCallback } from "react"
import {
  CheckCircle,
  XCircle,
  ChevronRight,
  ChevronDown,
  Loader2,
  ExternalLink,
} from "lucide-react"
import { Badge } from "@/components/ui/badge"
import type { ToolCall } from "@/lib/types"
import { cn } from "@/lib/utils"
import { LiveSubagentTranscript } from "@/components/timeline/LiveSubagentTranscript"
import { useIsMobile } from "@/hooks/useIsMobile"
import { EditDiffView } from "./EditDiffView"
import { highlightCode, getLangFromPath } from "@/lib/shiki"
import { useIsDarkMode } from "@/hooks/useIsDarkMode"
import { authFetch } from "@/lib/auth"
import type { SkillMeta } from "@/hooks/useSkillMetadata"
import { useSessionContext } from "@/contexts/SessionContext"
import { BashToolInput, CodexExecToolInput } from "./BashToolInput"

/**
 * Timeline tool badge styles — used in the live session timeline (ToolCallCard).
 *
 * Intentionally desaturated and background-filled to reduce noise in a dense,
 * streaming list. Primary action tools (Write/Edit/Bash) use higher saturation to
 * draw attention; secondary/read-only tools are very dim.
 *
 * Distinct from the BranchModal's TOOL_BADGE_STYLES (branchStyles.ts), which uses
 * high-contrast border+text only (no background) for a compact historical summary view.
 */
const TIMELINE_TOOL_BADGE_STYLES: Record<string, string> = {
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
  // Scheduling / automation tools
  Monitor: "bg-cyan-500/5 text-cyan-400/40 border-cyan-500/10",
  CronCreate: "bg-violet-500/5 text-violet-400/40 border-violet-500/10",
  CronDelete: "bg-violet-500/5 text-violet-400/40 border-violet-500/10",
  CronList: "bg-violet-500/5 text-violet-400/40 border-violet-500/10",
  ScheduleWakeup: "bg-violet-500/5 text-violet-400/40 border-violet-500/10",
  RemoteTrigger: "bg-blue-500/5 text-blue-400/40 border-blue-500/10",
  PushNotification: "bg-pink-500/10 text-pink-400/60 border-pink-500/20",
  EnterWorktree: "bg-emerald-500/5 text-emerald-400/40 border-emerald-500/10",
  ExitWorktree: "bg-emerald-500/5 text-emerald-400/40 border-emerald-500/10",
  Skill: "bg-indigo-500/10 text-indigo-400/60 border-indigo-500/20",
  ToolSearch: "bg-slate-500/5 text-slate-400/40 border-slate-500/10",
}

const DEFAULT_BADGE_STYLE = "bg-muted/5 text-muted-foreground/40 border-muted-foreground/10"

export function getToolBadgeStyle(name: string): string {
  return TIMELINE_TOOL_BADGE_STYLES[name] ?? DEFAULT_BADGE_STYLE
}

export function getToolSummary(tc: ToolCall): string {
  const input = tc.input
  switch (tc.name) {
    case "Read":
    case "Write":
    case "Edit":
      return String(input.file_path ?? input.path ?? "")
    case "Bash":
      return String(input.command ?? input.cmd ?? "")
    case "Grep":
    case "Glob":
      return String(input.pattern ?? "")
    case "Task":
    case "Agent":
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
    case "Monitor": {
      const bashId = String(input.bash_id ?? "")
      const filter = input.filter ? ` · filter=${input.filter}` : ""
      return `${bashId}${filter}`
    }
    case "CronCreate": {
      const sched = String(input.schedule ?? input.cron ?? "")
      const prompt = String(input.prompt ?? "")
      const trimmed = prompt.length > 60 ? prompt.slice(0, 60) + "..." : prompt
      return sched && trimmed ? `${sched} → ${trimmed}` : sched || trimmed
    }
    case "CronList":
      return ""
    case "CronDelete":
      return String(input.id ?? input.cron_id ?? "")
    case "ScheduleWakeup": {
      const sec = Number(input.delaySeconds ?? 0)
      const m = Math.round(sec / 60)
      const human = sec >= 3600 ? `${Math.round(sec / 3600)}h` : sec >= 60 ? `${m}m` : `${sec}s`
      const reason = input.reason ? ` · ${input.reason}` : ""
      return `in ${human}${reason}`
    }
    case "RemoteTrigger": {
      const action = String(input.action ?? "")
      const id = String(input.id ?? input.trigger_id ?? "")
      return [action, id].filter(Boolean).join(" ")
    }
    case "PushNotification":
      return String(input.title ?? input.body ?? "")
    case "EnterWorktree": {
      const name = String(input.name ?? input.branch ?? "")
      const path = input.path ? ` (${input.path})` : ""
      return `${name}${path}`
    }
    case "ExitWorktree":
      return String(input.name ?? input.branch ?? "")
    case "Skill":
      return String(input.skill ?? input.name ?? "")
    case "ToolSearch":
      return String(input.query ?? "")
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
    return <Loader2 className="w-4 h-4 text-blue-400" />
  }
  return null
}

// ── Shared highlighted code block ─────────────────────────────────────

type TokenLine = Array<{ content: string; color?: string }>

const CODE_BLOCK_CLASS =
  "text-[11px] font-mono whitespace-pre-wrap break-all rounded p-2 max-h-96 overflow-y-auto border text-muted-foreground bg-elevation-0 border-border/30 leading-[1.6]"

/** Shared hook: highlight code and return tokens, cancelling stale requests. */
function useHighlightedTokens(code: string, lang: string | null, isDark: boolean): TokenLine[] | null {
  const [tokens, setTokens] = useState<TokenLine[] | null>(null)

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

  return tokens
}

/** Renders a list of lines with optional token-based syntax highlighting. */
function HighlightedCodeBlock({
  lines,
  tokens,
  lineNums,
}: {
  lines: string[]
  tokens: TokenLine[] | null
  lineNums?: string[]
}): React.ReactElement {
  return (
    <pre className={CODE_BLOCK_CLASS}>
      <code className="block">
        {lines.map((line, i) => {
          const tokenLine = tokens?.[i]
          return (
            <span key={i} className="block">
              {lineNums?.[i] && (
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

// ── Syntax-highlighted Read result ─────────────────────────────────────

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
}): React.ReactElement {
  const isDark = useIsDarkMode()
  const lang = getLangFromPath(filePath)

  const slicedResult = expanded ? result : result.slice(0, 500)
  const { lineNums, codeLines } = useMemo(() => parseReadResult(slicedResult), [slicedResult])
  const code = useMemo(() => codeLines.join("\n"), [codeLines])
  const tokens = useHighlightedTokens(code, lang, isDark)

  return <HighlightedCodeBlock lines={codeLines} tokens={tokens} lineNums={lineNums} />
}

// ── JSON result with syntax highlighting ─────────────────────────────────

/** Try to parse a string as JSON. Returns the pretty-printed string or null. */
function tryPrettyJson(text: string): string | null {
  const trimmed = text.trim()
  if (trimmed[0] !== "{" && trimmed[0] !== "[") return null
  try {
    return JSON.stringify(JSON.parse(trimmed), null, 2)
  } catch {
    return null
  }
}

function JsonResultHighlighted({
  result,
  expanded,
  alreadyPretty,
}: {
  result: string
  expanded: boolean
  alreadyPretty?: boolean
}): React.ReactElement {
  const isDark = useIsDarkMode()

  const pretty = useMemo(() => alreadyPretty ? result : (tryPrettyJson(result) ?? result), [result, alreadyPretty])
  const sliced = expanded ? pretty : pretty.slice(0, 2000)
  const lines = useMemo(() => sliced.split("\n"), [sliced])
  const tokens = useHighlightedTokens(sliced, "json", isDark)

  return <HighlightedCodeBlock lines={lines} tokens={tokens} />
}

// ── AskUserQuestion inline answer form ─────────────────────────────────────

interface AskUserQuestion {
  question: string
  header?: string
  options?: Array<{ label: string; description?: string }>
  multiSelect?: boolean
  type?: string
}

function AskUserAnswerForm({
  toolCall,
  sessionId,
}: {
  toolCall: ToolCall
  sessionId: string
}): React.ReactElement | null {
  const questions = (toolCall.input.questions as AskUserQuestion[] | undefined) ?? []
  const [answers, setAnswers] = useState<Record<string, string>>(() => (
    Object.fromEntries(questions.map((question) => [question.question, ""]))
  ))
  const [submitting, setSubmitting] = useState(false)
  const [submitted, setSubmitted] = useState(false)
  const [error, setError] = useState<string | null>(null)

  if (questions.length === 0) return null

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setSubmitting(true)
    setError(null)
    try {
      const res = await authFetch("/api/ask-user-answer", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId, toolUseId: toolCall.id, answers }),
      })
      if (res.ok) {
        setSubmitted(true)
      } else {
        const data = await res.json() as { error?: string }
        setError(data.error ?? "Failed to submit answer")
      }
    } catch {
      setError("Network error")
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <form
      onSubmit={(e) => { void handleSubmit(e) }}
      className={cn(
        "mt-2 rounded-md border border-pink-500/30 bg-pink-500/5 p-2.5 space-y-2",
        submitted && "opacity-50 pointer-events-none",
      )}
    >
      {questions.map((q, i) => {
        const isMultipleChoice = q.options && q.options.length > 0
        return (
          <div key={i} className="space-y-1">
            {(q.header || q.question) && (
              <div className="text-[11px] text-pink-300">
                {q.header && <span className="font-medium mr-1">{q.header}</span>}
                {q.question}
              </div>
            )}
            {isMultipleChoice ? (
              <div className="flex flex-wrap gap-1.5">
                {q.options!.map((opt, oi) => (
                  <button
                    key={oi}
                    type="button"
                    onClick={() => {
                      const current = answers[q.question] ?? ""
                      const selected = q.multiSelect
                        ? current.split(", ").filter(Boolean)
                        : []
                      const nextValue = q.multiSelect
                        ? selected.includes(opt.label)
                          ? selected.filter((label) => label !== opt.label).join(", ")
                          : [...selected, opt.label].join(", ")
                        : opt.label
                      const next = { ...answers, [q.question]: nextValue }
                      setAnswers(next)
                    }}
                    className={cn(
                      "text-[11px] px-2 py-0.5 rounded border transition-colors",
                      (q.multiSelect
                        ? (answers[q.question] ?? "").split(", ").includes(opt.label)
                        : answers[q.question] === opt.label)
                        ? "border-pink-500/60 bg-pink-500/20 text-pink-200"
                        : "border-pink-500/20 text-pink-400 hover:bg-pink-500/10",
                    )}
                    title={opt.description}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
            ) : (
              <textarea
                value={answers[q.question] ?? ""}
                onChange={(e) => {
                  const next = { ...answers, [q.question]: e.target.value }
                  setAnswers(next)
                }}
                rows={2}
                className="w-full text-[11px] font-mono bg-elevation-2 border border-pink-500/20 rounded p-1.5 text-foreground placeholder:text-muted-foreground/50 resize-none focus:outline-none focus:border-pink-500/50"
                placeholder="Type your answer..."
              />
            )}
          </div>
        )
      })}
      {error && <p className="text-[10px] text-red-400">{error}</p>}
      <button
        type="submit"
        disabled={submitting || submitted}
        className="text-[11px] px-2.5 py-1 rounded border border-pink-500/40 bg-pink-500/15 text-pink-300 hover:bg-pink-500/25 transition-colors disabled:opacity-50"
      >
        {submitted ? "Sent" : submitting ? "Sending..." : "Send answer"}
      </button>
    </form>
  )
}

// ── Main component ───────────────────────────────────────────────────────

interface ToolCallCardProps {
  toolCall: ToolCall
  expandAll: boolean
  isAgentActive?: boolean
  skillMetadata?: Map<string, SkillMeta>
}

/** Low-signal tools that are collapsed to a single line on mobile by default. */
const COMPACT_MOBILE_TOOLS = new Set(["Read", "Grep", "Glob", "WebFetch", "WebSearch", "Task", "Agent", "EnterPlanMode", "ExitPlanMode", "Monitor", "CronList", "ToolSearch"])

export const ToolCallCard = memo(function ToolCallCard({ toolCall, expandAll, isAgentActive, skillMetadata }: ToolCallCardProps) {
  const { session } = useSessionContext()
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
  const skillMeta = toolCall.name === "Skill" && skillMetadata
    ? skillMetadata.get(summary) ?? null
    : null
  const resultText = toolCall.result ?? ""
  const isLongResult = resultText.length > 1000
  const visibleResult =
    isLongResult && !resultExpanded ? resultText.slice(0, 500) + "..." : resultText
  const prettyJson = useMemo(
    () => (!toolCall.isError && toolCall.name !== "Read") ? tryPrettyJson(resultText) : null,
    [toolCall.isError, toolCall.name, resultText],
  )
  const isJsonResult = prettyJson !== null

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
          {toolCall.hookDurationMs !== undefined && toolCall.hookDurationMs > 0 && (
            <span className="text-[10px] text-muted-foreground/50 tabular-nums" title="PostToolUse hook duration">{toolCall.hookDurationMs}ms</span>
          )}
          {toolCall.outputReplacedByHook && (
            <span className="text-[10px] text-blue-400" title="Output replaced by hook">hook</span>
          )}
          <StatusIcon toolCall={toolCall} isAgentActive={isAgentActive} />
        </div>
      </div>

      {skillMeta && !isCompactMobile && (
        <div className="flex items-center gap-2 mt-0.5 text-[10px] text-muted-foreground/60 font-mono">
          <span>source: {skillMeta.source}</span>
          {skillMeta.filePath && (
            <button
              onClick={(e) => {
                e.stopPropagation()
                authFetch("/api/open-in-editor", {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ path: skillMeta.filePath }),
                })
              }}
              className="flex items-center gap-0.5 text-indigo-400/70 hover:text-indigo-400 transition-colors"
              title={skillMeta.filePath}
            >
              <ExternalLink className="w-2.5 h-2.5" />
              Open SKILL.md
            </button>
          )}
        </div>
      )}

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
        toolCall.name === "Bash" && (typeof toolCall.input.command === "string" || typeof toolCall.input.cmd === "string") ? (
          <BashToolInput input={toolCall.input} />
        ) : (toolCall.name === "exec" || /(?:^|__|[.:/])exec$/.test(toolCall.name)) && typeof toolCall.input.raw === "string" ? (
          <CodexExecToolInput input={toolCall.input} />
        ) : (
          <JsonResultHighlighted
            result={JSON.stringify(toolCall.input)}
            expanded={true}
          />
        )
      )}

      {toolCall.name === "AskUserQuestion" && toolCall.result === null && isAgentActive && session?.sessionId && (
        <AskUserAnswerForm toolCall={toolCall} sessionId={session.sessionId} />
      )}

      {(toolCall.name === "Task" || toolCall.name === "Agent") && toolCall.result === null && (
        <LiveSubagentTranscript toolUseId={toolCall.id} />
      )}

      {showResult && toolCall.result !== null && (
        <div className="mt-1.5">
          {toolCall.name === "Read" && !toolCall.isError && typeof toolCall.input.file_path === "string" ? (
            <ReadResultHighlighted
              result={resultText}
              filePath={toolCall.input.file_path as string}
              expanded={!isLongResult || resultExpanded}
            />
          ) : isJsonResult ? (
            <JsonResultHighlighted
              result={prettyJson!}
              expanded={!isLongResult || resultExpanded}
              alreadyPretty
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
