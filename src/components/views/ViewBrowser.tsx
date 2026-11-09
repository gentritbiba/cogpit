import { Fragment, useMemo, useState, type FormEvent } from "react"
import { AlertTriangle, AppWindow, Folder, MoreHorizontal, Pencil, Pin, PinOff, Trash2, type LucideIcon } from "lucide-react"
import { toast } from "sonner"
import { Alert, AlertAction, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuTrigger } from "@/components/ui/context-menu"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"
import { Field, FieldError, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Skeleton } from "@/components/ui/skeleton"
import { ConfirmActionDialog } from "@/components/shared/ConfirmActionDialog"
import { ProjectFavicon } from "@/components/ProjectFavicon"
import { projectGroupKey } from "@/components/LiveSessions/sessionListView"
import { recencyBucket } from "@/components/LiveSessions/recencyBuckets"
import { formatRelativeTime } from "@/lib/format"
import { cn } from "@/lib/utils"
import type { ViewSummary } from "../../../shared/views/stored"
import { useViewPanel } from "./ViewPanelContext"
import { sortViews, useViews } from "./useViews"

interface RowAction {
  label: string
  icon: LucideIcon
  run: () => void
  destructive?: boolean
}

const SKELETON_ROWS = ["first", "second", "third"]

/**
 * The stored views on the active device: pinned first, then by when each was
 * last built, on the same date shelves as the sessions list. Opening one shows
 * it in the view panel; each row can be pinned, renamed or deleted.
 */
export function ViewBrowser() {
  const { views, error, refresh, update, remove } = useViews()
  const panel = useViewPanel()
  const [renaming, setRenaming] = useState<ViewSummary | null>(null)
  const [deleting, setDeleting] = useState<ViewSummary | null>(null)

  const listed = useMemo(() => {
    const sorted = sortViews(views ?? [])
    const now = Date.now()
    const shelves = sorted.map((view) => (view.pinned ? "Pinned" : recencyBucket(view.updatedAt, now)))
    return sorted.map((view, index) => ({ view, shelf: shelves[index] === shelves[index - 1] ? null : shelves[index] }))
  }, [views])

  const togglePin = async (view: ViewSummary) => {
    const failure = await update(view.id, { pinned: !view.pinned })
    if (failure) toast.error(failure)
  }

  const confirmDelete = async (view: ViewSummary): Promise<string | null> => {
    const failure = await remove(view.id)
    if (failure) return failure
    if (panel?.target?.id === view.id) panel.select(null)
    setDeleting(null)
    return null
  }

  const actionsFor = (view: ViewSummary): RowAction[] => [
    { label: view.pinned ? "Unpin view" : "Pin view", icon: view.pinned ? PinOff : Pin, run: () => void togglePin(view) },
    { label: "Rename view", icon: Pencil, run: () => setRenaming(view) },
    { label: "Delete view", icon: Trash2, run: () => setDeleting(view), destructive: true },
  ]

  return (
    <ScrollArea className="min-h-0 flex-1">
      <div className="flex flex-col gap-1.5 p-2" data-testid="views-list">
        {error && (
          <Alert variant="destructive">
            <AlertTriangle />
            <AlertTitle>Could not load views</AlertTitle>
            <AlertDescription className="truncate">{error}</AlertDescription>
            <AlertAction>
              <Button variant="outline" size="xs" onClick={refresh}>Retry</Button>
            </AlertAction>
          </Alert>
        )}

        {views === null && !error && (
          <div className="flex flex-col gap-2 px-2 py-4" aria-label="Loading views">
            {SKELETON_ROWS.map((row) => <Skeleton key={row} className="h-12 w-full" />)}
          </div>
        )}

        {views !== null && listed.length === 0 && (
          <Empty className="min-h-56 px-4 py-8">
            <EmptyHeader>
              <EmptyMedia variant="icon"><AppWindow /></EmptyMedia>
              <EmptyTitle>No views yet</EmptyTitle>
              <EmptyDescription>When an agent builds an interactive view, it is kept here to open again.</EmptyDescription>
            </EmptyHeader>
          </Empty>
        )}

        {listed.map(({ view, shelf }) => (
          <Fragment key={view.id}>
            {shelf && <div className="px-1 pb-0.5 pt-2 text-[11px] font-medium text-muted-foreground/80 first:pt-0">{shelf}</div>}
            <ViewRow
              view={view}
              active={Boolean(panel?.shown) && panel?.target?.id === view.id}
              onOpen={panel ? (version) => panel.open({ id: view.id, version }) : undefined}
              actions={actionsFor(view)}
            />
          </Fragment>
        ))}
      </div>

      {renaming && (
        <RenameViewDialog
          key={renaming.id}
          view={renaming}
          onClose={() => setRenaming(null)}
          onRename={(title) => update(renaming.id, { title })}
        />
      )}
      {deleting && (
        <ConfirmActionDialog
          open
          onOpenChange={(open) => { if (!open) setDeleting(null) }}
          title="Delete view?"
          description={<>“<span className="font-medium text-foreground">{deleting.title}</span>” and every version of it are removed from this computer. Replies that show it can no longer load it.</>}
          confirmLabel="Delete view"
          destructive
          onConfirm={() => confirmDelete(deleting)}
        />
      )}
    </ScrollArea>
  )
}

