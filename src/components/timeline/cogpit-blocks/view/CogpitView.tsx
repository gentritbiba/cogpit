import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react"
import { AppWindow, CircleAlert, Code, Maximize2, RotateCcw } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog"
import { Spinner } from "@/components/ui/Spinner"
import { cn } from "@/lib/utils"
import { activeComposer } from "@/plugins/composerBridge"
import { usePluginPresentation } from "@/plugins/runtimeContext"
import { VIEW_SHELL_PATH } from "../../../../../shared/viewShell"
import { composeViewDocument, librariesUsed, readViewMessage, viewTitle, type ViewTheme } from "./document"
import { loadViewLibraries } from "./libraries"

const DEFAULT_HEIGHT = 280
const MIN_HEIGHT = 48
const MAX_HEIGHT = 1600
const LOAD_TIMEOUT_MS = 15_000

/** Adds `text` to the end of the open composer's draft for the user to send. */
function askInComposer(text: string): void {
  const composer = activeComposer()
  if (!composer) return
  const { draft, token } = composer.snapshot()
  const typed = draft.text.trimEnd()
  composer.replace({ ...draft, text: typed ? `${typed}\n\n${text}` : text }, token)
  composer.focus()
}

/** True once `element` has come near the viewport; a view keeps running after that. */
function useNearViewport(element: RefObject<HTMLElement | null>): boolean {
  const [near, setNear] = useState(() => typeof IntersectionObserver === "undefined")
  useEffect(() => {
    if (near || !element.current) return
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) setNear(true)
    }, { rootMargin: "600px" })
    observer.observe(element.current)
    return () => observer.disconnect()
  }, [element, near])
  return near
}

/**
 * An interactive page an agent wrote into its reply, drawn in a sandbox that
 * has no origin and no network. Until the reply has closed the block, it
 * shows that the view is still being written.
 */
export default function CogpitView({ source, complete, fallback }: { source: string; complete: boolean; fallback: ReactNode }) {
  const title = viewTitle(source) ?? "Interactive view"
  const [showSource, setShowSource] = useState(false)
  const [expanded, setExpanded] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [generation, setGeneration] = useState(0)
  const container = useRef<HTMLElement>(null)
  const near = useNearViewport(container)

  const body = showSource
    ? <div className="[&>div]:my-0 [&>div]:rounded-none [&>div]:border-0">{fallback}</div>
    : !complete
      ? <p className="flex h-24 items-center justify-center text-xs text-muted-foreground">The view appears when the reply finishes writing it.</p>
      : near
        ? <ViewFrame key={generation} html={source} title={title} onError={setError} />
        : <div style={{ height: DEFAULT_HEIGHT }} />

  return (
    <section ref={container} aria-label={title} data-cogpit-block className="my-3 overflow-hidden rounded-lg border border-border bg-card text-sm">
      <header className="flex items-center gap-1 border-b border-border/70 py-1 pr-1.5 pl-3">
        <AppWindow className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
        <h4 className="ml-1 min-w-0 flex-1 truncate text-[13px] font-medium">{title}</h4>
        {!complete && (
          <span className="mr-1 flex items-center gap-1.5 text-xs text-muted-foreground">
            <Spinner className="size-3" /> Building · {source.split("\n").length} lines
          </span>
        )}
        <Button
          type="button" variant="ghost" size="icon-xs" className="text-muted-foreground"
          aria-pressed={showSource} aria-label="Show source" title={showSource ? "Show the view" : "Show source"}
          onClick={() => setShowSource((shown) => !shown)}
        >
          <Code data-icon="icon" />
        </Button>
        {complete && (
          <>
            <Button
              type="button" variant="ghost" size="icon-xs" className="text-muted-foreground" aria-label="Reload view" title="Reload"
              onClick={() => { setError(null); setShowSource(false); setGeneration((value) => value + 1) }}
            >
              <RotateCcw data-icon="icon" />
            </Button>
            <Button
              type="button" variant="ghost" size="icon-xs" className="text-muted-foreground" aria-label="Expand view" title="Expand"
              onClick={() => setExpanded(true)}
            >
              <Maximize2 data-icon="icon" />
            </Button>
          </>
        )}
      </header>
      {body}
      {error && !showSource && (
        <div role="alert" className="flex items-center gap-2 border-t border-border/70 py-1 pr-1.5 pl-3 text-xs text-destructive">
          <CircleAlert className="size-3.5 shrink-0" aria-hidden="true" />
          <span className="min-w-0 flex-1 truncate" title={error}>{error}</span>
          {activeComposer() && (
            <Button type="button" variant="ghost" size="xs" onClick={() => askInComposer(`The interactive view "${title}" shows this error: ${error}\nPlease fix it.`)}>
              Ask to fix
            </Button>
          )}
        </div>
      )}
      {complete && (
        <Dialog open={expanded} onOpenChange={setExpanded}>
          <DialogContent className="flex h-[88vh] w-[min(1280px,96vw)] max-w-none flex-col gap-3 p-4 sm:max-w-none">
            <DialogTitle className="pr-8 text-sm">{title}</DialogTitle>
            <div className="min-h-0 flex-1 overflow-hidden rounded-lg border border-border">
              {expanded && <ViewFrame html={source} title={title} fill onError={setError} />}
            </div>
          </DialogContent>
        </Dialog>
      )}
    </section>
  )
}

function ViewFrame({ html, title, fill = false, onError }: { html: string; title: string; fill?: boolean; onError: (message: string) => void }) {
  const frame = useRef<HTMLIFrameElement>(null)
  const { theme } = usePluginPresentation()
  const latest = useRef<{ theme: ViewTheme; onError: (message: string) => void }>({ theme, onError })
  const [height, setHeight] = useState(DEFAULT_HEIGHT)
  const [state, setState] = useState<"loading" | "ready" | "failed">("loading")
  useLayoutEffect(() => { latest.current = { theme, onError } })

  useLayoutEffect(() => {
    let disposed = false
    let answered = false
    const used = librariesUsed(html)
    const libraries = loadViewLibraries(used)
    libraries.catch(() => {})
    const onMessage = (event: MessageEvent) => {
      const target = frame.current?.contentWindow
      if (!target || event.source !== target) return
      const message = readViewMessage(event.data)
      if (!message) return
      switch (message.type) {
        case "ready":
          answered = true
          libraries.then((loaded) => {
            if (disposed) return
            target.postMessage({ type: "cogpit-view:render", html: composeViewDocument(html, latest.current.theme, used), libraries: loaded }, "*")
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
  }, [html])

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
