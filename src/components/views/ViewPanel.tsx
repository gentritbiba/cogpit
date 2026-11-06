import type { ReactNode } from "react"
import { AppWindow, LayoutList, MessageSquare, X } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Separator } from "@/components/ui/separator"
import { Spinner } from "@/components/ui/Spinner"
import { HighlightedCodeBlock } from "@/components/timeline/MarkdownCodeBlock"
import {
  useViewControls, ViewErrorLine, ViewExpandDialog, ViewFrame, ViewRunButtons, ViewSourceToggle,
} from "@/components/timeline/cogpit-blocks/view/ViewFrame"
import { StoredViewSource, storedViewPrepare, storedViewProblem, useStoredView } from "@/components/timeline/cogpit-blocks/view/storedView"
import { revealSessionById } from "@/lib/revealSession"
import type { WorkspacePanelProps } from "@/plugin-api"
import { formatViewReference, type ViewReference } from "../../../shared/views/stored"
import { ViewBrowser } from "./ViewBrowser"
import { useViewPanel } from "./ViewPanelContext"
import { useViews } from "./useViews"

const renderCode = (code: string, lang: string) => <HighlightedCodeBlock code={code} lang={lang} />

/** The workspace panel beside the chat: one stored view at a time, or the list of views to pick from. */
export function ViewPanel({ closePanel }: WorkspacePanelProps) {
  const panel = useViewPanel()
  const target = panel?.target ?? null
  if (!panel || !target) {
    return (
      <aside aria-label="Views" data-testid="view-panel" className="flex size-full min-h-0 flex-col bg-canvas">
        <div className="flex h-10 shrink-0 items-center gap-2 px-3">
          <AppWindow aria-hidden="true" className="size-4 text-muted-foreground" />
          <h2 className="text-sm font-medium">Views</h2>
          <div className="flex-1" />
          <Button variant="ghost" size="icon-sm" onClick={closePanel} aria-label="Close views">
            <X data-icon="inline-start" />
          </Button>
        </div>
        <Separator />
        <ViewBrowser scope={null} />
      </aside>
    )
  }
  return <OpenView key={target.id} reference={target} onSelect={panel.select} onClose={closePanel} />
}

function OpenView({ reference, onSelect, onClose }: {
  reference: ViewReference
  onSelect: (target: ViewReference | null) => void
  onClose: () => void
}) {
  const { views } = useViews()
  const summary = views?.find((view) => view.id === reference.id)
  const state = useStoredView(reference)
  const view = state.status === "ready" ? state.view : null
  const title = summary?.title ?? view?.title ?? reference.id
  const latest = Math.max(reference.version, view?.latestVersion ?? 0, summary?.latestVersion ?? 0)
  const versions = Array.from({ length: latest }, (_, index) => latest - index)
  const key = formatViewReference(reference)
  const prepare = view ? storedViewPrepare(view) : null
  const controls = useViewControls()
  const { showSource, expanded, setExpanded, error, setError, generation } = controls

  const message = storedViewProblem(state, "This version of the view is no longer on this computer.")

  const showVersion = (value: string | null) => {
    if (!value) return
    setError(null)
    onSelect({ id: reference.id, version: Number(value) })
  }

  const openSession = async () => {
    if (!summary?.sessionId) return
    if (!(await revealSessionById(summary.sessionId))) toast.error("The session that made this view is not on this computer")
  }

  const body = (): ReactNode => {
    if (showSource) {
      return view
        ? <StoredViewSource view={view} renderCode={renderCode} />
        : <p className="p-3 text-xs text-muted-foreground">{message ?? "Loading…"}</p>
    }
    if (prepare) return <ViewFrame key={`${key}:${generation}`} prepare={prepare} title={title} fill onError={setError} />
    if (message) return <p role="alert" className="p-3 text-xs text-muted-foreground">{message}</p>
    return <div className="grid h-full place-items-center text-muted-foreground"><Spinner className="size-4" /></div>
  }

  return (
    <aside aria-label={`View: ${title}`} data-testid="view-panel" data-view-id={reference.id} className="flex size-full min-h-0 flex-col bg-canvas">
      <div className="flex h-10 shrink-0 items-center gap-1 pr-1.5 pl-3">
        <AppWindow aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
        <h2 className="ml-1 min-w-0 flex-1 truncate text-sm font-medium" title={title}>{title}</h2>
        <Button variant="ghost" size="icon-sm" onClick={() => onSelect(null)} aria-label="All views" title="All views">
          <LayoutList data-icon="inline-start" />
        </Button>
        <Button variant="ghost" size="icon-sm" onClick={onClose} aria-label="Close view panel" title="Close">
          <X data-icon="inline-start" />
        </Button>
      </div>
      <div className="flex shrink-0 items-center gap-1 px-3 pb-2">
        <Select value={String(reference.version)} onValueChange={showVersion}>
          <SelectTrigger size="sm" aria-label="Version" data-testid="view-version-picker" className="tabular-nums">
            <SelectValue>{`v${reference.version}`}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              {versions.map((version) => (
                <SelectItem key={version} value={String(version)} className="tabular-nums">
                  {version === latest ? `v${version} · latest` : `v${version}`}
                </SelectItem>
              ))}
            </SelectGroup>
          </SelectContent>
        </Select>
        {summary?.sessionId && (
          <Button variant="ghost" size="xs" className="text-muted-foreground" onClick={() => void openSession()}>
            <MessageSquare data-icon="inline-start" />
            Open session
          </Button>
        )}
        <div className="flex-1" />
        <ViewSourceToggle controls={controls} />
        <ViewRunButtons controls={controls} disabled={!prepare} />
      </div>
      <Separator />
      <div className={showSource ? "min-h-0 flex-1 overflow-auto" : "min-h-0 flex-1 overflow-hidden"}>{body()}</div>
      {error && !showSource && <ViewErrorLine error={error} title={title} fixHint={key} />}
      {prepare && (
        <ViewExpandDialog open={expanded} onOpenChange={setExpanded} title={title} prepareKey={key} prepare={prepare} onError={setError} />
      )}
    </aside>
  )
}
