import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { TriangleAlert, X } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/Spinner"
import { useBrowserSessions, type BrowserActionResult } from "@/hooks/useBrowserSessions"
import { useBrowserSocket } from "@/hooks/useBrowserSocket"
import { useLocalStorage } from "@/hooks/useLocalStorage"
import { deviceScopedKey } from "@/lib/device"
import type { WorkspacePanelProps } from "@/plugin-api"
import type { BrowserSessionInfo } from "../../../shared/browser/types"
import { latestBrowserActivity } from "../../../shared/session/browserActivity"
import { AgentCaption } from "./AgentCaption"
import { BrowserEmptyState } from "./BrowserEmptyState"
import { BrowserNavBar } from "./BrowserNavBar"
import { BrowserSessionBar, DEFAULT_BROWSER } from "./BrowserSessionBar"
import { BrowserSkillDialog } from "./BrowserSkillDialog"
import { BrowserViewport } from "./BrowserViewport"

/**
 * The Browser panel: one managed browser on screen, streamed over the
 * `/__browser` socket and driveable by hand. The list of browsers comes from
 * the REST hook, the page itself from the socket, and which browser to show
 * from the user — or, while Follow agent is on, from the transcript.
 *
 * A frame re-renders this component thirty times a second, so everything it
 * hands the bars keeps its identity between frames and the bars are memoised.
 */

const SESSION_KEY = "browser-panel-session"
const FOLLOW_KEY = "browser-panel-follow"
/** A browser the user just picked outranks the agent for this long. */
const MANUAL_HOLD_MS = 10_000
/** No frame for this long means the page is standing still, not that it broke. */
const STILL_AFTER_MS = 3_000
const NO_SESSIONS: BrowserSessionInfo[] = []

export function BrowserPanel({ context, active, closePanel }: WorkspacePanelProps) {
  const [selected, setSelected] = useLocalStorage(deviceScopedKey(SESSION_KEY), DEFAULT_BROWSER)
  const [followAgent, setFollowAgent] = useLocalStorage(deviceScopedKey(FOLLOW_KEY), true)
  const [busy, setBusy] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)
  const [dismissed, setDismissed] = useState<string | null>(null)
  const [skillOpen, setSkillOpen] = useState(false)
  const pickedAt = useRef(0)

  const {
    status,
    error: listError,
    create,
    remove,
    stop,
    readSkillTargets,
    installSkill,
  } = useBrowserSessions(active)
  const socket = useBrowserSocket(active ? selected : null)

  const sessions = status?.sessions ?? NO_SESSIONS
  // Walking the transcript per frame would cost more than painting one.
  const activity = useMemo(() => latestBrowserActivity(context.session), [context.session])
  const driven = activity?.session ?? null
  const drivenExists = sessions.some((session) => session.name === driven)

  useEffect(() => {
    if (!followAgent || driven === null || driven === selected || !drivenExists) return
    if (Date.now() - pickedAt.current < MANUAL_HOLD_MS) return
    setSelected(driven)
  }, [followAgent, driven, drivenExists, selected, setSelected])

  const select = useCallback((name: string) => {
    pickedAt.current = Date.now()
    setSelected(name)
  }, [setSelected])

  const run = useCallback(async (action: () => Promise<BrowserActionResult>) => {
    setBusy(true)
    const result = await action()
    setBusy(false)
    if (!result.ok) setActionError(result.error)
  }, [])

  const { send } = socket
  const handleResize = useCallback((width: number, height: number, dpr: number) => {
    send({ type: "viewport", width, height, dpr })
  }, [send])

  const toggleFollow = useCallback((next: boolean) => {
    // Turning it back on is itself a request to go wherever the agent is.
    if (next) pickedAt.current = 0
    setFollowAgent(next)
  }, [setFollowAgent])

  const showDefault = useCallback(() => select(DEFAULT_BROWSER), [select])
  const openSkill = useCallback(() => setSkillOpen(true), [])
  const handleRemove = useCallback((name: string) => {
    select(DEFAULT_BROWSER)
    void run(() => remove(name))
  }, [select, run, remove])
  const handleStop = useCallback((name: string) => void run(() => stop(name)), [run, stop])

  const navigate = useCallback((url: string) => send({ type: "navigate", url }), [send])
  const goBack = useCallback(() => send({ type: "back" }), [send])
  const goForward = useCallback(() => send({ type: "forward" }), [send])
  const reload = useCallback(() => send({ type: "reload" }), [send])
  const follow = useCallback((targetId: string) => send({ type: "follow", targetId }), [send])

  const frameStatus = useFrameStatus(socket.lastFrameAt)
  const state = socket.state?.state ?? null
  const notInstalled = status?.installed === false || state === "not-installed"
  const live = !notInstalled && state === "live"
  const stopped = !notInstalled && state === "stopped"
  const selectedInfo = sessions.find((session) => session.name === selected) ?? null
  // The transport dropped under a page that was live: the last frame is still
  // worth looking at, as long as the panel stops calling it the live one.
  const reconnecting = live && (socket.status === "disconnected" || socket.status === "connecting")

  const failure = socket.error ?? actionError ?? listError
  const problem = failure !== null && failure !== dismissed ? failure : null

  return (
    <div className="flex h-full min-h-0 flex-col">
      <BrowserSessionBar
        sessions={sessions}
        selected={selected}
        currentSessionId={context.session?.sessionId ?? null}
        followAgent={followAgent}
        busy={busy}
        onSelect={select}
        onToggleFollow={toggleFollow}
        onOpenSkill={openSkill}
        onCreate={create}
        onRemove={handleRemove}
        onStop={handleStop}
        onShowDefault={showDefault}
        onClose={closePanel}
      />

      {live && (
        <BrowserNavBar
          page={socket.page}
          tabs={socket.tabs}
          followed={socket.followed}
          status={reconnecting ? "offline" : frameStatus}
          onNavigate={navigate}
          onBack={goBack}
          onForward={goForward}
          onReload={reload}
          onFollow={follow}
        />
      )}

      {problem && (
        <ProblemStrip
          message={problem}
          onDismiss={() => {
            setActionError(null)
            setDismissed(failure)
          }}
        />
      )}

      <div className="relative flex min-h-0 flex-1 flex-col">
        {notInstalled && (
          <BrowserEmptyState kind="not-installed" onOpenSkill={openSkill} />
        )}
        {stopped && (
          <BrowserEmptyState
            kind="stopped"
            name={selected}
            lastUrl={selectedInfo?.lastUrl ?? null}
            onOpen={(url) => send({ type: "launch", url })}
          />
        )}
        {live && (
          <>
            <BrowserViewport
              className="flex-1"
              frame={socket.frame}
              send={send}
              onSizeChange={handleResize}
            />
            {reconnecting && <ReconnectingBanner />}
            <AgentCaption activity={activity && activity.session === selected ? activity : null} />
          </>
        )}
        {!notInstalled && !stopped && !live && (
          <div
            role="status"
            className="flex flex-1 items-center justify-center gap-2 text-sm text-muted-foreground"
          >
            <Spinner />
            Connecting to {selected}…
          </div>
        )}
      </div>

      <BrowserSkillDialog
        open={skillOpen}
        onOpenChange={setSkillOpen}
        readTargets={readSkillTargets}
        install={installSkill}
      />
    </div>
  )
}

