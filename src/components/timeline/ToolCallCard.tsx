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
  query: "bg-teal-500/15 text-teal-400 border-teal-500/25",
}

const DEFAULT_BADGE_STYLE = "bg-muted/5 text-muted-foreground/40 border-muted-foreground/10"

/** Shorten MCP tool names like `mcp__plugin_odoo_sequential-thinking__sequentialthinking` → `sequentialthinking` */
export function shortenToolName(name: string): string {
  // MCP pattern: mcp__<plugin>_<server>__<tool> or mcp__<server>__<tool>
  const mcpMatch = name.match(/^mcp__(?:plugin_)?(?:[^_]+_)*?([^_]+)__(.+)$/)
  if (mcpMatch) return mcpMatch[2]
  return name
}

export function getToolBadgeStyle(name: string): string {
  return TOOL_BADGE_STYLES[name] ?? TOOL_BADGE_STYLES[shortenToolName(name)] ?? DEFAULT_BADGE_STYLE
}

/** Shorten an absolute file path to module-relative (e.g. `module/models/foo.py`). */
function shortenFilePath(fp: string): string {
  const segments = fp.split("/")
  for (let i = 0; i < segments.length; i++) {
    if (segments[i] === "dev" && i + 2 < segments.length) {
      const next = segments[i + 1]
      // dev/client_projects/Client/project/module/... → module/...
      if (next === "client_projects" && i + 4 < segments.length) {
        return segments.slice(i + 4).join("/")
      }
      // dev/internal/project/module/... → module/...
      if (next === "internal" && i + 3 < segments.length) {
        return segments.slice(i + 3).join("/")
      }
      // dev/project/src/... → src/...
      return segments.slice(i + 2).join("/")
    }
  }
  if (segments.length > 4) return segments.slice(-4).join("/")
  return fp
}

function getToolSummary(tc: ToolCall): string {
  const input = tc.input
  switch (tc.name) {
    case "Read":
    case "Write":
    case "Edit":
      return shortenFilePath(String(input.file_path ?? input.path ?? ""))
    case "Bash": {
      // Prefer the description field if available
      if (input.description) return String(input.description)
      const cmd = String(input.command ?? "").trim()
      // Strip env setup prefixes (source, cd && ...)
      const stripped = cmd
        .replace(/^(?:source\s+\S+\s*(?:2>\S*)?\s*;?\s*)+/, "")
        .replace(/^(?:cd\s+"[^"]*"\s*&&\s*)+/, "")
        .replace(/^(?:cd\s+\S+\s*&&\s*)+/, "")
        .trim()
      // Take the command name + subcommand (e.g. "git status", "gh pr create", "bun run test")
      // Stop at flags (--), pipes (|), output redirects (>), or path-like arguments (containing /)
      // But capture input redirect targets: "odoo-shell project < script.py" → include the filename
      const words = stripped.split(/\s+/)
      const parts: string[] = []
      for (let wi = 0; wi < words.length; wi++) {
        const w = words[wi]
        if (w === "<" && wi + 1 < words.length) {
          // Input redirect — show the target filename
          const target = words[wi + 1]
          const basename = target.split("/").pop() ?? target
          parts.push("< " + basename)
          break
        }
        if (w.startsWith("-") || w.includes("/") || w.includes("|") || w.includes(">") || w.includes("2>&1")) break
        parts.push(w)
        if (parts.length >= 3) break
      }
      return parts.join(" ") || words[0] || cmd.slice(0, 40)
    }
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
      return shortenFilePath(String(input.notebook_path ?? ""))
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
      // SQL: extract statement type + table (e.g. "SELECT ... FROM product_template")
      const sqlMatch = first.match(/^\s*(SELECT|INSERT|UPDATE|DELETE|CREATE|ALTER|DROP)\b/i)
      if (sqlMatch) {
        const fromMatch = first.match(/\bFROM\s+(\w+)/i) || first.match(/\bINTO\s+(\w+)/i) || first.match(/\bUPDATE\s+(\w+)/i)
        const table = fromMatch ? fromMatch[1] : ""
        return `${sqlMatch[1].toUpperCase()}${table ? ` ... ${table}` : ""}`
      }
      return first.length > 60 ? first.slice(0, 57) + "..." : first
    }
  }
}

