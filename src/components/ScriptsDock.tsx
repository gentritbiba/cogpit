import { useState, useMemo, useCallback, memo } from "react"
import { ChevronDown, ChevronRight, Search, Play, Square, Loader2, Plus } from "lucide-react"
import { cn } from "@/lib/utils"
import { useScriptDiscovery, type ScriptEntry } from "@/hooks/useScriptDiscovery"
import { useScriptRunner, type ManagedProcess } from "@/hooks/useScriptRunner"
import type { ProcessEntry } from "@/hooks/useProcessPanel"
import { usePty } from "@/contexts/PtyContext"

// ── Constants ────────────────────────────────────────────────────────────────

const COLLAPSED_KEY = "scripts-dock-collapsed"

// ── ScriptRow ────────────────────────────────────────────────────────────────

function ScriptRow({
  script,
  status,
  onRun,
  onStop,
}: {
  script: ScriptEntry
  status: "running" | "stopped" | "errored" | null
  onRun: () => void
  onStop: () => void
}) {
  const isRunning = status === "running"

  return (
    <button
      className={cn(
        "flex w-full items-center gap-1.5 rounded px-2 py-1 text-[11px] transition-colors",
        "hover:bg-elevation-2 text-left group"
      )}
      onClick={isRunning ? onStop : onRun}
      title={isRunning ? `Stop ${script.name}` : `Run: ${script.command}`}
    >
      {isRunning ? (
        <span className="inline-block size-1.5 rounded-full bg-green-400 shrink-0" />
      ) : status === "errored" ? (
        <span className="inline-block size-1.5 rounded-full bg-red-400 shrink-0" />
      ) : (
        <span className="inline-block size-1.5 shrink-0" />
      )}

      <span className={cn(
        "flex-1 truncate",
        isRunning ? "text-foreground font-medium" : "text-muted-foreground"
      )}>
        {script.name}
      </span>

      <span className={cn(
        "shrink-0 transition-opacity",
        isRunning ? "opacity-100" : "opacity-0 group-hover:opacity-100"
      )}>
        {isRunning ? (
          <Square className="size-3 text-red-400 fill-red-400" />
        ) : (
          <Play className="size-3 text-muted-foreground fill-muted-foreground" />
        )}
      </span>
    </button>
  )
}

// ── ScriptsDock ──────────────────────────────────────────────────────────────

interface ScriptsDockProps {
  projectDir: string | null | undefined
  onScriptStarted?: (entry: ProcessEntry) => void
}