/**
 * Whether frames are still arriving. One timeout, armed for the moment the last
 * frame goes stale, rather than a ticker that re-renders the panel every second.
 */
function useFrameStatus(lastFrameAt: number | null): "live" | "idle" {
  const [, expire] = useState(0)

  useEffect(() => {
    if (lastFrameAt === null) return
    const remaining = lastFrameAt + STILL_AFTER_MS - Date.now()
    if (remaining <= 0) return
    const timer = setTimeout(() => expire((tick) => tick + 1), remaining)
    return () => clearTimeout(timer)
  }, [lastFrameAt])

  if (lastFrameAt === null) return "idle"
  return Date.now() - lastFrameAt < STILL_AFTER_MS ? "live" : "idle"
}

/** Said over the last frame, so a frozen page never passes for a live one. */
function ReconnectingBanner() {
  return (
    <div className="pointer-events-none absolute inset-x-0 top-0 flex justify-center p-2">
      <span
        role="status"
        className="rounded-full bg-background/85 px-2.5 py-0.5 text-[11px] text-muted-foreground shadow-xs backdrop-blur-sm"
      >
        Reconnecting…
      </span>
    </div>
  )
}

function ProblemStrip({ message, onDismiss }: { message: string; onDismiss: () => void }) {
  return (
    <div className="flex shrink-0 items-center gap-2 border-b border-destructive/30 bg-destructive/10 px-2 py-1 text-xs text-destructive">
      <TriangleAlert aria-hidden className="size-3.5 shrink-0" />
      <span className="min-w-0 flex-1 truncate">{message}</span>
      <Button variant="ghost" size="icon-xs" aria-label="Dismiss" onClick={onDismiss}>
        <X data-icon="inline-start" />
      </Button>
    </div>
  )
}
