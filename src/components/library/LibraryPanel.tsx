import { useDeferredValue, useState, type ComponentType } from "react"
import { AlertTriangle, AppWindow, FileText, Images, Library, Link2, Search, X, type LucideIcon } from "lucide-react"
import { toast } from "sonner"
import { Alert, AlertAction, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { ConfirmActionDialog } from "@/components/shared/ConfirmActionDialog"
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Separator } from "@/components/ui/separator"
import { Skeleton } from "@/components/ui/skeleton"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { OpenView } from "@/components/views/OpenView"
import { ViewBrowser } from "@/components/views/ViewBrowser"
import { useViewPanel } from "@/components/views/ViewPanelContext"
import { useViews } from "@/components/views/useViews"
import { useSessionControlsOptional } from "@/contexts/SessionContext"
import { useLocalStorage } from "@/hooks/useLocalStorage"
import type { WorkspacePanelProps } from "@/plugin-api"
import { findSessionLocation, revealSessionPath, sessionPath } from "@/lib/revealSession"
import { LIBRARY_SCOPES, type LibraryItem, type LibraryScope, type LibraryTab } from "../../../shared/library/types"
import type { ViewSummary } from "../../../shared/views/stored"
import { projectOfCwd } from "../../../shared/worktreePath"
import { FileList, LinkList, MediaGrid, type ItemContext } from "./LibraryItems"
import { useLibrary } from "./useLibrary"

type PanelTab = "views" | LibraryTab

const TABS: ReadonlyArray<{ value: PanelTab; label: string; icon: LucideIcon }> = [
  { value: "media", label: "Media", icon: Images },
  { value: "link", label: "Links", icon: Link2 },
  { value: "file", label: "Files", icon: FileText },
  { value: "views", label: "Views", icon: AppWindow },
]

const SCOPE_LABELS: Record<LibraryScope, string> = { session: "Session", project: "Project", all: "All" }
const SCOPE_PHRASES: Record<LibraryScope, string> = { session: "in this session", project: "in this project", all: "yet" }

const EMPTY: Record<LibraryTab, { title: string; description: string }> = {
  media: { title: "No images or videos", description: "Screenshots and recordings an agent shows in a reply are kept here, with a copy that outlives the temp folder." },
  link: { title: "No links", description: "Links an agent shares in a reply are kept here." },
  file: { title: "No files", description: "Reports, documents and exports an agent links to in a reply are kept here." },
}

const ITEM_LISTS: Record<LibraryTab, ComponentType<{ items: LibraryItem[]; context: ItemContext }>> = {
  media: MediaGrid,
  link: LinkList,
  file: FileList,
}

const SKELETON_ROWS = ["first", "second", "third"]

/** The scope that can be shown: one without its session or project falls back to the next wider. */
function usableScope(scope: LibraryScope, sessionId: string | null, project: string | null): LibraryScope {
  if (scope === "session" && sessionId) return "session"
  if (scope !== "all" && project) return "project"
  return "all"
}

/**
 * The workspace panel that keeps what agents shared: their views, images
 * and videos, links and files, for the open session, its project or every
 * session. A view opened from it fills the panel until it goes back.
 */
export function LibraryPanel({ context, active, closePanel }: WorkspacePanelProps) {
  const panel = useViewPanel()
  const views = useViews()
  if (panel?.target) return <OpenView key={panel.target.id} reference={panel.target} list={views} onSelect={panel.select} onClose={closePanel} />
  return <LibraryBrowser context={context} active={active} views={views} closePanel={closePanel} />
}