/** Build a CLI-like command string from a tool call's input parameters. */
function getToolCommand(tc: ToolCall): string | null {
  const input = tc.input
  const q = (v: unknown) => `"${String(v)}"`
  const flag = (name: string, val: unknown) => {
    if (val === undefined || val === null) return ""
    if (val === true) return ` ${name}`
    if (val === false) return ""
    return ` ${name} ${q(val)}`
  }

  switch (tc.name) {
    case "Grep": {
      let cmd = `rg ${q(input.pattern)}`
      cmd += flag("--type", input.type)
      cmd += flag("--glob", input.glob)
      cmd += flag("-i", input["-i"])
      if (input.output_mode && input.output_mode !== "files_with_matches")
        cmd += flag("-l", input.output_mode === "files_with_matches" ? true : undefined)
      if (input.output_mode === "content") cmd += ""  // default
      if (input.output_mode === "count") cmd += " --count"
      cmd += flag("-A", input["-A"])
      cmd += flag("-B", input["-B"])
      cmd += flag("-C", input["-C"] ?? input.context)
      cmd += flag("--multiline", input.multiline)
      if (input.head_limit) cmd += ` | head -${input.head_limit}`
      if (input.path) cmd += ` ${String(input.path)}`
      return cmd
    }
    case "Glob": {
      let cmd = `glob ${q(input.pattern)}`
      if (input.path) cmd += ` ${String(input.path)}`
      return cmd
    }
    case "Read": {
      let cmd = `cat -n ${String(input.file_path ?? input.path ?? "")}`
      if (input.offset) cmd += ` +${input.offset}`
      if (input.limit) cmd += ` | head -${input.limit}`
      if (input.pages) cmd += ` --pages ${input.pages}`
      return cmd
    }
    case "Write":
      return `write ${String(input.file_path ?? "")}`
    case "Edit": {
      const fp = String(input.file_path ?? "")
      const replaceAll = input.replace_all ? " --replace-all" : ""
      return `edit ${fp}${replaceAll}`
    }
    case "Bash":
      return String(input.command ?? "")
    case "WebFetch":
      return `curl ${String(input.url ?? "")}`
    case "WebSearch":
      return `search ${q(input.query)}`
    case "Agent": {
      const type = input.subagent_type ? `[${input.subagent_type}]` : ""
      return `agent${type} ${q(input.description ?? input.prompt ?? "")}`
    }
    default:
      return null
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
  const [commandOpen, setCommandOpen] = useState(false)
  const [inputOpen, setInputOpen] = useState(false)
  const [resultOpen, setResultOpen] = useState(false)
  const [resultExpanded, setResultExpanded] = useState(false)
  const [diffOpen, setDiffOpen] = useState(false)
  // On mobile, low-signal tools are collapsed to a single line by default
  const [mobileExpanded, setMobileExpanded] = useState(false)
  const isCompactMobile = isMobile && COMPACT_MOBILE_TOOLS.has(toolCall.name) && !expandAll && !mobileExpanded

  const showCommand = expandAll || commandOpen
  const showInput = expandAll || inputOpen
  const showResult = expandAll || resultOpen
  const showDiff = expandAll || diffOpen

  const summary = getToolSummary(toolCall)
  const command = getToolCommand(toolCall)
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
        "rounded-lg border border-border/15 bg-white/[0.02] px-2.5 py-2",
        toolCall.isError && "bg-red-950/10 border-red-500/20",
        isCompactMobile && "cursor-pointer active:bg-white/[0.05]",
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
            title={toolCall.name}
          >
            {shortenToolName(toolCall.name)}
          </Badge>
          {summary && (
            <span className="text-xs text-muted-foreground truncate font-mono">
              {summary}
            </span>
          )}
        </div>
        <div className="flex items-center gap-1.5 flex-shrink-0">
          {!isCompactMobile && (
            <div className="flex items-center gap-1.5">
              {hasEditDiff && (
                <ToggleButton
                  isOpen={showDiff}
                  onClick={() => setDiffOpen(!diffOpen)}
                  label="Diff"
                  activeClass="text-amber-400"
                />
              )}
              {command && (
                <ToggleButton
                  isOpen={showCommand}
                  onClick={() => setCommandOpen(!commandOpen)}
                  label="Command"
                  activeClass="text-cyan-400"
                />
              )}
              <ToggleButton
                isOpen={showInput}
                onClick={() => setInputOpen(!inputOpen)}
                label="Input"
                activeClass="text-blue-400"
              />
              {toolCall.result !== null && (
                <ToggleButton
                  isOpen={showResult}
                  onClick={() => setResultOpen(!resultOpen)}
                  label="Result"
                  activeClass="text-green-400"
                />
              )}
            </div>
          )}
          <StatusIcon toolCall={toolCall} isAgentActive={isAgentActive} />
        </div>
      </div>

      {showCommand && command && (
        <pre className={cn(CODE_BLOCK_CLASS, "mt-1.5 text-cyan-300/80")}>
          <code>{command}</code>
        </pre>
      )}

      {showDiff && hasEditDiff && (
        <EditDiffView
          oldString={toolCall.input.old_string as string}
          newString={toolCall.input.new_string as string}
          filePath={toolCall.input.file_path as string}
        />
      )}

      {showInput && (
        <JsonResultHighlighted
          result={JSON.stringify(toolCall.input)}
          expanded={true}
        />
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
