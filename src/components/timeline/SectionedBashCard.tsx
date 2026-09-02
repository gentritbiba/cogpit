import { useMemo, useState } from "react"
import {
  ChevronRight,
  FileText,
  FolderOpen,
  Layers,
  PenLine,
  Play,
  Search,
  type LucideIcon,
} from "lucide-react"
import { Badge } from "@/components/ui/badge"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { ReadResultHighlighted } from "./ToolCallResult"
import { can } from "@/lib/capabilities"
import { openFile } from "@/lib/fileOpener"
import { cn } from "@/lib/utils"
import {
  analyzeSection,
  type CommandSection,
  type SectionAnalysis,
  type SectionKind,
} from "@/lib/sectionedCommand"

/** Marker label, or the command's leading word when the agent left the marker bare. */
export function sectionName(section: CommandSection): string {
  return section.label || section.command.match(/^[\w.-]+/)?.[0] || "…"
}

export type ChipTone = "muted" | "write" | "failed"

export interface SectionChip {
  name: string
  tone: ChipTone
}

function chipTone({ kind, failed }: SectionAnalysis): ChipTone {
  if (failed) return "failed"
  if (kind === "write") return "write"
  return "muted"
}

/** Header chips: one per section, toned so writes and failures read from the collapsed row. */
export function sectionChips(sections: CommandSection[]): SectionChip[] {
  return sections.map((section) => ({
    name: sectionName(section),
    tone: chipTone(analyzeSection(section)),
  }))
}

export const CHIP_TONE_CLASS: Record<ChipTone, string> = {
  muted: "text-muted-foreground",
  write: "border-foreground/40 text-foreground",
  failed: "border-destructive/40 text-destructive",
}

const KIND_META: Record<SectionKind, { icon: LucideIcon; label: string; plural: string }> = {
  read: { icon: FileText, label: "read", plural: "reads" },
  search: { icon: Search, label: "search", plural: "searches" },
  list: { icon: FolderOpen, label: "list", plural: "lists" },
  run: { icon: Play, label: "run", plural: "runs" },
  write: { icon: PenLine, label: "write", plural: "writes" },
}

const KIND_ORDER: SectionKind[] = ["read", "search", "list", "run", "write"]

function lineCount(output: string | null): number {
  return output ? output.split("\n").length : 0
}

function outputSummary(output: string | null): string {
  if (output === null) return "not reached"
  if (output === "") return "no output"
  const count = lineCount(output)
  return count === 1 ? "1 line" : `${count} lines`
}

// Six hues cycled by section index, so the share bar and the row rail agree
// on which colour means which section without a legend.
const SECTION_HUES = [
  "bg-sky-500/70",
  "bg-violet-500/70",
  "bg-emerald-500/70",
  "bg-amber-500/70",
  "bg-rose-500/70",
  "bg-teal-500/70",
]

function hueFor(index: number): string {
  return SECTION_HUES[index % SECTION_HUES.length]
}

/** Absolute path for the editor, or null when it cannot be resolved from here. */
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
      className="rounded-sm underline decoration-dotted decoration-muted-foreground/60 underline-offset-2 hover:bg-muted hover:text-primary hover:decoration-solid"
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

/** The command with each path-shaped token turned into an editor link. */
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
  "mb-2 ml-[7px] max-h-96 overflow-y-auto whitespace-pre-wrap break-all border-l-2 pl-4 font-mono text-[11px] leading-relaxed text-muted-foreground"

function SectionOutput({
  section,
  analysis,
  cwd,
}: {
  section: CommandSection
  analysis: SectionAnalysis
  cwd: string | undefined
}): React.ReactElement {
  const output = section.output ?? ""

  if (analysis.readFile && !analysis.failed) {
    return (
      <div className={cn(OUTPUT_CLASS, "pl-0 [&_pre]:border-0 [&_pre]:pl-4")}>
        <ReadResultHighlighted
          result={output}
          filePath={analysis.readFile.path}
          expanded
          variant="unboxed"
        />
      </div>
    )
  }

  if (analysis.kind === "search" && !analysis.failed) {
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
    <pre className={cn(OUTPUT_CLASS, analysis.failed && "border-destructive/40 text-destructive")}>
      {output}
    </pre>
  )
}

function ShareBar({ sections }: { sections: CommandSection[] }): React.ReactElement | null {
  const counts = sections.map((section) => lineCount(section.output))
  const total = counts.reduce((sum, count) => sum + count, 0)
  if (total === 0) return null
  return (
    <div
      className="flex h-1.5 w-full gap-px overflow-hidden rounded-full bg-muted"
      role="img"
      aria-label={`Output share: ${sections.map((section, index) => `${sectionName(section)} ${counts[index]}`).join(", ")}`}
    >
      {counts.map((count, index) =>
        count > 0 ? (
          <span
            key={index}
            className={cn("h-full", hueFor(index))}
            style={{ flexGrow: count, flexBasis: 0 }}
            title={`${sectionName(sections[index])}: ${outputSummary(sections[index].output)}`}
          />
        ) : null,
      )}
    </div>
  )
}

