import { useMemo, useState } from "react"
import {
  Check,
  ChevronRight,
  Copy,
  FileText,
  FolderOpen,
  LoaderCircle,
  PenLine,
  Play,
  Search,
  type LucideIcon,
} from "lucide-react"
import type { ToolCall } from "../../../shared/session/types"
import { getCommandText } from "../../../shared/session/toolSummary"
import { Button } from "@/components/ui/button"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { Separator } from "@/components/ui/separator"
import { useCopyWithFeedback } from "@/hooks/useCopyWithFeedback"
import { can } from "@/lib/capabilities"
import { openFile } from "@/lib/fileOpener"
import {
  analyzeSection,
  parseSectionedCommand,
  type CommandSection,
  type SectionAnalysis,
  type SectionKind,
} from "@/lib/sectionedCommand"
import { cn } from "@/lib/utils"
import { TOOL_RESULT_CLASS, ToolResultPanel } from "./ToolCallResult"

function sectionName(section: CommandSection): string {
  return section.label || section.command.match(/^[\w.-]+/)?.[0] || "…"
}

const KIND_META: Record<SectionKind, { icon: LucideIcon; label: string }> = {
  read: { icon: FileText, label: "Read file" },
  search: { icon: Search, label: "Search" },
  list: { icon: FolderOpen, label: "List files" },
  run: { icon: Play, label: "Run command" },
  write: { icon: PenLine, label: "Update files" },
}

const STANDARD_BASH_KEYS = new Set(["command", "cmd", "description", "timeout", "run_in_background"])

interface BashCallView {
  command: string
  rows: CommandRowView[]
  options: string[]
}

interface CommandRowView {
  section: CommandSection
  analysis: SectionAnalysis
  failed: boolean
  pending: boolean
}

export function bashSections(toolCall: ToolCall): CommandSection[] {
  const command = getCommandText(toolCall.input)
  return parseSectionedCommand(command, toolCall.result) ?? [{ label: "", command, output: toolCall.result }]
}

function failedRowIndex(toolCall: ToolCall, sections: CommandSection[], analyses: SectionAnalysis[]): number {
  if (!toolCall.isError || analyses.some((analysis) => analysis.failed)) return -1
  const reached = sections.findLastIndex((section) => section.output !== null)
  return reached >= 0 ? reached : sections.length - 1
}

function formatTimeout(value: unknown): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return String(value)
  if (value < 1000) return `${value} ms timeout`
  if (value % 60_000 === 0) return `${value / 60_000} min timeout`
  if (value % 1000 === 0) return `${value / 1000} sec timeout`
  return `${(value / 1000).toFixed(1)} sec timeout`
}

function formatKey(key: string): string {
  return key
    .replace(/_/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/^./, (letter) => letter.toUpperCase())
}