export const ScriptsDock = memo(function ScriptsDock({
  projectDir,
  onScriptStarted,
}: ScriptsDockProps) {
  const [collapsed, setCollapsed] = useState(() => {
    try { return localStorage.getItem(COLLAPSED_KEY) === "true" } catch { return false }
  })
  const [searchOpen, setSearchOpen] = useState(false)
  const [searchQuery, setSearchQuery] = useState("")
  const [showAll, setShowAll] = useState<Set<string>>(new Set())

  const pty = usePty()

  const { scripts, loading } = useScriptDiscovery(projectDir)
  const { runningProcesses, runScript, stopScript } = useScriptRunner(onScriptStarted)

  const toggleCollapsed = useCallback(() => {
    setCollapsed((prev) => {
      const next = !prev
      try { localStorage.setItem(COLLAPSED_KEY, String(next)) } catch { /* ignore */ }
      return next
    })
  }, [])

  const handleNewTerminal = useCallback(() => {
    const cwd = projectDir ?? undefined
    const id = pty.spawnTerminal({ cwd })
    const label = cwd?.replace(/\/+$/, "").split("/").pop() ?? "Terminal"
    onScriptStarted?.({
      id,
      name: label,
      type: "terminal",
      status: "running",
      source: cwd,
    })
  }, [pty, projectDir, onScriptStarted])

  const toggleShowAll = useCallback((dirLabel: string) => {
    setShowAll((prev) => {
      const next = new Set(prev)
      if (next.has(dirLabel)) next.delete(dirLabel)
      else next.add(dirLabel)
      return next
    })
  }, [])

  // Group scripts by directory
  const grouped = useMemo(() => {
    const query = searchQuery.toLowerCase().trim()
    const filtered = query
      ? scripts.filter((s) => s.name.toLowerCase().includes(query) || s.dirLabel.toLowerCase().includes(query))
      : scripts

    const groups = new Map<string, ScriptEntry[]>()
    for (const s of filtered) {
      const existing = groups.get(s.dirLabel) ?? []
      existing.push(s)
      groups.set(s.dirLabel, existing)
    }
    return groups
  }, [scripts, searchQuery])

  const runningLookup = useMemo(() => {
    const lookup = new Map<string, { id: string; status: ManagedProcess["status"] }>()
    for (const [id, proc] of runningProcesses) {
      const key = `${proc.name}:${proc.cwd}`
      lookup.set(key, { id, status: proc.status })
    }
    return lookup
  }, [runningProcesses])

  if (scripts.length === 0 && !loading) return null

  return (
    <div className="flex shrink-0 flex-col border-t border-border/50">
      {/* Header */}
      <div className="flex h-7 shrink-0 items-center gap-1.5 px-2">
        <button
          className="flex items-center gap-1 hover:text-foreground transition-colors"
          onClick={toggleCollapsed}
        >
          {collapsed ? (
            <ChevronRight className="size-3 text-muted-foreground" />
          ) : (
            <ChevronDown className="size-3 text-muted-foreground" />
          )}
          <span className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider">
            Scripts
          </span>
        </button>

        {loading && <Loader2 className="size-3 text-muted-foreground animate-spin" />}

        <div className="flex-1" />

        {!collapsed && (
          <>
            <button
              className="p-0.5 rounded transition-colors text-muted-foreground hover:text-foreground"
              onClick={handleNewTerminal}
              title="New terminal"
            >
              <Plus className="size-3" />
            </button>
            <button
              className={cn(
                "p-0.5 rounded transition-colors",
                searchOpen ? "text-foreground bg-elevation-2" : "text-muted-foreground hover:text-foreground"
              )}
              onClick={() => { setSearchOpen((p) => !p); setSearchQuery("") }}
              title="Search scripts"
            >
              <Search className="size-3" />
            </button>
          </>
        )}
      </div>

      {/* Body */}
      {!collapsed && (
        <div className="max-h-[200px] overflow-y-auto px-1 pb-1">
          {/* Search input */}
          {searchOpen && (
            <div className="px-1 pb-1">
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Filter scripts..."
                className="w-full rounded bg-elevation-2 border border-border/50 px-2 py-0.5 text-[11px] text-foreground placeholder:text-muted-foreground focus:outline-none focus:border-blue-500/50"
                autoFocus
              />
            </div>
          )}

          {/* Grouped script list */}
          {[...grouped.entries()].map(([dirLabel, dirScripts]) => {
            const isShowingAll = showAll.has(dirLabel) || !!searchQuery
            const commonScripts = dirScripts.filter((s) => s.isCommon)
            const otherScripts = dirScripts.filter((s) => !s.isCommon)
            const visibleScripts = isShowingAll ? dirScripts : commonScripts

            // Skip if no visible scripts
            if (visibleScripts.length === 0 && otherScripts.length === 0) return null

            return (
              <div key={dirLabel}>
                {/* Directory label — only show if multiple groups */}
                {grouped.size > 1 && (
                  <div className="px-2 pt-1.5 pb-0.5 text-[9px] font-medium text-muted-foreground uppercase tracking-wider">
                    {dirLabel}
                  </div>
                )}

                {/* Script rows */}
                {(visibleScripts.length > 0 ? visibleScripts : dirScripts.slice(0, 1)).map((script) => {
                  const key = `${script.name}:${script.dir}`
                  const running = runningLookup.get(key)

                  return (
                    <ScriptRow
                      key={`${dirLabel}:${script.name}`}
                      script={script}
                      status={running?.status ?? null}
                      onRun={() => runScript(script.name, script.dir, script.dirLabel)}
                      onStop={() => running && stopScript(running.id)}
                    />
                  )
                })}

                {/* Show all toggle */}
                {!isShowingAll && otherScripts.length > 0 && (
                  <button
                    className="w-full px-2 py-0.5 text-[10px] text-muted-foreground hover:text-foreground text-left"
                    onClick={() => toggleShowAll(dirLabel)}
                  >
                    Show all ({otherScripts.length} more)...
                  </button>
                )}
                {isShowingAll && !searchQuery && otherScripts.length > 0 && (
                  <button
                    className="w-full px-2 py-0.5 text-[10px] text-muted-foreground hover:text-foreground text-left"
                    onClick={() => toggleShowAll(dirLabel)}
                  >
                    Show less
                  </button>
                )}
              </div>
            )
          })}

          {grouped.size === 0 && searchQuery && (
            <div className="px-2 py-2 text-[11px] text-muted-foreground">
              No scripts matching "{searchQuery}"
            </div>
          )}
        </div>
      )}
    </div>
  )
})
