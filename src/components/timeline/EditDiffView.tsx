import { useState, useEffect } from "react"
import { Maximize2, Minus, Plus } from "lucide-react"
import { cn } from "@/lib/utils"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog"
import {
  createHighlighter,
  type BundledLanguage,
  type Highlighter,
  type ThemedToken,
} from "shiki"

// ── Shiki singleton ─────────────────────────────────────────────────────────

let highlighterPromise: Promise<Highlighter> | null = null
const loadedLangs = new Set<string>()

function getHighlighter(): Promise<Highlighter> {
  if (!highlighterPromise) {
    highlighterPromise = createHighlighter({
      themes: ["github-dark"],
      langs: [
        "typescript",
        "tsx",
        "javascript",
        "jsx",
        "json",
        "css",
        "html",
        "python",
        "bash",
        "yaml",
        "markdown",
      ],
    }).then((hl) => {
      for (const l of [
        "typescript", "tsx", "javascript", "jsx", "json",
        "css", "html", "python", "bash", "yaml", "markdown",
      ]) {
        loadedLangs.add(l)
      }
      return hl
    })
  }
  return highlighterPromise
}

async function ensureLang(
  hl: Highlighter,
  lang: BundledLanguage
): Promise<void> {
  if (loadedLangs.has(lang)) return
  await hl.loadLanguage(lang)
  loadedLangs.add(lang)
}

const EXT_TO_LANG: Record<string, string> = {
  ts: "typescript",
  tsx: "tsx",
  js: "javascript",
  jsx: "jsx",
  mjs: "javascript",
  cjs: "javascript",
  mts: "typescript",
  cts: "typescript",
  py: "python",
  rs: "rust",
  go: "go",
  json: "json",
  css: "css",
  scss: "css",
  html: "html",
  htm: "html",
  md: "markdown",
  mdx: "markdown",
  yml: "yaml",
  yaml: "yaml",
  toml: "toml",
  sh: "bash",
  bash: "bash",
  zsh: "bash",
  sql: "sql",
  c: "c",
  h: "c",
  cpp: "cpp",
  cc: "cpp",
  hpp: "cpp",
  java: "java",
  rb: "ruby",
  swift: "swift",
  kt: "kotlin",
  kts: "kotlin",
  php: "php",
  vue: "vue",
  svelte: "svelte",
}

function getLang(filePath: string): BundledLanguage | null {
  const ext = filePath.split(".").pop()?.toLowerCase() ?? ""
  return (EXT_TO_LANG[ext] as BundledLanguage) ?? null
}

// ── Simple line-level diff (LCS-based) ─────────────────────────────────────

interface DiffLine {
  type: "added" | "removed" | "unchanged"
  text: string
  /** Index into the old lines array (for removed/unchanged) */
  oldIdx?: number
  /** Index into the new lines array (for added/unchanged) */
  newIdx?: number
}

function computeDiff(oldStr: string, newStr: string): DiffLine[] {
  const oldLines = oldStr.split("\n")
  const newLines = newStr.split("\n")
  const m = oldLines.length
  const n = newLines.length

  // Build LCS table
  const dp: number[][] = Array.from({ length: m + 1 }, () =>
    Array(n + 1).fill(0)
  )
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (oldLines[i - 1] === newLines[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1] + 1
      } else {
        dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1])
      }
    }
  }

  // Backtrack to produce diff
  const result: DiffLine[] = []
  let i = m
  let j = n
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && oldLines[i - 1] === newLines[j - 1]) {
      result.push({ type: "unchanged", text: oldLines[i - 1], oldIdx: i - 1, newIdx: j - 1 })
      i--
      j--
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      result.push({ type: "added", text: newLines[j - 1], newIdx: j - 1 })
      j--
    } else {
      result.push({ type: "removed", text: oldLines[i - 1], oldIdx: i - 1 })
      i--
    }
  }

  return result.reverse()
}

// ── Syntax highlighting hook ────────────────────────────────────────────────

type TokenizedLines = ThemedToken[][]

function useHighlightedTokens(
  oldStr: string,
  newStr: string,
  filePath: string
): { oldTokens: TokenizedLines | null; newTokens: TokenizedLines | null } {
  const lang = getLang(filePath)
  const [tokens, setTokens] = useState<{ old: TokenizedLines | null; new: TokenizedLines | null }>({ old: null, new: null })

  useEffect(() => {
    if (!lang) return

    let cancelled = false
    getHighlighter()
      .then(async (hl) => {
        if (cancelled) return
        await ensureLang(hl, lang)
        if (cancelled) return
        const oldResult = hl.codeToTokens(oldStr, {
          lang,
          theme: "github-dark",
        })
        const newResult = hl.codeToTokens(newStr, {
          lang,
          theme: "github-dark",
        })
        setTokens({ old: oldResult.tokens, new: newResult.tokens })
      })
      .catch((err) => {
        console.warn("[EditDiffView] highlight failed:", err)
        if (!cancelled) setTokens({ old: null, new: null })
      })

    return () => {
      cancelled = true
    }
  }, [oldStr, newStr, filePath, lang])

  return { oldTokens: lang ? tokens.old : null, newTokens: lang ? tokens.new : null }
}

