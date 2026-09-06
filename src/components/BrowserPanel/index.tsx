import { useCallback, useEffect, useRef, useState } from "react"
import { TriangleAlert, X } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/Spinner"
import { useBrowserSessions, type BrowserActionResult } from "@/hooks/useBrowserSessions"
import { useBrowserSocket } from "@/hooks/useBrowserSocket"
import { useLocalStorage } from "@/hooks/useLocalStorage"
import { DEFAULT_AGENT_KIND } from "@/lib/agents"
import { deviceScopedKey } from "@/lib/device"
import { cn } from "@/lib/utils"
import type { WorkspacePanelProps } from "@/plugin-api"
import { latestBrowserActivity } from "../../../shared/session/browserActivity"
import { AgentCaption } from "./AgentCaption"
import { BrowserEmptyState } from "./BrowserEmptyState"
import { BrowserNavBar } from "./BrowserNavBar"
import { BrowserSessionBar, DEFAULT_BROWSER } from "./BrowserSessionBar"
import { BrowserViewport } from "./BrowserViewport"

/**
 * The Browser panel: one managed browser on screen, streamed over the
 * `/__browser` socket and driveable by hand. The list of browsers comes from
 * the REST hook, the page itself from the socket, and which browser to show
 * from the user — or, while Follow agent is on, from the transcript.
 */

const SESSION_KEY = "browser-panel-session"
const FOLLOW_KEY = "browser-panel-follow"
/** A browser the user just picked outranks the agent for this long. */
const MANUAL_HOLD_MS = 10_000
/** No frame for this long means the page is standing still, not that it broke. */
const STILL_AFTER_MS = 3_000

export function BrowserPanel({ context, active, closePanel }: WorkspacePanelProps) {
  const [selected, setSelected] = useLocalStorage(deviceScopedKey(SESSION_KEY), DEFAULT_BROWSER)
  const [followAgent, setFollowAgent] = useLocalStorage(deviceScopedKey(FOLLOW_KEY), true)
  const [busy, setBusy] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)
  const [dismissed, setDismissed] = useState<string | null>(null)
  const pickedAt = useRef(0)

  const { status, create, remove, stop, installSkill } = useBrowserSessions(active)
  const socket = useBrowserSocket(active ? selected : null)

  const sessions = status?.sessions ?? []
  const activity = latestBrowserActivity(context.session)
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

  function toggleFollow(next: boolean): void {
    // Turning it back on is itself a request to go wherever the agent is.
    if (next) pickedAt.current = 0
    setFollowAgent(next)
  }

  const state = socket.state?.state ?? null
  const notInstalled = status?.installed === false || state === "not-installed"
  const live = !notInstalled && state === "live"
  const stopped = !notInstalled && state === "stopped"
  const selectedInfo = sessions.find((session) => session.name === selected) ?? null

  const failure = socket.error ?? actionError
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
        onCreate={create}
        onRemove={(name) => {
          select(DEFAULT_BROWSER)
          void run(() => remove(name))
        }}
        onStop={(name) => void run(() => stop(name))}
        onShowDefault={() => select(DEFAULT_BROWSER)}
        onClose={closePanel}
      />

      {live && (
        <BrowserNavBar
          page={socket.page}
          tabs={socket.tabs}
          followed={socket.followed}
          onNavigate={(url) => send({ type: "navigate", url })}
          onBack={() => send({ type: "back" })}
          onForward={() => send({ type: "forward" })}
          onReload={() => send({ type: "reload" })}
          onFollow={(targetId) => send({ type: "follow", targetId })}
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
          <BrowserEmptyState
            kind="not-installed"
            onInstallSkill={() => installSkill(context.session?.agentKind ?? DEFAULT_AGENT_KIND)}
          />
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
              live
              send={send}
              onSizeChange={handleResize}
            />
            <FramePill lastFrameAt={socket.lastFrameAt} />
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
    </div>
  )
}

/** Whether frames are still arriving. A still page is normal, so it says so plainly. */
function FramePill({ lastFrameAt }: { lastFrameAt: number | null }) {
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1_000)
    return () => clearInterval(timer)
  }, [])

  const streaming = lastFrameAt !== null && now - lastFrameAt < STILL_AFTER_MS
  return (
    <span
      title={streaming ? "Streaming the page as it changes" : "The page has not changed for a few seconds"}
      className={cn(
        "pointer-events-none absolute left-2 top-2 rounded-full px-1.5 py-0.5 text-[10px] font-medium tracking-wide backdrop-blur-sm",
        streaming
          ? "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400"
          : "bg-background/80 text-muted-foreground",
      )}
    >
      {streaming ? "LIVE" : "IDLE"}
    </span>
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
