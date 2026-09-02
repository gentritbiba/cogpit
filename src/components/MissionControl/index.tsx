/**
 * Mission Control — every live session at once, with the ones blocked on the
 * user sorted to the front and answerable in place.
 */

import { startTransition, useCallback, useEffect, useMemo, useState } from "react"
import { Activity, AlertTriangle, LayoutGrid, List, RefreshCw } from "lucide-react"
import { Alert, AlertAction, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Spinner } from "@/components/ui/Spinner"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { cn } from "@/lib/utils"
import { deviceScopedKey } from "@/lib/device"
import { useLocalStorage } from "@/hooks/useLocalStorage"
import { useSessionNames } from "@/hooks/useSessionNames"
import { useProjectNames } from "@/hooks/useProjectNames"
import { useSessionInventory } from "@/contexts/SessionInventoryContext"
import { usePendingHumanInput } from "@/contexts/PendingHumanInputContext"
import { useMissionControl } from "@/hooks/useMissionControl"
import { sessionGroupKey } from "@/components/LiveSessions/sessionListView"
import { runViewTransition } from "@/lib/viewTransitions"
import { SessionCard } from "./SessionCard"
import {
  buildMissionCards,
  countMissionCards,
  filterMissionCards,
  type MissionFilter,
} from "./missionControlView"

/** How often the open grid re-reads the session inventory. */
const INVENTORY_REFRESH_MS = 8_000
const MAX_NATIVE_TRANSITION_CARDS = 12

const EMPTY_HINT = "Start Claude Code, Codex, or Copilot and every session shows up here"

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
    elicitationsBySession,
    dialogsBySession,
    awaitingPlan,
    responding,
    respond,
    answerQuestion,
    answerElicitation,
    answerDialog,
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
      elicitationsBySession,
      dialogsBySession,
      awaitingPlan,
      newlyCompleted,
    }),
    [
      sessions, procBySession, summaries, permissionsBySession, questionsBySession,
      elicitationsBySession, dialogsBySession, awaitingPlan, newlyCompleted,
    ],
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

  function updateGrid(update: () => void): void {
    if (cards.length <= MAX_NATIVE_TRANSITION_CARDS) {
      runViewTransition(update, { kind: "fade" })
    } else {
      startTransition(update)
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex min-h-12 shrink-0 flex-wrap items-center gap-3 border-b px-4 py-2">
        <div className="flex min-w-0 items-center gap-2">
          <h2 className="truncate text-sm font-semibold">Mission Control</h2>
          <Badge variant="secondary">{counts.total}</Badge>
          {counts.needsYou > 0 && (
            <Badge variant="outline" className="border-warning/40 text-warning">
              {counts.needsYou} need you
            </Badge>
          )}
          {counts.failed > 0 && <Badge variant="destructive">{counts.failed} failed</Badge>}
        </div>

        <div className="ml-auto flex items-center gap-2">
          <ToggleGroup
            value={[filter]}
            onValueChange={(values) => {
              const next = values.at(-1) as MissionFilter | undefined
              if (next && next !== filter) {
                updateGrid(() => setFilter(next))
              }
            }}
            variant="outline"
            size="sm"
            spacing={0}
            aria-label="Filter sessions"
          >
            {FILTERS.map((f) => (
              <ToggleGroupItem
                key={f.id}
                value={f.id}
                aria-label={`Show ${f.label.toLowerCase()} sessions`}
              >
                {f.label}
                {f.id === "needs-you" && counts.needsYou > 0 && (
                  <span className="font-mono text-warning">{counts.needsYou}</span>
                )}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>

          <div className="flex items-center gap-1">
            {LAYOUTS.map(({ id, label, Icon }) => (
              <Button
                key={id}
                variant="ghost"
                size="icon-xs"
                aria-label={label}
                aria-pressed={layout === id}
                onClick={() => {
                  if (id !== layout) {
                    updateGrid(() => setLayout(id))
                  }
                }}
                className={cn(layout === id && "bg-accent text-accent-foreground")}
              >
                <Icon data-icon="inline-start" />
              </Button>
            ))}
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label="Refresh Mission Control"
              onClick={refresh}
            >
              <RefreshCw data-icon="inline-start" className={cn(loading && "animate-spin")} />
            </Button>
          </div>
        </div>
      </header>

      <ScrollArea className="flex-1">
        <div className="p-4">
          {error && (
            <Alert variant="destructive" className="mb-4">
              <AlertTriangle />
              <AlertTitle>Mission Control could not refresh</AlertTitle>
              <AlertDescription className="truncate">{error}</AlertDescription>
              <AlertAction>
                <Button variant="outline" size="xs" onClick={refresh}>Retry</Button>
              </AlertAction>
            </Alert>
          )}

          {visible.length === 0 && !loading && (
            <Empty className="min-h-64">
              <EmptyHeader>
                <EmptyMedia variant="icon"><Activity /></EmptyMedia>
                <EmptyTitle>
                  {cards.length === 0 ? "No live sessions" : `Nothing matches "${filter}"`}
                </EmptyTitle>
                <EmptyDescription>
                  {cards.length === 0 ? EMPTY_HINT : "Try a different filter."}
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          )}

          {visible.length === 0 && loading && cards.length === 0 && (
            <div className="flex items-center justify-center gap-2 py-16 text-sm text-muted-foreground">
              <Spinner />
              Loading sessions…
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
                onAnswerElicitation={answerElicitation}
                onChooseDialog={answerDialog}
              />
            ))}
          </div>
        </div>
      </ScrollArea>
    </div>
  )
}
