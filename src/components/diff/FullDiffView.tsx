import { useEffect, useState, useMemo } from "react"
import { DiffView, DiffModeEnum } from "@git-diff-view/react"
import { generateDiffFile } from "@git-diff-view/file"
import type { DiffFile } from "@git-diff-view/core"
import { getDiffHighlighter } from "@/lib/diffHighlighter"
import { useIsDarkMode } from "@/hooks/useIsDarkMode"
import { getLangFromPath } from "@/lib/shiki"
import "@git-diff-view/react/styles/diff-view.css"

export interface FullDiffViewProps {
  oldContent: string
  newContent: string
  filePath: string
  mode?: "split" | "unified"
}

// Module-level LRU cache for DiffFile instances
const diffFileCache = new Map<string, DiffFile>()
const MAX_CACHE_SIZE = 50

function getCacheKey(oldContent: string, newContent: string, filePath: string, isDark: boolean): string {
  const oldSample = oldContent.slice(0, 50) + oldContent.slice(-50)
  const newSample = newContent.slice(0, 50) + newContent.slice(-50)
  return `${filePath}:${oldContent.length}:${newContent.length}:${isDark}:${oldSample}:${newSample}`
}

export function FullDiffView({ oldContent, newContent, filePath, mode = "split" }: FullDiffViewProps) {
  const isDark = useIsDarkMode()
  const [diffFile, setDiffFile] = useState<DiffFile | null>(null)
  const [error, setError] = useState<string | null>(null)

  const lang = useMemo(() => getLangFromPath(filePath) ?? "text", [filePath])
  const diffMode = mode === "split" ? DiffModeEnum.Split : DiffModeEnum.Unified

  useEffect(() => {
    let cancelled = false

    async function buildDiff() {
      try {
        const cacheKey = getCacheKey(oldContent, newContent, filePath, isDark)
        const cached = diffFileCache.get(cacheKey)
        if (cached) {
          setDiffFile(cached)
          return
        }

        const file = generateDiffFile(
          filePath, oldContent,
          filePath, newContent,
          lang, lang,
        )

        file.initTheme(isDark ? "dark" : "light")
        file.initRaw()

        // Skip syntax highlighting for very large files (> 10K lines)
        const totalLines = oldContent.split("\n").length + newContent.split("\n").length
        if (totalLines <= 20_000) {
          try {
            const highlighter = await getDiffHighlighter()
            if (cancelled) return
            file.initSyntax({ registerHighlighter: highlighter })
          } catch {
            // Syntax highlighting failed — diff still works without it
          }
        }

        file.buildSplitDiffLines()
        file.buildUnifiedDiffLines()

        if (cancelled) return

        // LRU eviction
        if (diffFileCache.size >= MAX_CACHE_SIZE) {
          const firstKey = diffFileCache.keys().next().value!
          diffFileCache.delete(firstKey)
        }
        diffFileCache.set(cacheKey, file)

        setDiffFile(file)
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err))
      }
    }

    buildDiff()
    return () => { cancelled = true }
  }, [oldContent, newContent, filePath, lang, isDark])

  if (error) {
    return <div className="p-4 text-red-500 text-sm">Failed to render diff: {error}</div>
  }

  if (!diffFile) {
    return <div className="p-4 text-muted-foreground text-sm">Loading diff...</div>
  }

  return (
    <DiffView
      diffFile={diffFile}
      diffViewMode={diffMode}
      diffViewTheme={isDark ? "dark" : "light"}
      diffViewHighlight
      diffViewWrap
      diffViewFontSize={13}
    />
  )
}
