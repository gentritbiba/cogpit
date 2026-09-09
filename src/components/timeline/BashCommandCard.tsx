import { useMemo, useState } from "react"
import {
  Check,
  ChevronRight,
  Copy,
  FileText,
  FolderOpen,
  PenLine,
  Play,
  Search,
  Terminal,
  type LucideIcon,
} from "lucide-react"
import type { ToolCall } from "../../../shared/session/types"
import { getCommandText } from "../../../shared/session/toolSummary"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
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
import { ReadResultHighlighted } from "./ToolCallResult"

function sectionName(section: CommandSection): string {
  return section.label || section.command.match(/^[\w.-]+/)?.[0] || "…"
}

type ChipTone = "muted" | "failed"

export interface SectionChip {
  name: string
  tone: ChipTone
  count: number
}

export function sectionChips(sections: CommandSection[]): SectionChip[] {
  const chips: SectionChip[] = []
  const chipByName = new Map<string, SectionChip>()
  for (const section of sections) {
    const name = sectionName(section)
    const tone = analyzeSection(section).failed ? "failed" : "muted"
    const existing = chipByName.get(name)
    if (existing) {
      existing.count++
      if (tone === "failed") existing.tone = "failed"
      continue
    }
    const chip: SectionChip = { name, tone, count: 1 }
    chips.push(chip)
    chipByName.set(name, chip)
  }
  return chips
}

export const CHIP_TONE_CLASS: Record<ChipTone, string> = {
  muted: "text-muted-foreground",
  failed: "border-destructive/30 text-destructive",
}

const KIND_META: Record<SectionKind, { icon: LucideIcon; label: string; plural: string }> = {
  read: { icon: FileText, label: "read", plural: "reads" },
  search: { icon: Search, label: "search", plural: "searches" },
  list: { icon: FolderOpen, label: "list", plural: "lists" },
  run: { icon: Play, label: "run", plural: "runs" },
  write: { icon: PenLine, label: "write", plural: "writes" },
}

const KIND_ORDER: SectionKind[] = ["read", "search", "list", "run", "write"]
const STANDARD_BASH_KEYS = new Set(["command", "cmd", "description", "timeout", "run_in_background"])

interface BashCallView {
  toolCall: ToolCall
  command: string
  description?: string
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
    toolCall,
    command: getCommandText(toolCall.input),
    description: typeof toolCall.input.description === "string" ? toolCall.input.description : undefined,
    rows: sections.map((section, index) => ({
      section,
      analysis: analyses[index],
      failed: analyses[index].failed || index === outerFailure,
      pending: isAgentActive && toolCall.result === null && index === sections.length - 1,
    })),
    options: bashOptions(toolCall.input),
  }
}

function lineCount(output: string | null): number {
  return output ? output.split("\n").length : 0
}

