import { useState, useEffect, useMemo, useCallback, memo } from "react"
import { ChevronsUpDown, Maximize2, Minus, Plus } from "lucide-react"
import { cn } from "@/lib/utils"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog"
import { getHighlighter, ensureLang, getLangFromPath, type ThemedToken } from "@/lib/shiki"
import { useIsDarkMode } from "@/hooks/useIsDarkMode"

// ── Simple line-level diff (LCS-based) ─────────────────────────────────────

interface DiffLine {
  type: "added" | "removed" | "unchanged"
  text: string
  oldIdx?: number
  newIdx?: number
}

function computeDiff(oldStr: string, newStr: string): DiffLine[] {
  const oldLines = oldStr.split("\n")
  const newLines = newStr.split("\n")
  const m = oldLines.length
  const n = newLines.length

  // Trim common prefix/suffix — typical edits share 90%+ lines,
  // so this dramatically shrinks the LCS matrix.
  let prefix = 0
  while (prefix < m && prefix < n && oldLines[prefix] === newLines[prefix]) prefix++
  let suffix = 0
  while (
    suffix < m - prefix &&
    suffix < n - prefix &&
    oldLines[m - 1 - suffix] === newLines[n - 1 - suffix]
  ) suffix++

  const om = m - prefix - suffix
  const on = n - prefix - suffix

  const result: DiffLine[] = []

  // Prefix unchanged lines
  for (let k = 0; k < prefix; k++) {
    result.push({ type: "unchanged", text: oldLines[k], oldIdx: k, newIdx: k })
  }

  if (om === 0 && on === 0) {
    // No middle — just prefix+suffix
  } else if (om === 0) {
    for (let k = 0; k < on; k++) {
      result.push({ type: "added", text: newLines[prefix + k], newIdx: prefix + k })
    }
  } else if (on === 0) {
    for (let k = 0; k < om; k++) {
      result.push({ type: "removed", text: oldLines[prefix + k], oldIdx: prefix + k })
    }
  } else {
    // LCS only on the changed middle section
    const dp: number[][] = Array.from({ length: om + 1 }, () => Array(on + 1).fill(0))
    for (let i = 1; i <= om; i++) {
      const oldLine = oldLines[prefix + i - 1]
      for (let j = 1; j <= on; j++) {
        if (oldLine === newLines[prefix + j - 1]) {
          dp[i][j] = dp[i - 1][j - 1] + 1
        } else {
          dp[i][j] = dp[i - 1][j] > dp[i][j - 1] ? dp[i - 1][j] : dp[i][j - 1]
        }
      }
    }

    // Backtrack middle section
    const middle: DiffLine[] = []
    let i = om, j = on
    while (i > 0 || j > 0) {
      if (i > 0 && j > 0 && oldLines[prefix + i - 1] === newLines[prefix + j - 1]) {
        middle.push({ type: "unchanged", text: oldLines[prefix + i - 1], oldIdx: prefix + i - 1, newIdx: prefix + j - 1 })
        i--; j--
      } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
        middle.push({ type: "added", text: newLines[prefix + j - 1], newIdx: prefix + j - 1 })
        j--
      } else {
        middle.push({ type: "removed", text: oldLines[prefix + i - 1], oldIdx: prefix + i - 1 })
        i--
      }
    }
    middle.reverse()
    for (let k = 0; k < middle.length; k++) result.push(middle[k])
  }

  // Suffix unchanged lines
  for (let k = 0; k < suffix; k++) {
    const oi = m - suffix + k
    const ni = n - suffix + k
    result.push({ type: "unchanged", text: oldLines[oi], oldIdx: oi, newIdx: ni })
  }

  return result
}

// ── Syntax highlighting hook ────────────────────────────────────────────────

type TokenizedLines = ThemedToken[][]

