/**
 * Mission Control — every live session at once, with the ones blocked on the
 * user sorted to the front and answerable in place.
 */

import { useCallback, useEffect, useMemo, useState } from "react"
import { Activity, AlertTriangle, LayoutGrid, List, Loader2, RefreshCw } from "lucide-react"
import { Button } from "@/components/ui/button"
import { ScrollArea } from "@/components/ui/scroll-area"
import { cn } from "@/lib/utils"
import { deviceScopedKey } from "@/lib/device"
import { useLocalStorage } from "@/hooks/useLocalStorage"
import { useSessionNames } from "@/hooks/useSessionNames"
import { useProjectNames } from "@/hooks/useProjectNames"
import { useSessionInventory } from "@/contexts/SessionInventoryContext"
import { usePendingPermissions } from "@/contexts/PendingPermissionsContext"
import { useMissionControl } from "@/hooks/useMissionControl"
import { sessionGroupKey } from "@/components/LiveSessions/sessionListView"
import { SessionCard } from "./SessionCard"
import {
  buildMissionCards,
  countMissionCards,
  filterMissionCards,
  type MissionFilter,
} from "./missionControlView"

/** How often the open grid re-reads the session inventory. */
const INVENTORY_REFRESH_MS = 8_000

const FILTERS: { id: MissionFilter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "running", label: "Running" },
  { id: "needs-you", label: "Needs you" },
  { id: "finished", label: "Finished" },
]

interface MissionControlProps {
  onSelectSession: (dirName: string, fileName: string) => void
}