function formatValue(value: unknown): string {
  if (typeof value === "string") return value
  if (value === null) return "null"
  if (value === undefined) return "undefined"
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

function bashOptions(input: Record<string, unknown>): string[] {
  const options: string[] = []
  if (input.timeout !== undefined) options.push(formatTimeout(input.timeout))
  if (typeof input.run_in_background === "boolean") {
    options.push(input.run_in_background ? "Background" : "Foreground")
  }
  for (const [key, value] of Object.entries(input)) {
    if (STANDARD_BASH_KEYS.has(key) || value === undefined) continue
    options.push(`${formatKey(key)} ${formatValue(value)}`)
  }
  return options
}

function toCallView(toolCall: ToolCall, isAgentActive: boolean): BashCallView {
  const sections = bashSections(toolCall)
  const analyses = sections.map(analyzeSection)
  const outerFailure = failedRowIndex(toolCall, sections, analyses)
  return {
    command: getCommandText(toolCall.input),
    rows: sections.map((section, index) => ({
      section,
      analysis: analyses[index],
      failed: analyses[index].failed || index === outerFailure,
      pending: isAgentActive && toolCall.result === null && !toolCall.isError,
    })),
    options: bashOptions(toolCall.input),
  }
}

function lineCount(output: string | null): number {
  return output ? output.split(/\r\n|\r|\n/).length : 0
}

function outputSummary(row: CommandRowView): string {
  if (row.failed) return "Failed"
  if (row.pending) return "Output pending"
  if (row.section.output === null) return "Not run"
  if (row.section.output === "") return "No output"
  const count = lineCount(row.section.output)
  return count === 1 ? "1 line" : `${count} lines`
}

function resolvePath(path: string, cwd: string | undefined): string | null {
  if (path.startsWith("/")) return path
  if (path.startsWith("~")) return null
  if (!cwd) return null
  return `${cwd.replace(/\/$/, "")}/${path.replace(/^\.\//, "")}`
}

function PathLink({
  path,
  line,
  cwd,
  children,
}: {
  path: string
  line?: number
  cwd: string | undefined
  children: React.ReactNode
}): React.ReactElement {
  const resolved = resolvePath(path, cwd)
  if (!resolved || !can("hostFiles")) return <>{children}</>
  return (
    <button
      type="button"
      className="rounded-sm underline decoration-dotted decoration-muted-foreground/60 underline-offset-2 hover:bg-muted hover:text-foreground hover:decoration-solid"
      title={`Open ${resolved}${line ? `:${line}` : ""}`}
      onClick={(event) => {
        event.stopPropagation()
        openFile(resolved, line ? { line } : {})
      }}
    >
      {children}
    </button>
  )
}

function CommandText({
  command,
  paths,
  cwd,
}: {
  command: string
  paths: string[]
  cwd: string | undefined
}): React.ReactElement {
  if (paths.length === 0) return <>{command}</>
  const pathSet = new Set(paths)
  return (
    <>
      {command.split(/(\s+)/).map((token, index) => {
        const bare = token.replace(/^["']|["']?[,:;]?$/g, "")
        return pathSet.has(bare) ? (
          <PathLink key={index} path={bare} cwd={cwd}>
            {token}
          </PathLink>
        ) : (
          token
        )
      })}
    </>
  )
}

const GREP_LINE_RE = /^([^\s:]+):(\d+)([:-])/

function SearchOutput({ output, cwd }: { output: string; cwd: string | undefined }): React.ReactElement {
  return (
    <pre tabIndex={0} className={TOOL_RESULT_CLASS}>
      {output.split(/\r\n|\r|\n/).map((line, index) => {
        const match = line.match(GREP_LINE_RE)
        return (
          <span key={index} className="block">
            {match ? (
              <>
                <PathLink path={match[1]} line={Number(match[2])} cwd={cwd}>
                  {match[1]}:{match[2]}
                </PathLink>
                {line.slice(match[1].length + match[2].length + 1)}
              </>
            ) : (
              line || " "
            )}
          </span>
        )
      })}
    </pre>
  )
}

function CommandOutput({ row, cwd }: { row: CommandRowView; cwd: string | undefined }): React.ReactElement {
  if (row.section.output === null) {
    return (
      <p className="flex items-center gap-2 py-2 text-xs text-muted-foreground" role="status">
        {row.pending && <LoaderCircle className="size-3.5 motion-safe:animate-spin" aria-hidden="true" />}
        {row.pending ? "Command is running. Waiting for output…" : "Output unavailable"}
      </p>
    )
  }

  return (
    <ToolResultPanel
      result={row.section.output}
      isError={row.failed}
      filePath={row.analysis.readFile?.path}
      renderResult={row.analysis.kind === "search" && !row.failed
        ? (visible) => <SearchOutput output={visible} cwd={cwd} />
        : undefined}
    />
  )
}

function CommandRow({
  row,
  expandAll,
  cwd,
}: {
  row: CommandRowView
  expandAll: boolean
  cwd: string | undefined
}): React.ReactElement {
  const [localOpen, setLocalOpen] = useState(false)
  const open = expandAll || localOpen
  const hasOutput = row.section.output !== null && row.section.output !== ""
  const rowLabel = `${sectionName(row.section)} section: ${row.section.command}`
  const { icon: KindIcon, label: kindLabel } = KIND_META[row.analysis.kind]
  const rowClass = "flex min-h-9 w-full min-w-0 items-center gap-2 text-left"
  const content = (
    <>
      <KindIcon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
      <span className="min-w-0 flex-1 break-words text-[13px] font-medium text-foreground">
        {row.section.label || kindLabel}
      </span>
      <span className={cn("shrink-0 text-xs tabular-nums text-muted-foreground", row.failed && "text-destructive")}>
        {outputSummary(row)}
      </span>
      {hasOutput && (
        <ChevronRight
          className={cn("size-3.5 shrink-0 text-muted-foreground transition-transform motion-reduce:transition-none", open && "rotate-90")}
          aria-hidden="true"
        />
      )}
    </>
  )

  return (
    <Collapsible open={open} onOpenChange={(nextOpen) => { if (!expandAll) setLocalOpen(nextOpen) }} className="min-w-0 py-2">
      {hasOutput ? (
        <CollapsibleTrigger
          className={cn(rowClass, "cursor-pointer rounded-md hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring")}
          aria-label={rowLabel}
          disabled={expandAll}
        >
          {content}
        </CollapsibleTrigger>
      ) : (
        <div className={rowClass} aria-label={rowLabel}>{content}</div>
      )}
      <div className="flex min-w-0 items-start gap-2 pl-5.5">
        <code className={cn(
          "min-w-0 flex-1 font-mono text-xs leading-relaxed text-foreground/85",
          open || !hasOutput ? "whitespace-pre-wrap break-words [overflow-wrap:anywhere]" : "truncate",
        )}>
          <CommandText command={row.section.command} paths={row.analysis.paths} cwd={cwd} />
        </code>
        {row.analysis.readFile?.from && (
          <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
            L{row.analysis.readFile.from}–{row.analysis.readFile.to}
          </span>
        )}
      </div>
      {hasOutput && (
        <CollapsibleContent>
          <div className="pb-1 pl-5.5">
            <CommandOutput row={row} cwd={cwd} />
          </div>
        </CollapsibleContent>
      )}
    </Collapsible>
  )
}

export function BashCommandCard({
  toolCall,
  cwd,
  expandAll = false,
  isAgentActive = false,
}: {
  toolCall: ToolCall
  cwd?: string
  expandAll?: boolean
  isAgentActive?: boolean
}): React.ReactElement {
  const call = useMemo(
    () => toCallView(toolCall, isAgentActive),
    [isAgentActive, toolCall],
  )
  const commandCount = call.rows.length
  const [copied, copyCommands] = useCopyWithFeedback()

  return (
    <section className="min-w-0" aria-label={commandCount === 1 ? "Bash command" : "Bash commands"}>
      <div className="mb-1 flex items-center justify-between gap-2">
        <span className="text-xs font-medium text-muted-foreground">
          {commandCount === 1 ? "Command" : `${commandCount} commands`}
        </span>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          onClick={() => copyCommands(call.command)}
          aria-label={copied ? "Commands copied" : commandCount === 1 ? "Copy command" : "Copy commands"}
          title={copied ? "Copied" : commandCount === 1 ? "Copy command" : "Copy commands"}
        >
          {copied ? <Check data-icon="inline-start" aria-hidden="true" /> : <Copy data-icon="inline-start" aria-hidden="true" />}
        </Button>
      </div>
      <div className="flex min-w-0 flex-col gap-2" aria-label="Command sections">
        {call.options.length > 0 && (
          <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 py-1 text-xs text-muted-foreground [overflow-wrap:anywhere]">
            {call.options.map((option) => <span key={option}>{option}</span>)}
          </div>
        )}
        {commandCount === 1 ? (
          <>
            <pre className="min-w-0 whitespace-pre-wrap break-words rounded-md bg-muted/40 p-3 font-mono text-xs leading-relaxed text-foreground [overflow-wrap:anywhere]">
              <CommandText command={call.command} paths={call.rows[0].analysis.paths} cwd={cwd} />
            </pre>
            <CommandOutput row={call.rows[0]} cwd={cwd} />
          </>
        ) : (
          <div className="min-w-0">
            {call.rows.map((row, rowIndex) => (
              <div key={rowIndex} className="min-w-0">
                {rowIndex > 0 && <Separator />}
                <CommandRow row={row} expandAll={expandAll} cwd={cwd} />
              </div>
            ))}
          </div>
        )}
      </div>
    </section>
  )
}