// ── Token rendering ─────────────────────────────────────────────────────────

function renderTokens(tokens: ThemedToken[], dimmed?: boolean) {
  let offset = 0
  return tokens.map((token) => {
    const tokenKey = offset
    offset += token.content.length
    return (
      <span
        key={tokenKey}
        style={{ color: token.color }}
        className={cn(dimmed && "opacity-50")}
      >
        {token.content}
      </span>
    )
  })
}

// ── Diff rendering ──────────────────────────────────────────────────────────

function DiffLines({
  lines,
  oldTokens,
  newTokens,
  compact,
}: {
  lines: DiffLine[]
  oldTokens: TokenizedLines | null
  newTokens: TokenizedLines | null
  compact?: boolean
}) {
  return (
    <div
      className={cn(
        "font-mono text-[11px] leading-[1.6] overflow-x-auto",
        compact && "max-h-64 overflow-y-auto"
      )}
    >
      {lines.map((line) => {
        // Pick highlighted tokens for this line if available
        const tokens =
          line.type === "removed"
            ? oldTokens?.[line.oldIdx ?? -1]
            : line.type === "added"
              ? newTokens?.[line.newIdx ?? -1]
              : // For unchanged lines, prefer new tokens (same content)
                newTokens?.[line.newIdx ?? -1] ??
                oldTokens?.[line.oldIdx ?? -1]

        return (
          <div
            key={`${line.type}-${line.oldIdx ?? ""}-${line.newIdx ?? ""}`}
            className={cn(
              "flex",
              line.type === "removed" && "bg-red-950/40",
              line.type === "added" && "bg-green-950/40"
            )}
          >
            <span
              className={cn(
                "select-none shrink-0 w-5 text-right pr-1 border-r",
                line.type === "removed"
                  ? "text-red-500/50 border-red-500/20"
                  : line.type === "added"
                    ? "text-green-500/50 border-green-500/20"
                    : "text-zinc-600 border-zinc-800"
              )}
            >
              {line.type === "removed" ? (
                <Minus className="w-3 h-3 inline" />
              ) : line.type === "added" ? (
                <Plus className="w-3 h-3 inline" />
              ) : (
                <span className="text-[9px]">&nbsp;</span>
              )}
            </span>
            <span className="pl-2 whitespace-pre">
              {tokens ? (
                renderTokens(tokens, line.type === "unchanged")
              ) : (
                <span
                  className={cn(
                    line.type === "removed" && "text-red-300",
                    line.type === "added" && "text-green-300",
                    line.type === "unchanged" && "text-zinc-500"
                  )}
                >
                  {line.text || "\u00A0"}
                </span>
              )}
              {/* Render nbsp for empty highlighted lines */}
              {tokens && tokens.length === 0 && "\u00A0"}
            </span>
          </div>
        )
      })}
    </div>
  )
}

// ── Stat summary ────────────────────────────────────────────────────────────

function DiffStats({ lines }: { lines: DiffLine[] }) {
  const added = lines.filter((l) => l.type === "added").length
  const removed = lines.filter((l) => l.type === "removed").length
  return (
    <span className="text-[10px] text-zinc-500 font-mono">
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
}

export function EditDiffView({
  oldString,
  newString,
  filePath,
  compact: isCompact = true,
}: EditDiffViewProps) {
  const [modalOpen, setModalOpen] = useState(false)
  const lines = computeDiff(oldString, newString)
  const { oldTokens, newTokens } = useHighlightedTokens(
    oldString,
    newString,
    filePath
  )

  const shortPath = filePath.split("/").slice(-3).join("/")

  return (
    <>
      {/* Inline diff */}
      <div className={cn(
        "rounded border border-zinc-800 bg-zinc-950/50 overflow-hidden",
        isCompact && "mt-1.5"
      )}>
        <div className="flex items-center justify-between px-2 py-1 border-b border-zinc-800 bg-zinc-900/50">
          <span className="text-[10px] text-zinc-400 font-mono truncate">
            {shortPath}
          </span>
          <div className="flex items-center gap-2">
            <DiffStats lines={lines} />
            {isCompact && (
              <button
                onClick={() => setModalOpen(true)}
                className="text-zinc-500 hover:text-zinc-300 transition-colors p-0.5 rounded hover:bg-zinc-800"
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
        />
      </div>

      {/* Full-screen modal - only in compact mode */}
      {isCompact && (
        <Dialog open={modalOpen} onOpenChange={setModalOpen}>
          <DialogContent className="sm:max-w-4xl max-h-[85vh] flex flex-col bg-zinc-950 border-zinc-800">
            <DialogHeader>
              <DialogTitle className="font-mono text-sm text-zinc-200 flex items-center gap-3">
                {filePath}
                <DiffStats lines={lines} />
              </DialogTitle>
              <DialogDescription className="sr-only">
                Diff view for edit operation
              </DialogDescription>
            </DialogHeader>
            <div className="flex-1 overflow-auto rounded border border-zinc-800 bg-zinc-950">
              <DiffLines
                lines={lines}
                oldTokens={oldTokens}
                newTokens={newTokens}
              />
            </div>
          </DialogContent>
        </Dialog>
      )}
    </>
  )
}