function ViewRow({ view, active, onOpen, actions }: {
  view: ViewSummary
  active: boolean
  onOpen?: (version: number) => void
  actions: RowAction[]
}) {
  const version = view.latestVersion
  const open = onOpen && version !== null ? () => onOpen(version) : undefined
  return (
    <div className="group relative" data-view-row={view.id}>
      <ContextMenu>
        <ContextMenuTrigger render={<div className="w-full" />}>
          <button
            type="button"
            onClick={open}
            disabled={!open}
            aria-current={active ? "true" : undefined}
            className={cn(
              "motion-list-item flex w-full flex-col gap-1 rounded-lg border px-3 py-2.5 pr-9 text-left outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-default",
              active ? "border-foreground/15 bg-accent" : "border-border/70 bg-card hover:border-border hover:bg-accent",
            )}
          >
            <span className="flex items-center gap-1.5 text-[11px] leading-tight text-muted-foreground" data-view-project>
              <ProjectFavicon projectPath={view.project} fallback={<Folder className="size-3 shrink-0" aria-hidden="true" />} className="size-3" />
              <span className="truncate">{projectGroupKey(view.project)}</span>
            </span>
            <span className="flex items-start gap-1.5">
              {view.pinned && <Pin className="mt-1 size-3 shrink-0 text-muted-foreground" role="img" aria-label="Pinned" />}
              <span className="line-clamp-2 flex-1 text-sm font-medium leading-snug text-foreground">{view.title}</span>
            </span>
            <span className="flex items-center gap-2 text-[11px] text-muted-foreground">
              <span className="tabular-nums">{version === null ? "Not built yet" : `v${version}`}</span>
              <span className="ml-auto tabular-nums" title={new Date(view.updatedAt).toLocaleString()}>{formatRelativeTime(view.updatedAt)}</span>
            </span>
          </button>
        </ContextMenuTrigger>
        <ContextMenuContent className="min-w-40">
          {actions.map(({ label, icon: Icon, run, destructive }) => (
            <Fragment key={label}>
              {destructive && <ContextMenuSeparator />}
              <ContextMenuItem variant={destructive ? "destructive" : "default"} onClick={run}>
                <Icon data-icon="inline-start" />
                {label}
              </ContextMenuItem>
            </Fragment>
          ))}
        </ContextMenuContent>
      </ContextMenu>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={(
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              aria-label={`Actions for ${view.title}`}
              className="absolute top-1.5 right-1.5 bg-popover text-muted-foreground opacity-0 group-focus-within:opacity-100 group-hover:opacity-100 hover:text-foreground data-popup-open:opacity-100"
            />
          )}
        >
          <MoreHorizontal data-icon="inline-start" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="min-w-40">
          {actions.map(({ label, icon: Icon, run, destructive }) => (
            <Fragment key={label}>
              {destructive && <DropdownMenuSeparator />}
              <DropdownMenuItem variant={destructive ? "destructive" : "default"} onClick={run}>
                <Icon data-icon="inline-start" />
                {label}
              </DropdownMenuItem>
            </Fragment>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}

function RenameViewDialog({ view, onClose, onRename }: {
  view: ViewSummary
  onClose: () => void
  /** Resolves to an error to show, or null once renamed. */
  onRename: (title: string) => Promise<string | null>
}) {
  const [title, setTitle] = useState(view.title)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function submit(event: FormEvent) {
    event.preventDefault()
    const next = title.trim()
    if (!next || next === view.title) {
      onClose()
      return
    }
    setBusy(true)
    const failure = await onRename(next)
    setBusy(false)
    if (failure) setError(failure)
    else onClose()
  }

  return (
    <Dialog open onOpenChange={(open) => { if (!open && !busy) onClose() }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Rename view</DialogTitle>
          <DialogDescription>The new name shows here and on every reply that shows this view.</DialogDescription>
        </DialogHeader>
        <form className="flex flex-col gap-4" onSubmit={(event) => void submit(event)}>
          <Field>
            <FieldLabel htmlFor="view-rename">View name</FieldLabel>
            <Input
              id="view-rename"
              value={title}
              autoFocus
              maxLength={200}
              onFocus={(event) => event.currentTarget.select()}
              onChange={(event) => setTitle(event.target.value)}
            />
            {error && <FieldError>{error}</FieldError>}
          </Field>
          <DialogFooter>
            <Button type="button" variant="ghost" size="sm" onClick={onClose} disabled={busy}>Cancel</Button>
            <Button type="submit" size="sm" disabled={busy || !title.trim()}>Save</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
