import { Fragment, useState, type ReactNode } from "react"
import {
  Copy, ExternalLink, FileText, FolderOpen, Globe, HardDrive, ImageOff, MessageSquareText, MoreHorizontal, Play, Trash2, type LucideIcon,
} from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuTrigger } from "@/components/ui/context-menu"
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { ImageViewer, type ImageViewerItem } from "@/components/timeline/ImageViewer"
import { LocalVideo } from "@/components/timeline/LocalVideo"
import { resolveMediaSrc } from "@/components/timeline/localMedia"
import { useCapability } from "@/hooks/useCapability"
import { openFile } from "@/lib/fileOpener"
import { formatRelativeTime, projectName } from "@/lib/format"
import { copyToClipboard, cn } from "@/lib/utils"
import type { LibraryItem, LibraryScope, LibrarySession } from "../../../shared/library/types"

export interface ItemAction {
  label: string
  icon: LucideIcon
  run: () => void
  destructive?: boolean
}

export interface ItemContext {
  scope: LibraryScope
  sessions: Record<string, LibrarySession>
  goToMessage: (item: LibraryItem) => void
  remove: (item: LibraryItem) => void
}

function fileName(path: string): string {
  return path.slice(Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\")) + 1) || path
}

function folderOf(path: string): string {
  return path.slice(0, Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"))) || path
}

function displayName(item: LibraryItem): string {
  return item.label ?? fileName(item.target)
}

/** The copy that shows what the reply showed: the library's own when it kept one, else the file where it was. */
function mediaPath(item: LibraryItem): string | null {
  return item.keptPath ?? (item.present ? item.target : null)
}

/** Where a shared document opens: where it is now, else the library's copy of it. */
function documentPath(item: LibraryItem): string | null {
  return item.present ? item.target : item.keptPath
}

function sharedActions(item: LibraryItem, context: ItemContext, extra: ItemAction[]): ItemAction[] {
  return [
    ...extra,
    { label: "Go to message", icon: MessageSquareText, run: () => context.goToMessage(item) },
    { label: item.kind === "link" ? "Copy link" : "Copy path", icon: Copy, run: () => void copyToClipboard(item.target).then((copied) => { if (copied) toast.success("Copied") }) },
    { label: "Remove from library", icon: Trash2, run: () => context.remove(item), destructive: true },
  ]
}

/** Where an item came from, as much as the scope does not already say. */
function Provenance({ item, context }: { item: LibraryItem; context: ItemContext }) {
  const session = context.scope === "session" ? null : context.sessions[item.sessionId]
  const parts = [
    context.scope === "all" ? projectName(item.project) : null,
    session ? session.title || "Untitled session" : null,
  ].filter((part): part is string => Boolean(part))
  return (
    <span className="flex min-w-0 items-center gap-1.5 text-[11px] text-muted-foreground">
      {parts.length > 0 && <span className="min-w-0 truncate">{parts.join(" · ")}</span>}
      {item.mentions > 1 && <span className="shrink-0 tabular-nums" title={`Shared ${item.mentions} times`}>×{item.mentions}</span>}
      {item.sharedAt && (
        <time className="ml-auto shrink-0 tabular-nums" dateTime={item.sharedAt} title={new Date(item.sharedAt).toLocaleString()}>
          {formatRelativeTime(item.sharedAt)}
        </time>
      )}
    </span>
  )
}

function ActionsMenu({ label, actions, className }: { label: string; actions: ItemAction[]; className?: string }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={(
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-label={`Actions for ${label}`}
            className={cn("bg-popover text-muted-foreground opacity-0 group-focus-within:opacity-100 group-hover:opacity-100 hover:text-foreground data-popup-open:opacity-100", className)}
          />
        )}
      >
        <MoreHorizontal data-icon="inline-start" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-44">
        {actions.map(({ label: name, icon: Icon, run, destructive }) => (
          <Fragment key={name}>
            {destructive && <DropdownMenuSeparator />}
            <DropdownMenuItem variant={destructive ? "destructive" : "default"} onClick={run}>
              <Icon data-icon="inline-start" />
              {name}
            </DropdownMenuItem>
          </Fragment>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/** A row or tile with the same actions on right click and on its ⋯ button. */
function WithActions({ label, actions, children, menuClassName }: { label: string; actions: ItemAction[]; children: ReactNode; menuClassName: string }) {
  return (
    <div className="group relative">
      <ContextMenu>
        <ContextMenuTrigger render={<div className="w-full" />}>{children}</ContextMenuTrigger>
        <ContextMenuContent className="min-w-44">
          {actions.map(({ label: name, icon: Icon, run, destructive }) => (
            <Fragment key={name}>
              {destructive && <ContextMenuSeparator />}
              <ContextMenuItem variant={destructive ? "destructive" : "default"} onClick={run}>
                <Icon data-icon="inline-start" />
                {name}
              </ContextMenuItem>
            </Fragment>
          ))}
        </ContextMenuContent>
      </ContextMenu>
      <ActionsMenu label={label} actions={actions} className={cn("absolute", menuClassName)} />
    </div>
  )
}

// ── Media ────────────────────────────────────────────────────────────

/** Images and videos as a grid; images open together in the viewer, a video in a player. */
export function MediaGrid({ items, context }: { items: LibraryItem[]; context: ItemContext }) {
  const canAccessHostFiles = useCapability("hostFiles")
  const [viewing, setViewing] = useState<number | null>(null)
  const [playing, setPlaying] = useState<LibraryItem | null>(null)
  const gallery: Array<ImageViewerItem & { item: LibraryItem }> = canAccessHostFiles
    ? items.flatMap((item) => {
      const path = item.kind === "image" ? mediaPath(item) : null
      const src = path ? resolveMediaSrc(path) : undefined
      return src ? [{ id: String(item.id), src, alt: displayName(item), label: displayName(item), item }] : []
    })
    : []

  return (
    <>
      <div className="grid grid-cols-[repeat(auto-fill,minmax(7.5rem,1fr))] gap-2" data-testid="library-media">
        {items.map((item) => {
          const label = displayName(item)
          const path = canAccessHostFiles ? mediaPath(item) : null
          let open: (() => void) | undefined
          if (path) open = item.kind === "video" ? () => setPlaying(item) : () => setViewing(gallery.findIndex((entry) => entry.item.id === item.id))
          return (
            <WithActions key={item.id} label={label} actions={sharedActions(item, context, [])} menuClassName="top-1 right-1">
              <button
                type="button"
                onClick={open}
                disabled={!open}
                title={item.target}
                aria-label={`${item.kind === "video" ? "Play" : "Open"} ${label}`}
                className="flex w-full flex-col overflow-hidden rounded-lg border border-border/70 bg-card text-left outline-none transition-colors hover:border-border focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-default"
              >
                <MediaThumbnail item={item} path={path} label={label} />
                <span className="flex flex-col gap-0.5 px-2 py-1.5">
                  <span className="truncate text-xs font-medium text-foreground">{label}</span>
                  <Provenance item={item} context={context} />
                </span>
              </button>
            </WithActions>
          )
        })}
      </div>
      {viewing !== null && gallery.length > 0 && (
        <ImageViewer open images={gallery} initialIndex={Math.max(0, viewing)} onClose={() => setViewing(null)} />
      )}
      <Dialog open={playing !== null} onOpenChange={(open) => { if (!open) setPlaying(null) }}>
        {playing && (
          <DialogContent className="sm:max-w-3xl">
            <DialogHeader>
              <DialogTitle className="truncate">{displayName(playing)}</DialogTitle>
            </DialogHeader>
            <LocalVideo src={mediaPath(playing) ?? undefined} alt={playing.label ?? undefined} className="mx-auto" />
          </DialogContent>
        )}
      </Dialog>
    </>
  )
}

function MediaThumbnail({ item, path, label }: { item: LibraryItem; path: string | null; label: string }) {
  const [failed, setFailed] = useState(false)
  const src = path ? resolveMediaSrc(path) : undefined
  if (!src || failed) {
    return (
      <span className="grid aspect-[4/3] w-full place-items-center bg-muted/40 text-muted-foreground" role="img" aria-label={`${label} is no longer on this computer`}>
        <span className="flex flex-col items-center gap-1 text-[11px]">
          <ImageOff className="size-4" aria-hidden="true" />
          Unavailable
        </span>
      </span>
    )
  }
  return (
    <span className="relative block aspect-[4/3] w-full overflow-hidden bg-muted/40">
      {item.kind === "video" ? (
        <>
          <video src={src} muted playsInline preload="metadata" className="size-full object-cover" onError={() => setFailed(true)} />
          <span className="absolute inset-0 grid place-items-center">
            <span className="grid size-8 place-items-center rounded-full bg-black/60 text-white"><Play className="size-4" aria-hidden="true" /></span>
          </span>
        </>
      ) : (
        <img src={src} alt="" loading="lazy" decoding="async" className="size-full object-cover" onError={() => setFailed(true)} />
      )}
      {item.keptPath && !item.present && (
        <span className="absolute bottom-1 left-1 rounded bg-black/60 px-1 text-[10px] text-white" title="The original is gone; this is the library's copy">Saved copy</span>
      )}
    </span>
  )
}

// ── Links and files ──────────────────────────────────────────────────

function Row({ icon: Icon, title, detail, item, context, actions, onOpen }: {
  icon: LucideIcon
  title: string
  detail: string | null
  item: LibraryItem
  context: ItemContext
  actions: ItemAction[]
  onOpen?: () => void
}) {
  return (
    <WithActions label={title} actions={actions} menuClassName="top-1.5 right-1.5">
      <button
        type="button"
        onClick={onOpen}
        disabled={!onOpen}
        title={item.target}
        className="motion-list-item flex w-full items-start gap-2.5 rounded-lg border border-border/70 bg-card px-3 py-2 pr-9 text-left outline-none transition-colors hover:border-border hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-default"
      >
        <Icon className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="line-clamp-2 text-sm font-medium leading-snug break-words text-foreground">{title}</span>
          {detail && <span className="truncate text-[11px] text-muted-foreground">{detail}</span>}
          <Provenance item={item} context={context} />
        </span>
      </button>
    </WithActions>
  )
}

function linkParts(url: string): { host: string; rest: string } {
  try {
    const parsed = new URL(url)
    return { host: parsed.host.replace(/^www\./, ""), rest: `${parsed.pathname === "/" ? "" : parsed.pathname}${parsed.search}` }
  } catch {
    return { host: url, rest: "" }
  }
}

export function LinkList({ items, context }: { items: LibraryItem[]; context: ItemContext }) {
  return (
    <div className="flex flex-col gap-1.5" data-testid="library-links">
      {items.map((item) => {
        const { host, rest } = linkParts(item.target)
        const open = () => window.open(item.target, "_blank", "noopener,noreferrer")
        return (
          <Row
            key={item.id}
            icon={Globe}
            title={item.label ?? `${host}${rest}`}
            detail={item.label ? `${host}${rest}` : null}
            item={item}
            context={context}
            onOpen={open}
            actions={sharedActions(item, context, [{ label: "Open link", icon: ExternalLink, run: open }])}
          />
        )
      })}
    </div>
  )
}

function fileDetail(item: LibraryItem): string {
  if (item.present) return folderOf(item.target)
  if (item.keptPath) return "Saved copy · the original is gone"
  return `No longer at ${folderOf(item.target)}`
}

export function FileList({ items, context }: { items: LibraryItem[]; context: ItemContext }) {
  const canAccessHostFiles = useCapability("hostFiles")
  return (
    <div className="flex flex-col gap-1.5" data-testid="library-files">
      {items.map((item) => {
        const path = canAccessHostFiles ? documentPath(item) : null
        const extra: ItemAction[] = []
        if (canAccessHostFiles && item.present) extra.push({ label: "Open", icon: FolderOpen, run: () => openFile(item.target) })
        if (canAccessHostFiles && item.keptPath) extra.push({ label: "Open saved copy", icon: HardDrive, run: () => openFile(item.keptPath!) })
        return (
          <Row
            key={item.id}
            icon={FileText}
            title={displayName(item)}
            detail={fileDetail(item)}
            item={item}
            context={context}
            onOpen={path ? () => openFile(path) : undefined}
            actions={sharedActions(item, context, extra)}
          />
        )
      })}
    </div>
  )
}
