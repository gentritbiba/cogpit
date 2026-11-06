import { useEffect, useLayoutEffect, useRef, useState } from "react"
import { CircleAlert, Code, Maximize2, RotateCcw } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog"
import { Spinner } from "@/components/ui/Spinner"
import { cn } from "@/lib/utils"
import { activeComposer } from "@/plugins/composerBridge"
import { usePluginPresentation } from "@/plugins/runtimeContext"
import type { ViewTheme } from "../../../../../shared/views/frame"
import { VIEW_SHELL_PATH } from "../../../../../shared/views/shell"
import { readViewMessage } from "./document"
import type { ViewLibrary } from "./libraries"

export const DEFAULT_VIEW_HEIGHT = 280
const MIN_HEIGHT = 48
const MAX_HEIGHT = 1600
const LOAD_TIMEOUT_MS = 15_000

/** A view ready to post into the sandbox once it answers: its page for a theme, and the library code it loads. */
export interface PreparedView {
  compose: (theme: ViewTheme) => string
  libraries: ViewLibrary[]
}

/** Adds `text` to the end of the open composer's draft for the user to send. */
function askInComposer(text: string): void {
  const composer = activeComposer()
  if (!composer) return
  const { draft, token } = composer.snapshot()
  const typed = draft.text.trimEnd()
  composer.replace({ ...draft, text: typed ? `${typed}\n\n${text}` : text }, token)
  composer.focus()
}

/**
 * A view drawn in a sandbox that has no origin and no network. Mounted once
 * per view: `prepare` is read when the frame mounts, and a new view gets a new key.
 */
export function ViewFrame({ prepare, title, fill = false, onError }: { prepare: () => Promise<PreparedView>; title: string; fill?: boolean; onError: (message: string) => void }) {
  const frame = useRef<HTMLIFrameElement>(null)
  const { theme } = usePluginPresentation()
  const latest = useRef<{ theme: ViewTheme; onError: (message: string) => void }>({ theme, onError })
  const [height, setHeight] = useState(DEFAULT_VIEW_HEIGHT)
  const [state, setState] = useState<"loading" | "ready" | "failed">("loading")
  const [prepared] = useState(() => {
    const promise = prepare()
    promise.catch(() => {})
    return promise
  })
  useLayoutEffect(() => { latest.current = { theme, onError } })

  useLayoutEffect(() => {
    let disposed = false
    let answered = false
    const onMessage = (event: MessageEvent) => {
      const target = frame.current?.contentWindow
      if (!target || event.source !== target) return
      const message = readViewMessage(event.data)
      if (!message) return
      switch (message.type) {
        case "ready":
          answered = true
          prepared.then(({ compose, libraries }) => {
            if (disposed) return
            target.postMessage({ type: "cogpit-view:render", html: compose(latest.current.theme), libraries }, "*")
            setState("ready")
          }, (failure: unknown) => {
            if (disposed) return
            setState("failed")
            latest.current.onError(failure instanceof Error ? failure.message : String(failure))
          })
          return
        case "resize":
          setHeight(Math.min(MAX_HEIGHT, Math.max(MIN_HEIGHT, message.height)))
          return
        case "error":
          latest.current.onError(message.message)
          return
      }
      // Leaving the view needs the user's hand on it: the parent sees the frame focused only after a click inside.
      if (document.activeElement !== frame.current) return
      if (message.type === "open") window.open(message.href, "_blank", "noopener,noreferrer")
      else askInComposer(message.text)
    }
    window.addEventListener("message", onMessage)
    const timeout = window.setTimeout(() => { if (!answered && !disposed) setState("failed") }, LOAD_TIMEOUT_MS)
    return () => {
      disposed = true
      window.removeEventListener("message", onMessage)
      window.clearTimeout(timeout)
    }
  }, [prepared])

  useEffect(() => {
    if (state === "ready") frame.current?.contentWindow?.postMessage({ type: "cogpit-view:theme", theme }, "*")
  }, [theme, state])

  if (state === "failed") return <p role="alert" className="p-3 text-xs text-destructive">This view could not load. Show its source to read it.</p>
  return (
    <div className={cn("relative", fill && "h-full")}>
      {state === "loading" && <div className="absolute inset-0 grid place-items-center text-muted-foreground"><Spinner className="size-4" /></div>}
      <iframe
        ref={frame} title={title} src={VIEW_SHELL_PATH} sandbox="allow-scripts" referrerPolicy="no-referrer"
        className={cn("block w-full border-0", state !== "ready" && "invisible")}
        style={{ height: fill ? "100%" : height }}
      />
    </div>
  )
}