function useHighlightedTokens(
  oldStr: string,
  newStr: string,
  filePath: string,
  isDark: boolean
): { oldTokens: TokenizedLines | null; newTokens: TokenizedLines | null } {
  const [oldTokens, setOldTokens] = useState<TokenizedLines | null>(null)
  const [newTokens, setNewTokens] = useState<TokenizedLines | null>(null)

  useEffect(() => {
    const lang = getLangFromPath(filePath)
    if (!lang) {
      setOldTokens(null)
      setNewTokens(null)
      return
    }

    const theme = isDark ? "github-dark" : "github-light"
    let cancelled = false
    getHighlighter()
      .then(async (hl) => {
        if (cancelled) return
        await ensureLang(hl, lang)
        if (cancelled) return
        const oldResult = hl.codeToTokens(oldStr, { lang, theme })
        const newResult = hl.codeToTokens(newStr, { lang, theme })
        setOldTokens(oldResult.tokens)
        setNewTokens(newResult.tokens)
      })
      .catch((err) => {
        console.warn("[EditDiffView] highlight failed:", err)
        if (!cancelled) {
          setOldTokens(null)
          setNewTokens(null)
        }
      })

    return () => {
      cancelled = true
    }
  }, [oldStr, newStr, filePath, isDark])

  return { oldTokens, newTokens }
}

// ── Diff line style lookups ─────────────────────────────────────────────────

const LINE_BG: Record<DiffLine["type"], string> = {
  removed: "bg-red-50 dark:bg-red-950/40",
  added: "bg-green-50 dark:bg-green-950/40",
  unchanged: "",
}

const GUTTER_STYLE: Record<DiffLine["type"], string> = {
  removed: "text-red-500/50 border-red-500/20",
  added: "text-green-500/50 border-green-500/20",
  unchanged: "text-muted-foreground border-border/40",
}

const PLAIN_TEXT_STYLE: Record<DiffLine["type"], string> = {
  removed: "text-red-700 dark:text-red-300",
  added: "text-green-700 dark:text-green-300",
  unchanged: "text-muted-foreground",
}

// ── Token rendering ─────────────────────────────────────────────────────────

function renderTokens(tokens: ThemedToken[], dimmed?: boolean): React.ReactElement[] {
  return tokens.map((token, i) => (
    <span
      key={i}
      style={{ color: token.color }}
      className={cn(dimmed && "opacity-50")}
    >
      {token.content}
    </span>
  ))
}

/** Resolve the correct token line for a diff line based on its type */
function resolveTokens(
  line: DiffLine,
  oldTokens: TokenizedLines | null,
  newTokens: TokenizedLines | null
): ThemedToken[] | undefined {
  switch (line.type) {
    case "removed":
      return oldTokens?.[line.oldIdx ?? -1]
    case "added":
      return newTokens?.[line.newIdx ?? -1]
    case "unchanged":
      return newTokens?.[line.newIdx ?? -1] ?? oldTokens?.[line.oldIdx ?? -1]
  }
}

// ── Gutter icon ─────────────────────────────────────────────────────────────

function GutterIcon({ type }: { type: DiffLine["type"] }): React.ReactElement {
  switch (type) {
    case "removed": return <Minus className="w-3 h-3 inline" />
    case "added":   return <Plus className="w-3 h-3 inline" />
    default:        return <span className="text-[9px]">&nbsp;</span>
  }
}

// ── Context collapsing ──────────────────────────────────────────────────────

const CONTEXT_LINES = 3

type CollapsedItem =
  | { kind: "line"; line: DiffLine; originalIdx: number }
  | { kind: "separator"; count: number; fromIdx: number; toIdx: number }