export function MissionControl({ onSelectSession }: MissionControlProps) {
  const { sessions, procBySession, newlyCompleted, refresh: refreshInventory } =
    useSessionInventory()
  const { summaries, loading, error, refresh: refreshMission } = useMissionControl()
  const {
    bySession: permissionsBySession,
    responding,
    respond,
    refresh: refreshPermissions,
  } = usePendingPermissions()
  const { names: sessionNames } = useSessionNames()
  const { names: projectNames } = useProjectNames()
  const [filter, setFilter] = useState<MissionFilter>("all")
  const [layout, setLayout] = useLocalStorage<"grid" | "list">(
    deviceScopedKey("mission-control-layout"),
    "grid",
  )

  const cards = useMemo(
    () => buildMissionCards({
      sessions,
      procBySession,
      summaries,
      permissionsBySession,
      newlyCompleted,
    }),
    [sessions, procBySession, summaries, permissionsBySession, newlyCompleted],
  )

  const counts = useMemo(() => countMissionCards(cards), [cards])
  const visible = useMemo(() => filterMissionCards(cards, filter), [cards, filter])

  const refresh = useCallback(() => {
    refreshInventory()
    refreshMission()
    refreshPermissions()
  }, [refreshInventory, refreshMission, refreshPermissions])

  // The inventory's own poll is deliberately gentle (20s) because it scans every
  // project and shells out to `ps`. That is too slow here: a session that just
  // blocked on a permission would sit invisible for up to a poll interval, which
  // is exactly the case this view exists to catch. While the grid is open and
  // visible, refresh the inventory on a tighter cadence.
  useEffect(() => {
    const interval = setInterval(() => {
      if (document.visibilityState === "visible") refreshInventory()
    }, INVENTORY_REFRESH_MS)
    return () => clearInterval(interval)
  }, [refreshInventory])

  const handleOpen = useCallback((dirName: string, fileName: string) => {
    onSelectSession(dirName, fileName)
  }, [onSelectSession])

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Toolbar */}
      <div className="flex h-11 shrink-0 items-center gap-2.5 border-b border-border/50 px-4">
        <h2 className="text-[13px] font-semibold tracking-tight">Mission Control</h2>
        <div className="flex items-center gap-2.5 font-mono text-[11px] text-muted-foreground/60">
          {counts.running > 0 && <span className="text-blue-400">{counts.running} running</span>}
          {counts.needsYou > 0 && (
            <span className="text-amber-400">{counts.needsYou} need you</span>
          )}
          {counts.finished > 0 && <span className="text-green-400">{counts.finished} done</span>}
          {counts.failed > 0 && <span className="text-red-400">{counts.failed} failed</span>}
        </div>

        <div className="ml-auto flex items-center gap-2">
          <div className="flex overflow-hidden rounded-md border border-border/60">
            {FILTERS.map((f) => (
              <button
                key={f.id}
                type="button"
                onClick={() => setFilter(f.id)}
                aria-pressed={filter === f.id}
                className={cn(
                  "border-r border-border/60 px-2.5 py-1 text-[11.5px] transition-colors last:border-r-0",
                  filter === f.id
                    ? "bg-elevation-3 text-foreground"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                {f.label}
                {f.id === "needs-you" && counts.needsYou > 0 && (
                  <span className="ml-1 font-mono text-amber-400">{counts.needsYou}</span>
                )}
              </button>
            ))}
          </div>

          <div className="flex items-center gap-0.5">
            <Button
              variant="ghost"
              size="sm"
              className="size-6 p-0"
              aria-label="Grid layout"
              aria-pressed={layout === "grid"}
              onClick={() => setLayout("grid")}
            >
              <LayoutGrid className={cn("size-3.5", layout === "grid" ? "text-foreground" : "text-muted-foreground/50")} />
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="size-6 p-0"
              aria-label="List layout"
              aria-pressed={layout === "list"}
              onClick={() => setLayout("list")}
            >
              <List className={cn("size-3.5", layout === "list" ? "text-foreground" : "text-muted-foreground/50")} />
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="size-6 p-0"
              aria-label="Refresh Mission Control"
              onClick={refresh}
            >
              <RefreshCw className={cn("size-3", loading && "animate-spin")} />
            </Button>
          </div>
        </div>
      </div>

      <ScrollArea className="flex-1">
        <div className="p-4">
          {error && (
            <div className="mb-3 flex items-center gap-2 rounded-md border border-red-900/50 bg-red-950/30 px-3 py-2">
              <AlertTriangle className="size-3.5 shrink-0 text-red-400" />
              <span className="flex-1 truncate text-[11px] text-red-400">{error}</span>
              <button
                type="button"
                onClick={refresh}
                className="shrink-0 text-[11px] text-red-400 hover:text-red-300"
              >
                Retry
              </button>
            </div>
          )}

          {visible.length === 0 && !loading && (
            <div className="py-16 text-center">
              <Activity className="mx-auto mb-2 size-5 text-muted-foreground" />
              <p className="text-[13px] text-muted-foreground">
                {cards.length === 0 ? "No live sessions" : `Nothing matches "${filter}"`}
              </p>
              <p className="mt-1 text-[11px] text-muted-foreground">
                {cards.length === 0
                  ? "Start Claude Code or Codex and every session shows up here"
                  : "Try a different filter"}
              </p>
            </div>
          )}

          {visible.length === 0 && loading && cards.length === 0 && (
            <div className="flex items-center justify-center py-16">
              <Loader2 className="size-5 animate-spin text-muted-foreground" />
            </div>
          )}

          <div
            className={cn(
              "grid gap-3",
              layout === "grid"
                ? "grid-cols-1 md:grid-cols-2 2xl:grid-cols-3"
                : "grid-cols-1",
            )}
          >
            {visible.map((card) => (
              <SessionCard
                key={card.session.sessionId}
                card={card}
                compact={layout === "list"}
                customName={sessionNames[card.session.sessionId]}
                projectLabel={
                  projectNames[card.session.dirName] ?? sessionGroupKey(card.session)
                }
                responding={responding}
                onOpen={() => handleOpen(card.session.dirName, card.session.fileName)}
                onRespond={respond}
              />
            ))}
          </div>
        </div>
      </ScrollArea>
    </div>
  )
}