/** The error a running view reported, with a way to ask the agent to fix it when a composer is open. */
export function ViewErrorLine({ error, title, fixHint }: { error: string; title: string; fixHint?: string }) {
  return (
    <div role="alert" className="flex items-center gap-2 border-t border-border/70 py-1 pr-1.5 pl-3 text-xs text-destructive">
      <CircleAlert className="size-3.5 shrink-0" aria-hidden="true" />
      <span className="min-w-0 flex-1 truncate" title={error}>{error}</span>
      {activeComposer() && (
        <Button type="button" variant="ghost" size="xs" onClick={() => askInComposer(`The interactive view "${title}"${fixHint ? ` (${fixHint})` : ""} shows this error: ${error}\nPlease fix it.`)}>
          Ask to fix
        </Button>
      )}
    </div>
  )
}

/** The view filling a large dialog, mounted only while open. */
export function ViewExpandDialog({ open, onOpenChange, title, prepareKey, prepare, onError }: {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  prepareKey: string
  prepare: () => Promise<PreparedView>
  onError: (message: string) => void
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex h-[88vh] w-[min(1280px,96vw)] max-w-none flex-col gap-3 p-4 sm:max-w-none">
        <DialogTitle className="pr-8 text-sm">{title}</DialogTitle>
        <div className="min-h-0 flex-1 overflow-hidden rounded-lg border border-border">
          {open && <ViewFrame key={prepareKey} prepare={prepare} title={title} fill onError={onError} />}
        </div>
      </DialogContent>
    </Dialog>
  )
}

/** What a view's source, reload and expand buttons change, shared by the reply card and the panel. */
export function useViewControls() {
  const [showSource, setShowSource] = useState(false)
  const [expanded, setExpanded] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [generation, setGeneration] = useState(0)
  const reload = () => {
    setError(null)
    setShowSource(false)
    setGeneration((value) => value + 1)
  }
  return { showSource, setShowSource, expanded, setExpanded, error, setError, generation, reload }
}

type ViewControls = ReturnType<typeof useViewControls>

export function ViewSourceToggle({ controls: { showSource, setShowSource } }: { controls: ViewControls }) {
  return (
    <Button
      type="button" variant="ghost" size="icon-xs" className="text-muted-foreground"
      aria-pressed={showSource} aria-label="Show source" title={showSource ? "Show the view" : "Show source"}
      onClick={() => setShowSource((shown) => !shown)}
    >
      <Code data-icon="icon" />
    </Button>
  )
}

export function ViewRunButtons({ controls: { reload, setExpanded }, disabled = false }: { controls: ViewControls; disabled?: boolean }) {
  return (
    <>
      <Button
        type="button" variant="ghost" size="icon-xs" className="text-muted-foreground" aria-label="Reload view" title="Reload" disabled={disabled}
        onClick={reload}
      >
        <RotateCcw data-icon="icon" />
      </Button>
      <Button
        type="button" variant="ghost" size="icon-xs" className="text-muted-foreground" aria-label="Expand view" title="Expand" disabled={disabled}
        onClick={() => setExpanded(true)}
      >
        <Maximize2 data-icon="icon" />
      </Button>
    </>
  )
}