function collapseUnchangedLines(lines: DiffLine[]): CollapsedItem[] {
  if (lines.length === 0) return []

  const changedIndices = new Set<number>()
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].type !== "unchanged") changedIndices.add(i)
  }

  if (changedIndices.size === 0 || lines.length <= CONTEXT_LINES * 2 + 3) {
    return lines.map((line, i) => ({ kind: "line" as const, line, originalIdx: i }))
  }

  const visible = new Set<number>()
  for (const ci of changedIndices) {
    for (let j = Math.max(0, ci - CONTEXT_LINES); j <= Math.min(lines.length - 1, ci + CONTEXT_LINES); j++) {
      visible.add(j)
    }
  }

  const result: CollapsedItem[] = []
  let i = 0
  while (i < lines.length) {
    if (visible.has(i)) {
      result.push({ kind: "line", line: lines[i], originalIdx: i })
      i++
    } else {
      const fromIdx = i
      let count = 0
      while (i < lines.length && !visible.has(i)) {
        count++
        i++
      }
      result.push({ kind: "separator", count, fromIdx, toIdx: i - 1 })
    }
  }

  return result
}

function CollapsedSeparator({ count, onExpand }: { count: number; onExpand: () => void }) {
  return (
    <button
      onClick={onExpand}
      className="flex items-center w-full gap-2 px-2 py-0.5 text-[9px] text-muted-foreground/50 hover:text-muted-foreground hover:bg-elevation-2/50 transition-colors cursor-pointer select-none"
    >
      <ChevronsUpDown className="size-2.5 shrink-0" />
      <span className="font-mono">{count} unchanged lines</span>
      <span className="flex-1 border-b border-border/20" />
    </button>
  )
}

// ── Diff rendering ──────────────────────────────────────────────────────────

const DiffLineRow = memo(function DiffLineRow({
  line,
  lineNum,
  oldTokens,
  newTokens,
}: {
  line: DiffLine
  lineNum: number
  oldTokens: TokenizedLines | null
  newTokens: TokenizedLines | null
}): React.ReactElement {
  const tokens = resolveTokens(line, oldTokens, newTokens)
  return (
    <div className={cn("flex", LINE_BG[line.type])}>
      <span className={cn("select-none shrink-0 w-8 text-right pr-1 text-[9px] leading-[1.95] border-r tabular-nums", GUTTER_STYLE[line.type])}>
        {lineNum}
      </span>
      <span className={cn("select-none shrink-0 w-5 text-right pr-1 border-r", GUTTER_STYLE[line.type])}>
        <GutterIcon type={line.type} />
      </span>
      <span className="pl-2 whitespace-pre">
        {tokens ? (
          renderTokens(tokens, line.type === "unchanged")
        ) : (
          <span className={PLAIN_TEXT_STYLE[line.type]}>
            {line.text || "\u00A0"}
          </span>
        )}
        {tokens && tokens.length === 0 && "\u00A0"}
      </span>
    </div>
  )
})

function DiffLines({
  lines,
  oldTokens,
  newTokens,
  compact,
  startLine = 1,
}: {
  lines: DiffLine[]
  oldTokens: TokenizedLines | null
  newTokens: TokenizedLines | null
  compact?: boolean
  /** 1-based starting line offset for real file line numbers. */
  startLine?: number
}): React.ReactElement {
  const [expandedSeparators, setExpandedSeparators] = useState<Set<number>>(new Set())
  const collapsed = useMemo(() => collapseUnchangedLines(lines), [lines])

  const handleExpand = useCallback((fromIdx: number) => {
    setExpandedSeparators((prev) => new Set(prev).add(fromIdx))
  }, [])

  return (
    <div
      className={cn(
        "font-mono text-[11px] leading-[1.6] overflow-x-auto",
        compact && "max-h-64 overflow-y-auto"
      )}
    >
      {collapsed.map((item, idx) => {
        if (item.kind === "separator") {
          if (expandedSeparators.has(item.fromIdx)) {
            return lines.slice(item.fromIdx, item.toIdx + 1).map((line, j) => {
              const lineIdx = item.fromIdx + j
              return (
                <DiffLineRow
                  key={`exp-${lineIdx}`}
                  line={line}
                  lineNum={
                    line.type === "removed"
                      ? (line.oldIdx ?? 0) + startLine
                      : (line.newIdx ?? 0) + startLine
                  }
                  oldTokens={oldTokens}
                  newTokens={newTokens}
                />
              )
            })
          }
          return <CollapsedSeparator key={`sep-${idx}`} count={item.count} onExpand={() => handleExpand(item.fromIdx)} />
        }

        const { line } = item
        const lineNum = line.type === "removed"
          ? (line.oldIdx ?? 0) + startLine
          : (line.newIdx ?? 0) + startLine

        return (
          <DiffLineRow
            key={idx}
            line={line}
            lineNum={lineNum}
            oldTokens={oldTokens}
            newTokens={newTokens}
          />
        )
      })}
    </div>
  )
}