/** The numbered dot: grey when the section never ran, red when it failed, else its hue. */
function markerClass(section: CommandSection, analysis: SectionAnalysis, index: number): string {
  if (section.output === null) return "bg-muted-foreground/40"
  if (analysis.failed) return "bg-destructive"
  return hueFor(index)
}

function statusClass(section: CommandSection, analysis: SectionAnalysis): string {
  if (analysis.failed) return "font-medium text-destructive"
  if (section.output === null) return "text-amber-500"
  return "text-muted-foreground"
}

function SectionRow({
  section,
  analysis,
  index,
  defaultOpen,
  cwd,
}: {
  section: CommandSection
  analysis: SectionAnalysis
  index: number
  defaultOpen: boolean
  cwd: string | undefined
}): React.ReactElement {
  const [open, setOpen] = useState(defaultOpen)
  const name = sectionName(section)
  const hasOutput = section.output !== null && section.output !== ""
  const rowLabel = `${name} section: ${section.command}`
  const KindIcon = KIND_META[analysis.kind].icon
  const rowClass = "group/row flex w-full items-center gap-2 py-1.5 pr-2 text-left"

  const row = (
    <>
      <span
        className={cn(
          "flex size-4 shrink-0 items-center justify-center rounded-full font-mono text-[9px] tabular-nums text-background",
          markerClass(section, analysis, index),
        )}
        aria-hidden="true"
      >
        {index + 1}
      </span>
      <KindIcon
        className={cn(
          "size-3 shrink-0",
          analysis.kind === "write" ? "text-foreground" : "text-muted-foreground",
        )}
        aria-label={KIND_META[analysis.kind].label}
      />
      <Badge
        variant="outline"
        className={cn("shrink-0 font-mono text-[10px]", analysis.failed && CHIP_TONE_CLASS.failed)}
      >
        {name}
      </Badge>
      <code className="min-w-0 flex-1 truncate font-mono text-xs text-foreground/90">
        <CommandText command={section.command} paths={analysis.paths} cwd={cwd} />
      </code>
      {analysis.readFile?.from && (
        <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground/70">
          L{analysis.readFile.from}–{analysis.readFile.to}
        </span>
      )}
      <span className={cn("shrink-0 text-[10px] tabular-nums", statusClass(section, analysis))}>
        {analysis.failed ? "failed" : outputSummary(section.output)}
      </span>
      <ChevronRight
        className={cn(
          "size-3 shrink-0 text-muted-foreground transition-transform",
          open && "rotate-90",
          !hasOutput && "invisible",
        )}
        aria-hidden="true"
      />
    </>
  )

  if (!hasOutput) {
    return (
      <div className={rowClass} aria-label={rowLabel}>
        {row}
      </div>
    )
  }

  // Paths inside the row are buttons of their own, so the trigger is a div
  // rather than a nested native button.
  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger
        nativeButton={false}
        render={<div role="button" tabIndex={0} />}
        className={cn(rowClass, "cursor-pointer rounded-sm hover:bg-muted/40")}
        aria-label={rowLabel}
      >
        {row}
      </CollapsibleTrigger>
      <CollapsibleContent>
        <SectionOutput section={section} analysis={analysis} cwd={cwd} />
      </CollapsibleContent>
    </Collapsible>
  )
}

function kindSummary(analyses: SectionAnalysis[]): string {
  const counts = new Map<SectionKind, number>()
  for (const { kind } of analyses) counts.set(kind, (counts.get(kind) ?? 0) + 1)
  return KIND_ORDER.filter((kind) => counts.has(kind))
    .map((kind) => {
      const count = counts.get(kind) ?? 0
      return `${count} ${count === 1 ? KIND_META[kind].label : KIND_META[kind].plural}`
    })
    .join(" · ")
}

export function SectionedBashCard({
  sections,
  description,
  cwd,
  expandAll = false,
}: {
  sections: CommandSection[]
  description?: string
  cwd?: string
  expandAll?: boolean
}): React.ReactElement {
  const analyses = useMemo(() => sections.map(analyzeSection), [sections])
  const totalLines = sections.reduce((sum, section) => sum + lineCount(section.output), 0)
  const unreached = sections.filter((section) => section.output === null).length
  const failed = analyses.filter((analysis) => analysis.failed).length

  return (
    <Card size="sm" className="mt-1.5">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Layers className="size-4" aria-hidden="true" />
          {sections.length} commands in one call
          <span className="ml-auto font-normal tabular-nums text-muted-foreground">
            {totalLines} lines
            {failed > 0 && <span className="font-medium text-destructive"> · {failed} failed</span>}
            {unreached > 0 && <span className="text-amber-500"> · {unreached} not reached</span>}
          </span>
        </CardTitle>
        <CardDescription className="flex flex-wrap gap-x-2">
          <span className="tabular-nums">{kindSummary(analyses)}</span>
          {description && <span className="text-foreground/80">{description}</span>}
        </CardDescription>
        <ShareBar sections={sections} />
      </CardHeader>
      <CardContent>
        <div aria-label="Command sections">
          {sections.map((section, index) => (
            <SectionRow
              key={index}
              section={section}
              analysis={analyses[index]}
              index={index}
              defaultOpen={expandAll}
              cwd={cwd}
            />
          ))}
        </div>
      </CardContent>
    </Card>
  )
}