function outputSummary(row: CommandRowView): string {
  if (row.pending) return "running"
  if (row.section.output === null) return "not run"
  if (row.section.output === "") return "no output"
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
const OUTPUT_CLASS =
  "mb-1.5 ml-6 min-w-0 max-h-96 overflow-y-auto whitespace-pre-wrap break-words [overflow-wrap:anywhere] border-l pl-3 font-mono text-[11px] leading-relaxed text-muted-foreground"

function CommandOutput({ row, cwd }: { row: CommandRowView; cwd: string | undefined }): React.ReactElement {
  const output = row.section.output ?? ""

  if (row.analysis.readFile && !row.failed) {
    return (
      <div className={cn(OUTPUT_CLASS, "pl-0 [&_pre]:border-0 [&_pre]:pl-3")}>
        <ReadResultHighlighted
          result={output}
          filePath={row.analysis.readFile.path}
          variant="unboxed"
        />
      </div>
    )
  }

  if (row.analysis.kind === "search" && !row.failed) {
    return (
      <pre className={OUTPUT_CLASS}>
        {output.split("\n").map((line, index) => {
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

  return (
    <pre className={cn(OUTPUT_CLASS, row.failed && "border-destructive/30 text-destructive")}>
      {output}
    </pre>
  )
}

function CommandRow({
  row,
  index,
  defaultOpen,
  cwd,
}: {
  row: CommandRowView
  index: number
  defaultOpen: boolean
  cwd: string | undefined
}): React.ReactElement {
  const [open, setOpen] = useState(defaultOpen)
  const name = sectionName(row.section)
  const hasOutput = row.section.output !== null && row.section.output !== ""
  const rowLabel = `${name} section: ${row.section.command}`
  const KindIcon = KIND_META[row.analysis.kind].icon
  const rowClass = "group/row flex min-w-0 w-full items-center gap-2 py-2 text-left"

  const content = (
    <>
      <span
        className={cn(
          "w-4 shrink-0 text-right font-mono text-[10px] tabular-nums text-muted-foreground/60",
          row.failed && "text-destructive",
        )}
        aria-hidden="true"
      >
        {index + 1}
      </span>
      <KindIcon className="size-3 shrink-0 text-muted-foreground" aria-label={KIND_META[row.analysis.kind].label} />
      <Badge
        variant="outline"
        className={cn("h-5 shrink-0 px-1.5 font-mono text-[10px] text-muted-foreground", row.failed && CHIP_TONE_CLASS.failed)}
      >
        {name}
      </Badge>
      <code className="min-w-0 flex-1 truncate font-mono text-xs text-foreground/85">
        <CommandText command={row.section.command} paths={row.analysis.paths} cwd={cwd} />
      </code>
      {row.analysis.readFile?.from && (
        <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground/60">
          L{row.analysis.readFile.from}–{row.analysis.readFile.to}
        </span>
      )}
      <span className={cn("shrink-0 text-[10px] tabular-nums text-muted-foreground", row.failed && "font-medium text-destructive")}>
        {row.failed ? "failed" : outputSummary(row)}
      </span>
      <ChevronRight
        className={cn(
          "size-3 shrink-0 text-muted-foreground/60 transition-transform",
          open && "rotate-90",
          !hasOutput && "invisible",
        )}
        aria-hidden="true"
      />
    </>
  )

  if (!hasOutput) {
    return <div className={rowClass} aria-label={rowLabel}>{content}</div>
  }

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger
        nativeButton={false}
        render={<div role="button" tabIndex={0} />}
        className={cn(rowClass, "cursor-pointer rounded-sm hover:bg-muted/40")}
        aria-label={rowLabel}
      >
        {content}
      </CollapsibleTrigger>
      <CollapsibleContent>
        <CommandOutput row={row} cwd={cwd} />
      </CollapsibleContent>
    </Collapsible>
  )
}

function kindSummary(rows: CommandRowView[]): string {
  const counts = new Map<SectionKind, number>()
  for (const { analysis } of rows) counts.set(analysis.kind, (counts.get(analysis.kind) ?? 0) + 1)
  return KIND_ORDER.filter((kind) => counts.has(kind))
    .map((kind) => {
      const count = counts.get(kind) ?? 0
      return `${count} ${count === 1 ? KIND_META[kind].label : KIND_META[kind].plural}`
    })
    .join(" · ")
}

function CallMeta({ call, index }: { call: BashCallView; index: number }): React.ReactElement {
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 pb-1 pt-2 text-[11px] text-muted-foreground">
      <span className="font-medium text-foreground/70">Call {index + 1}</span>
      {call.description && <span>{call.description}</span>}
      {call.options.map((option) => (
        <span key={option} className="font-mono text-[10px] text-muted-foreground/70">{option}</span>
      ))}
    </div>
  )
}

export function BashCommandCard({
  toolCalls,
  cwd,
  expandAll = false,
  isAgentActive = false,
}: {
  toolCalls: ToolCall[]
  cwd?: string
  expandAll?: boolean
  isAgentActive?: boolean
}): React.ReactElement {
  const calls = useMemo(
    () => toolCalls.map((toolCall) => toCallView(toolCall, isAgentActive)),
    [isAgentActive, toolCalls],
  )
  const rows = calls.flatMap((call) => call.rows)
  const commandCount = rows.length
  const totalLines = rows.reduce((sum, row) => sum + lineCount(row.section.output), 0)
  const failed = rows.filter((row) => row.failed).length
  const notRun = rows.filter((row) => row.section.output === null && !row.pending).length
  const [copied, copyCommands] = useCopyWithFeedback()
  const allCommands = calls.map((call) => call.command).join("\n\n")
  const singleDescription = calls.length === 1 ? calls[0].description : undefined
  const singleOptions = calls.length === 1 ? calls[0].options : []

  return (
    <Card size="sm" className="mt-1.5 min-w-0" role="region" aria-label={commandCount === 1 ? "Bash command" : "Bash commands"}>
      <CardHeader>
        <CardTitle className="flex min-w-0 items-center gap-2">
          <Terminal className="size-4 text-muted-foreground" aria-hidden="true" />
          {commandCount} {commandCount === 1 ? "command" : "commands"}
        </CardTitle>
        <CardDescription className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 [overflow-wrap:anywhere]">
          {calls.length > 1 && <span>{calls.length} calls</span>}
          <span>{kindSummary(rows)}</span>
          {singleDescription && <span className="text-foreground/70">{singleDescription}</span>}
          {singleOptions.map((option) => (
            <span key={option} className="font-mono text-[10px] text-muted-foreground/70">{option}</span>
          ))}
          <span className="ml-auto tabular-nums">
            {totalLines} {totalLines === 1 ? "line" : "lines"}
            {failed > 0 && <span className="font-medium text-destructive"> · {failed} failed</span>}
            {notRun > 0 && <span> · {notRun} not run</span>}
          </span>
        </CardDescription>
        <CardAction>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            onClick={() => copyCommands(allCommands)}
            aria-label={copied ? "Commands copied" : commandCount === 1 ? "Copy command" : "Copy commands"}
            title={copied ? "Copied" : commandCount === 1 ? "Copy command" : "Copy commands"}
          >
            {copied ? <Check data-icon="inline-start" aria-hidden="true" /> : <Copy data-icon="inline-start" aria-hidden="true" />}
          </Button>
        </CardAction>
      </CardHeader>
      <CardContent>
        <div aria-label="Command sections">
          {calls.map((call, callIndex) => {
            const rowOffset = calls.slice(0, callIndex).reduce((sum, item) => sum + item.rows.length, 0)
            return (
              <div key={call.toolCall.id}>
                {callIndex > 0 && <Separator />}
                {calls.length > 1 && <CallMeta call={call} index={callIndex} />}
                {call.rows.map((row, rowIndex) => (
                  <CommandRow
                    key={rowIndex}
                    row={row}
                    index={rowOffset + rowIndex}
                    defaultOpen={expandAll}
                    cwd={cwd}
                  />
                ))}
              </div>
            )
          })}
        </div>
      </CardContent>
    </Card>
  )
}
