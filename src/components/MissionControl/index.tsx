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
import { usePendingHumanInput } from "@/contexts/PendingHumanInputContext"
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

const EMPTY_HINT = "Start Claude Code or Codex and every session shows up here"

type Layout = "grid" | "list"

const FILTERS: { id: MissionFilter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "running", label: "Running" },
  { id: "needs-you", label: "Needs you" },
  { id: "finished", label: "Finished" },
]

const LAYOUTS: { id: Layout; label: string; Icon: typeof LayoutGrid }[] = [
  { id: "grid", label: "Grid layout", Icon: LayoutGrid },
  { id: "list", label: "List layout", Icon: List },
]

interface MissionControlProps {
  onSelectSession: (dirName: string, fileName: string) => void
}

export function MissionControl({ onSelectSession }: MissionControlProps) {
  const { sessions, procBySession, newlyCompleted, refresh: refreshInventory } =
    useSessionInventory()
  const { summaries, loading, error, refresh: refreshMission } = useMissionControl()
  const {
    permissionsBySession,
    questionsBySession,
    responding,
    respond,
    answerQuestion,
    refresh: refreshHumanInput,
  } = usePendingHumanInput()
  // Tool-use ids the server has forgotten, so the card can say so instead of
  // silently doing nothing.
  const [goneQuestions, setGoneQuestions] = useState<Set<string>>(new Set())
  const { names: sessionNames } = useSessionNames()
  const { names: projectNames } = useProjectNames()
  const [filter, setFilter] = useState<MissionFilter>("all")
  const [layout, setLayout] = useLocalStorage<Layout>(
    deviceScopedKey("mission-control-layout"),
    "grid",
  )

  const cards = useMemo(
    () => buildMissionCards({
      sessions,
      procBySession,
      summaries,
      permissionsBySession,
      questionsBySession,
      newlyCompleted,
    }),
    [sessions, procBySession, summaries, permissionsBySession, questionsBySession, newlyCompleted],
  )

  const counts = useMemo(() => countMissionCards(cards), [cards])
  const visible = useMemo(() => filterMissionCards(cards, filter), [cards, filter])

  const refresh = useCallback(() => {
    refreshInventory()
    refreshMission()
    refreshHumanInput()
  }, [refreshInventory, refreshMission, refreshHumanInput])

  // The inventory's own 20s poll is too slow for this view: a session that just
  // blocked on a permission — the case the grid exists to catch — would sit
  // invisible for up to a full interval.
  useEffect(() => {
    const interval = setInterval(() => {
      if (document.visibilityState === "visible") refreshInventory()
    }, INVENTORY_REFRESH_MS)
    return () => clearInterval(interval)
  }, [refreshInventory])

  const handleAnswerQuestion = useCallback(async (
    sessionId: string,
    toolUseId: string,
    answers: Record<string, string>,
  ) => {
    const result = await answerQuestion(sessionId, toolUseId, answers)
    if (!result.ok) setGoneQuestions((prev) => new Set(prev).add(toolUseId))
  }, [answerQuestion])

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-11 shrink-0 items-center gap-2.5 border-b border-border/50 px-4">
        <h2 className="text-[13px] font-semibold tracking-tight">Mission Control</h2>
        <div className="flex items-center gap-2.5 font-mono text-[11px] text-muted-foreground/60">
          {counts.running > 0 && <span className="text-blue-400">{counts.running} running</span>}
          {counts.needsYou > 0 && <span className="text-amber-400">{counts.needsYou} need you</span>}
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
            {LAYOUTS.map(({ id, label, Icon }) => (
              <Button
                key={id}
                variant="ghost"
                size="sm"
                className="size-6 p-0"
                aria-label={label}
                aria-pressed={layout === id}
                onClick={() => setLayout(id)}
              >
                <Icon className={cn("size-3.5", layout === id ? "text-foreground" : "text-muted-foreground/50")} />
              </Button>
            ))}
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
                {cards.length === 0 ? EMPTY_HINT : "Try a different filter"}
              </p>
            </div>
          )}

          {visible.length === 0 && loading && cards.length === 0 && (
            <div className="flex items-center justify-center py-16">
              <Loader2 className="size-5 animate-spin text-muted-foreground" />
            </div>
          )}

          <div className={cn("grid grid-cols-1 gap-3", layout === "grid" && "md:grid-cols-2 2xl:grid-cols-3")}>
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
                goneQuestions={goneQuestions}
                onOpen={() => onSelectSession(card.session.dirName, card.session.fileName)}
                onRespond={respond}
                onAnswerQuestion={handleAnswerQuestion}
              />
            ))}
          </div>
        </div>
      </ScrollArea>
    </div>
  )
}