function LibraryBrowser({ context, active, views, closePanel }: Pick<WorkspacePanelProps, "context" | "active" | "closePanel"> & { views: ReturnType<typeof useViews> }) {
  const [storedScope, setScope] = useLocalStorage<LibraryScope>("library-scope", "session")
  const [storedTab, setTab] = useLocalStorage<PanelTab>("library-tab", "media")
  const [text, setText] = useState("")
  const filter = useDeferredValue(text)
  const [removing, setRemoving] = useState<LibraryItem | null>(null)
  const { sessionId, projectPath } = context
  const scope = usableScope(LIBRARY_SCOPES.includes(storedScope) ? storedScope : "session", sessionId, projectPath)
  const tab = TABS.some((entry) => entry.value === storedTab) ? storedTab : "media"
  const library = useLibrary(
    { scope, sessionId, project: projectPath, tab: tab === "views" ? null : tab, text: tab === "views" ? "" : filter },
    { active, refreshKey: `${sessionId}:${context.sessionChangeKey}` },
  )
  const goToMessage = useGoToMessage()
  const TabIcon = TABS.find((entry) => entry.value === tab)!.icon
  const ItemList = tab === "views" ? null : ITEM_LISTS[tab]

  const project = projectPath ? projectOfCwd(projectPath) : null
  const filterText = filter.trim()
  const shownViewIds = new Set(library.data?.viewIds ?? [])
  const includeView = (view: ViewSummary) => {
    if (filterText && !view.title.toLowerCase().includes(filterText.toLowerCase())) return false
    if (scope === "all" || shownViewIds.has(view.id)) return true
    return scope === "session" ? view.sessionId === sessionId : view.project === project
  }
  const counts: Record<PanelTab, number | null> = {
    views: views.views && library.data ? views.views.filter(includeView).length : null,
    media: library.data?.counts.media ?? null,
    link: library.data?.counts.link ?? null,
    file: library.data?.counts.file ?? null,
  }

  const itemContext: ItemContext = {
    scope,
    sessions: library.data?.sessions ?? {},
    goToMessage: (item) => void goToMessage(item),
    remove: setRemoving,
  }

  return (
    <aside aria-label="Library" data-testid="library-panel" className="flex size-full min-h-0 flex-col bg-canvas">
      <div className="flex h-10 shrink-0 items-center gap-2 px-3">
        <Library aria-hidden="true" className="size-4 text-muted-foreground" />
        <h2 className="text-sm font-medium">Library</h2>
        <div className="flex-1" />
        <Button variant="ghost" size="icon-sm" onClick={closePanel} aria-label="Close library">
          <X data-icon="inline-start" />
        </Button>
      </div>
      <div className="flex shrink-0 flex-col gap-2 px-3 pb-2">
        <ToggleGroup
          aria-label="Show what was shared in"
          value={[scope]}
          onValueChange={(values) => {
            const next = values[0] as LibraryScope | undefined
            if (next && LIBRARY_SCOPES.includes(next)) setScope(next)
          }}
          variant="outline"
          size="sm"
          spacing={0}
          className="w-full"
        >
          {LIBRARY_SCOPES.map((value) => {
            const unusable = (value === "session" && !sessionId) || (value === "project" && !projectPath)
            return (
              <ToggleGroupItem
                key={value}
                value={value}
                disabled={unusable}
                className="flex-1"
                title={unusable ? `No ${value} is open` : `What agents shared ${value === "all" ? "in every session" : `in this ${value}`}`}
              >
                {SCOPE_LABELS[value]}
              </ToggleGroupItem>
            )
          })}
        </ToggleGroup>
        <InputGroup>
          <InputGroupAddon><Search aria-hidden="true" /></InputGroupAddon>
          <InputGroupInput value={text} onChange={(event) => setText(event.target.value)} placeholder="Filter" aria-label="Filter the library" />
        </InputGroup>
      </div>
      <Tabs value={tab} onValueChange={(value) => setTab(value as PanelTab)} className="min-h-0 flex-1 gap-0">
        <TabsList variant="line" className="mx-3 w-[calc(100%-1.5rem)]">
          {TABS.map(({ value, label, icon: Icon }) => (
            <TabsTrigger key={value} value={value} className="gap-1 px-1.5" aria-label={label}>
              <Icon aria-hidden="true" />
              <span>{label}</span>
              {counts[value] !== null && counts[value] > 0 && <span className="text-[11px] tabular-nums text-muted-foreground">{counts[value]}</span>}
            </TabsTrigger>
          ))}
        </TabsList>
        <Separator />
        {tab === "views" ? (
          <ViewBrowser
            list={views}
            include={includeView}
            empty={scope === "all" && !filterText ? undefined : { title: "No views here", description: `No view was built or shown ${SCOPE_PHRASES[scope]}${filterText ? " that matches the filter" : ""}.` }}
          />
        ) : (
          <ScrollArea className="min-h-0 flex-1">
            <div className="flex flex-col gap-2 p-2">
              {library.error && (
                <Alert variant="destructive">
                  <AlertTriangle />
                  <AlertTitle>Could not load the library</AlertTitle>
                  <AlertDescription className="truncate">{library.error}</AlertDescription>
                  <AlertAction><Button variant="outline" size="xs" onClick={library.refresh}>Retry</Button></AlertAction>
                </Alert>
              )}
              {!library.data && !library.error && (
                <div className="flex flex-col gap-2 px-2 py-4" aria-label="Loading the library">
                  {SKELETON_ROWS.map((row) => <Skeleton key={row} className="h-12 w-full" />)}
                </div>
              )}
              {library.data && !library.data.available && (
                <p role="status" className="px-2 py-6 text-center text-sm text-muted-foreground">The library is not available on this computer.</p>
              )}
              {library.data?.available && library.data.items.length === 0 && (
                <Empty className="min-h-56 px-4 py-8">
                  <EmptyHeader>
                    <EmptyMedia variant="icon"><TabIcon /></EmptyMedia>
                    <EmptyTitle>{filterText ? "Nothing matches" : EMPTY[tab].title}</EmptyTitle>
                    <EmptyDescription>{filterText ? "Try other words, or a wider scope." : EMPTY[tab].description}</EmptyDescription>
                  </EmptyHeader>
                </Empty>
              )}
              {ItemList && library.data && library.data.items.length > 0 && <ItemList items={library.data.items} context={itemContext} />}
              {library.data?.next && (
                <Button variant="ghost" size="sm" className="self-center text-muted-foreground" disabled={library.loadingMore} onClick={() => void library.loadMore()}>
                  {library.loadingMore ? "Loading…" : "Show older"}
                </Button>
              )}
              {library.data && library.data.pendingFiles > 0 && (
                <p role="status" className="px-2 py-1 text-center text-[11px] text-muted-foreground">Reading conversations… more may appear.</p>
              )}
            </div>
          </ScrollArea>
        )}
      </Tabs>
      {removing && (
        <ConfirmActionDialog
          open
          onOpenChange={(open) => { if (!open) setRemoving(null) }}
          title="Remove from the library?"
          description={<>“<span className="font-medium text-foreground break-all">{removing.label ?? removing.target}</span>” leaves the library, with every mention you can change and the copy it kept. The conversation keeps it.</>}
          confirmLabel="Remove"
          destructive
          onConfirm={async () => {
            const failure = await library.remove(removing.id)
            if (failure) return failure
            setRemoving(null)
            return null
          }}
        />
      )}
    </aside>
  )
}

/** Opens an item's session at the reply that shared it, or just the session when that reply is gone. */
function useGoToMessage(): (item: LibraryItem) => Promise<void> {
  const openQuoteSource = useSessionControlsOptional()?.actions.handleOpenQuoteSource
  return async (item) => {
    const location = await findSessionLocation(item.sessionId)
    if (!location) {
      toast.error("That session is no longer on this computer")
      return
    }
    if (!openQuoteSource) {
      revealSessionPath(sessionPath(location.dirName, location.fileName))
      return
    }
    const found = await openQuoteSource({ ...location, sessionId: item.sessionId, turnId: item.turnId ?? "" }, item.target, item.turn)
    if (!found) toast("The session is open, but that reply is no longer in it")
  }
}
