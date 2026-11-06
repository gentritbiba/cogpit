import { useEffect, useRef, useState, type ReactNode, type RefObject } from "react"
import { AppWindow, PanelRightOpen } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/Spinner"
import { useViewPanel } from "@/components/views/ViewPanelContext"
import { formatViewReference, parseViewReference, type ViewReference } from "../../../../../shared/views/stored"
import { composeViewDocument, librariesUsed, viewTitle } from "./document"
import { loadViewLibraries } from "./libraries"
import {
  DEFAULT_VIEW_HEIGHT, useViewControls, ViewErrorLine, ViewExpandDialog, ViewFrame, ViewRunButtons, ViewSourceToggle, type PreparedView,
} from "./ViewFrame"
import { StoredViewSource, storedViewPrepare, storedViewProblem, useNewestVersion, useStoredView } from "./storedView"

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
 * An interactive page an agent put in its reply, drawn in a sandbox that has
 * no origin and no network. A block holding `<id>@<n>` names a stored view the
 * session's computer built; anything else is the page's own markup.
 */
export default function CogpitView({ source, complete, fallback, renderCode }: {
  source: string
  complete: boolean
  fallback: ReactNode
  renderCode: (code: string, lang: string) => ReactNode
}) {
  const reference = complete ? parseViewReference(source) : null
  return reference
    ? <StoredView reference={reference} renderCode={renderCode} />
    : <InlineView source={source} complete={complete} fallback={fallback} />
}

function InlineView({ source, complete, fallback }: { source: string; complete: boolean; fallback: ReactNode }) {
  const title = viewTitle(source) ?? "Interactive view"
  const prepare = async (): Promise<PreparedView> => {
    const used = librariesUsed(source)
    const libraries = await loadViewLibraries(used)
    return { libraries, compose: (theme) => composeViewDocument(source, theme, used) }
  }
  return (
    <ViewCard
      title={title}
      prepareKey={source}
      prepare={complete ? prepare : null}
      sourceView={<div className="[&>div]:my-0 [&>div]:rounded-none [&>div]:border-0">{fallback}</div>}
      status={!complete && (
        <span className="mr-1 flex items-center gap-1.5 text-xs text-muted-foreground">
          <Spinner className="size-3" /> Building · {source.split("\n").length} lines
        </span>
      )}
      pending={<p className="flex h-24 items-center justify-center text-xs text-muted-foreground">The view appears when the reply finishes writing it.</p>}
    />
  )
}

function StoredView({ reference, renderCode }: { reference: ViewReference; renderCode: (code: string, lang: string) => ReactNode }) {
  const [version, setVersion] = useState(reference.version)
  const shown = { id: reference.id, version }
  const state = useStoredView(shown)
  const view = state.status === "ready" ? state.view : null
  const title = view?.title ?? reference.id
  const key = formatViewReference(shown)
  const panel = useViewPanel()

  const message = storedViewProblem(state, "This view is not on the computer that ran this session.")
  const latest = Math.max(view?.latestVersion ?? 0, useNewestVersion(reference.id) ?? 0)

  const versionSwitch = view && (latest > reference.version || version !== reference.version) && (
    <Button
      type="button" variant="ghost" size="xs" className="text-muted-foreground"
      title={version === reference.version ? "Show the newest version" : "Show the version this reply made"}
      onClick={() => setVersion(version === reference.version ? latest : reference.version)}
    >
      {version === reference.version ? `v${latest} available` : `Back to v${reference.version}`}
    </Button>
  )

  return (
    <ViewCard
      title={title}
      prepareKey={key}
      prepare={view ? storedViewPrepare(view) : null}
      fixHint={key}
      status={<>{versionSwitch}<span className="mr-1 text-xs tabular-nums text-muted-foreground">v{version}</span></>}
      actions={view && panel && (
        <Button
          type="button" variant="ghost" size="icon-xs" className="text-muted-foreground" aria-label="Open in panel" title="Open in panel"
          data-testid="view-open-in-panel"
          onClick={() => panel.open(shown)}
        >
          <PanelRightOpen data-icon="icon" />
        </Button>
      )}
      sourceView={view
        ? <StoredViewSource view={view} renderCode={renderCode} />
        : <p className="p-3 text-xs text-muted-foreground">{message ?? "Loading…"}</p>}
      pending={message
        ? <p role="alert" className="p-3 text-xs text-muted-foreground">{message}</p>
        : <div className="grid h-24 place-items-center text-muted-foreground"><Spinner className="size-4" /></div>}
    />
  )
}

/** The card around a view: title, source, reload, expand and the error line. `prepare` is null until the view can run. */
function ViewCard({ title, prepareKey, prepare, sourceView, status, actions, pending, fixHint }: {
  title: string
  prepareKey: string
  prepare: (() => Promise<PreparedView>) | null
  sourceView: ReactNode
  status?: ReactNode
  /** Header buttons after the card's own. */
  actions?: ReactNode
  pending: ReactNode
  fixHint?: string
}) {
  const controls = useViewControls()
  const { showSource, expanded, setExpanded, error, setError, generation } = controls
  const container = useRef<HTMLElement>(null)
  const near = useNearViewport(container)

  const body = (): ReactNode => {
    if (showSource) return sourceView
    if (!prepare) return pending
    if (!near) return <div style={{ height: DEFAULT_VIEW_HEIGHT }} />
    return <ViewFrame key={`${prepareKey}:${generation}`} prepare={prepare} title={title} onError={setError} />
  }

  return (
    <section ref={container} aria-label={title} data-cogpit-block className="my-3 overflow-hidden rounded-lg border border-border bg-card text-sm">
      <header className="flex items-center gap-1 border-b border-border/70 py-1 pr-1.5 pl-3">
        <AppWindow className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
        <h4 className="ml-1 min-w-0 flex-1 truncate text-[13px] font-medium">{title}</h4>
        {status}
        <ViewSourceToggle controls={controls} />
        {prepare && <ViewRunButtons controls={controls} />}
        {actions}
      </header>
      {body()}
      {error && !showSource && <ViewErrorLine error={error} title={title} fixHint={fixHint} />}
      {prepare && (
        <ViewExpandDialog open={expanded} onOpenChange={setExpanded} title={title} prepareKey={prepareKey} prepare={prepare} onError={setError} />
      )}
    </section>
  )
}