// ── Stat summary ────────────────────────────────────────────────────────────

function DiffStats({ lines }: { lines: DiffLine[] }): React.ReactElement {
  const { added, removed } = useMemo(() => {
    let added = 0
    let removed = 0
    for (const l of lines) {
      if (l.type === "added") added++
      else if (l.type === "removed") removed++
    }
    return { added, removed }
  }, [lines])
  return (
    <span className="text-[10px] text-muted-foreground font-mono">
      {removed > 0 && <span className="text-red-400">-{removed}</span>}
      {removed > 0 && added > 0 && " "}
      {added > 0 && <span className="text-green-400">+{added}</span>}
    </span>
  )
}

// ── Main component ──────────────────────────────────────────────────────────

interface EditDiffViewProps {
  oldString: string
  newString: string
  filePath: string
  /** When false, shows expanded diff without height cap or modal. Default true. */
  compact?: boolean
  /** 1-based starting line number for real file line numbers. Default 1. */
  startLine?: number
}

export function EditDiffView({
  oldString,
  newString,
  filePath,
  compact: isCompact = true,
  startLine = 1,
}: EditDiffViewProps): React.ReactElement {
  const [modalOpen, setModalOpen] = useState(false)
  const isDark = useIsDarkMode()
  const lines = useMemo(() => computeDiff(oldString, newString), [oldString, newString])
  const { oldTokens, newTokens } = useHighlightedTokens(
    oldString,
    newString,
    filePath,
    isDark
  )

  const shortPath = filePath.split("/").slice(-3).join("/")

  return (
    <>
      <div className={cn(
        "rounded border border-border/40 bg-elevation-1 overflow-hidden",
        isCompact && "mt-1.5"
      )}>
        <div className="flex items-center justify-between px-2 py-1 border-b border-border/40 bg-elevation-1">
          <span className="text-[10px] text-muted-foreground font-mono truncate">
            {shortPath}
          </span>
          <div className="flex items-center gap-2">
            <DiffStats lines={lines} />
            {isCompact && (
              <button
                onClick={() => setModalOpen(true)}
                className="text-muted-foreground hover:text-foreground transition-colors p-0.5 rounded hover:bg-elevation-2"
                title="Expand diff"
              >
                <Maximize2 className="w-3 h-3" />
              </button>
            )}
          </div>
        </div>
        <DiffLines
          lines={lines}
          oldTokens={oldTokens}
          newTokens={newTokens}
          compact={isCompact}
          startLine={startLine}
        />
      </div>

      {isCompact && (
        <Dialog open={modalOpen} onOpenChange={setModalOpen}>
          <DialogContent className="sm:max-w-4xl max-h-[85vh] flex flex-col bg-elevation-0 border-border/40">
            <DialogHeader>
              <DialogTitle className="font-mono text-sm text-foreground flex items-center gap-3">
                {filePath}
                <DiffStats lines={lines} />
              </DialogTitle>
              <DialogDescription className="sr-only">
                Diff view for edit operation
              </DialogDescription>
            </DialogHeader>
            <div className="flex-1 overflow-auto rounded border border-border/40 bg-elevation-0">
              <DiffLines
                lines={lines}
                oldTokens={oldTokens}
                newTokens={newTokens}
                startLine={startLine}
              />
            </div>
          </DialogContent>
        </Dialog>
      )}
    </>
  )
}
