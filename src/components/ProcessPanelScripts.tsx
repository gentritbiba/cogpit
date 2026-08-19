import { memo, useMemo, useState } from "react"
import { Play, Search, Square } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@/components/ui/empty"
import { Input } from "@/components/ui/input"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Separator } from "@/components/ui/separator"
import { Spinner } from "@/components/ui/Spinner"
import { useScriptDiscovery, type ScriptEntry } from "@/hooks/useScriptDiscovery"
import { useScriptRunner, type ManagedProcess } from "@/hooks/useScriptRunner"
import type { ProcessEntry } from "@/hooks/useProcessPanel"
import { cn } from "@/lib/utils"

interface ScriptRowProps {
  script: ScriptEntry
  status: ManagedProcess["status"] | null
  onRun: () => void
  onStop: () => void
}

function ScriptRow({ script, status, onRun, onStop }: ScriptRowProps) {
  const isRunning = status === "running"
  let statusClassName = "bg-transparent"
  if (isRunning) statusClassName = "bg-primary"
  else if (status === "errored") statusClassName = "bg-destructive"

  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      className="group w-full justify-start px-2"
      onClick={isRunning ? onStop : onRun}
      title={isRunning ? `Stop ${script.name}` : `Run: ${script.command}`}
    >
      <span
        className={cn(
          "size-1.5 shrink-0 rounded-full",
          statusClassName,
        )}
      />
      <span className="min-w-0 flex-1 truncate text-left">{script.name}</span>
      {isRunning ? (
        <Square data-icon="inline-end" className="fill-current text-destructive" />
      ) : (
        <Play
          data-icon="inline-end"
          className="opacity-0 text-muted-foreground transition-opacity group-hover:opacity-100"
        />
      )}
    </Button>
  )
}

interface ProcessPanelScriptsProps {
  projectDir?: string | null
  onProcessStarted?: (entry: ProcessEntry) => void
}

export const ProcessPanelScripts = memo(function ProcessPanelScripts({
  projectDir,
  onProcessStarted,
}: ProcessPanelScriptsProps) {
  const [searchOpen, setSearchOpen] = useState(false)
  const [searchQuery, setSearchQuery] = useState("")
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set())
  const { scripts, loading } = useScriptDiscovery(projectDir)
  const { runningProcesses, runScript, stopScript } = useScriptRunner(onProcessStarted)

  const groupedScripts = useMemo(() => {
    const query = searchQuery.trim().toLowerCase()
    const filtered = query
      ? scripts.filter((script) =>
          script.name.toLowerCase().includes(query)
          || script.dirLabel.toLowerCase().includes(query))
      : scripts

    const groups = new Map<string, ScriptEntry[]>()
    for (const script of filtered) {
      const group = groups.get(script.dirLabel) ?? []
      group.push(script)
      groups.set(script.dirLabel, group)
    }
    return groups
  }, [scripts, searchQuery])

  const runningLookup = useMemo(() => {
    const lookup = new Map<string, { id: string; status: ManagedProcess["status"] }>()
    for (const [id, process] of runningProcesses) {
      lookup.set(`${process.name}:${process.cwd}`, { id, status: process.status })
    }
    return lookup
  }, [runningProcesses])

  if (!projectDir || (!loading && scripts.length === 0)) return null

  function toggleGroup(dirLabel: string): void {
    setExpandedGroups((current) => {
      const next = new Set(current)
      if (next.has(dirLabel)) next.delete(dirLabel)
      else next.add(dirLabel)
      return next
    })
  }

  return (
    <>
      <section className="flex w-56 shrink-0 flex-col" aria-label="Scripts">
        <div className="flex h-8 shrink-0 items-center gap-2 px-2">
          <span className="flex-1 text-xs font-medium text-muted-foreground">Scripts</span>
          {loading && <Spinner className="size-3 text-muted-foreground" aria-label="Loading scripts" />}
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label={searchOpen ? "Close script search" : "Search scripts"}
            aria-expanded={searchOpen}
            onClick={() => {
              setSearchOpen((open) => !open)
              setSearchQuery("")
            }}
          >
            <Search />
          </Button>
        </div>

        {searchOpen && (
          <div className="px-2 pb-2">
            <Input
              type="search"
              value={searchQuery}
              onChange={(event) => setSearchQuery(event.target.value)}
              placeholder="Filter scripts..."
              aria-label="Filter scripts"
              className="h-7"
              autoFocus
            />
          </div>
        )}

        <ScrollArea className="min-h-0 flex-1 px-1 pb-1">
          {[...groupedScripts.entries()].map(([dirLabel, groupScripts]) => {
            const showAll = expandedGroups.has(dirLabel) || Boolean(searchQuery)
            const commonScripts = groupScripts.filter((script) => script.isCommon)
            const otherScripts = groupScripts.filter((script) => !script.isCommon)
            const visibleScripts = showAll
              ? groupScripts
              : commonScripts.length > 0
                ? commonScripts
                : groupScripts.slice(0, 1)

            return (
              <div key={dirLabel} className="flex flex-col gap-0.5 pb-1">
                {groupedScripts.size > 1 && (
                  <div className="truncate px-2 pt-1 text-xs text-muted-foreground">
                    {dirLabel}
                  </div>
                )}
                {visibleScripts.map((script) => {
                  const running = runningLookup.get(`${script.name}:${script.dir}`)
                  return (
                    <ScriptRow
                      key={`${dirLabel}:${script.name}`}
                      script={script}
                      status={running?.status ?? null}
                      onRun={() => runScript(script.name, script.dir, script.dirLabel)}
                      onStop={() => {
                        if (running) stopScript(running.id)
                      }}
                    />
                  )
                })}
                {!searchQuery && otherScripts.length > 0 && (
                  <Button
                    type="button"
                    variant="link"
                    size="sm"
                    className="h-auto justify-start px-2 py-1"
                    onClick={() => toggleGroup(dirLabel)}
                  >
                    {showAll ? "Show less" : `Show ${otherScripts.length} more`}
                  </Button>
                )}
              </div>
            )
          })}

          {!loading && groupedScripts.size === 0 && searchQuery && (
            <Empty className="gap-1 p-3">
              <EmptyHeader className="gap-1">
                <EmptyTitle>No matching scripts</EmptyTitle>
                <EmptyDescription>Try another name.</EmptyDescription>
              </EmptyHeader>
            </Empty>
          )}
        </ScrollArea>
      </section>
      <Separator orientation="vertical" />
    </>
  )
})
