import { Fragment, useEffect, useRef, useState, type FormEvent, type KeyboardEvent, type RefObject } from "react"
import { AlertCircle, ArrowLeft, ChevronRight, Folder, FolderOpen, FolderPlus, House } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb"
import { Button } from "@/components/ui/button"
import { Command, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command"
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"
import { Input } from "@/components/ui/input"
import { Spinner } from "@/components/ui/Spinner"
import { createFolder, fetchFolderListing, pathCrumbs } from "@/lib/folders"
import { cn } from "@/lib/utils"
import { folderNameProblem, FOLDER_LISTING_LIMIT, type FolderListing } from "../../shared/contracts/folders"

interface FolderBrowserProps {
  /** The machine the folders are on, or null for this one. */
  hostName: string | null
  /** Folders that already are projects, marked in the list. */
  projectPaths: ReadonlySet<string>
  onStart: (cwd: string) => void
  /** Back to the project list. */
  onBack: () => void
}

/** The answer for one request, tagged with it so a late answer to an older one is never shown as current. */
type Loaded = { request: string; listing: FolderListing } | { request: string; error: string }

function messageOf(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback
}

/**
 * The server's folders, one level at a time: where a session starts when the
 * folder is not a project yet, or does not exist yet, on a machine whose paths
 * the user cannot type from memory. Starts in the server's projects root.
 *
 * Keyboard: type to filter, arrows and Enter to open a folder, Backspace in an
 * empty filter to go up, Cmd/Ctrl+Enter to start the session.
 */
export function FolderBrowser({ hostName, projectPaths, onStart, onBack }: FolderBrowserProps) {
  // `path` null is the projects root; each navigation is a new request, so a retry reads again.
  const [target, setTarget] = useState<{ path: string | null; request: number }>({ path: null, request: 0 })
  const request = `${target.request}:${target.path ?? ""}`
  const [loaded, setLoaded] = useState<Loaded | null>(null)
  const [filter, setFilter] = useState("")
  const [highlighted, setHighlighted] = useState("")
  const [naming, setNaming] = useState(false)
  const [newName, setNewName] = useState("")
  const [createError, setCreateError] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const filterRef = useRef<HTMLInputElement>(null)
  const crumbsRef = useRef<HTMLOListElement>(null)
  const keepFocus = useRef(false)

  useEffect(() => {
    const controller = new AbortController()
    fetchFolderListing(target.path, controller.signal)
      .then((listing) => setLoaded({ request, listing }))
      .catch((error: unknown) => {
        if (!controller.signal.aborted) setLoaded({ request, error: messageOf(error, "This folder could not be read") })
      })
    return () => controller.abort()
  }, [request, target.path])

  const busy = loaded?.request !== request
  // While the next folder loads, the last one stays on screen, dimmed.
  const listing = loaded && "listing" in loaded ? loaded.listing : null
  const error = !busy && loaded && "error" in loaded ? loaded.error : null
  const here = busy ? null : listing?.path ?? null
  const query = filter.trim().toLowerCase()
  const folders = listing?.folders.filter((folder) => folder.name.toLowerCase().includes(query)) ?? []
  // Each listing and filter starts on its first folder, so Enter always has somewhere to go.
  const highlight = folders.some((folder) => folder.path === highlighted) ? highlighted : folders[0]?.path ?? ""

  const shownPath = listing?.path
  useEffect(() => {
    const crumbs = crumbsRef.current
    if (crumbs) crumbs.scrollLeft = crumbs.scrollWidth
    // The breadcrumb that had focus is gone once its folder is shown; keep the keyboard in the browser.
    if (keepFocus.current && !rootRef.current?.contains(document.activeElement)) filterRef.current?.focus()
    keepFocus.current = false
  }, [shownPath])

  function open(path: string | null) {
    keepFocus.current = rootRef.current?.contains(document.activeElement) ?? false
    setTarget((current) => ({ path, request: current.request + 1 }))
    setFilter("")
    setNaming(false)
    setNewName("")
    setCreateError(null)
  }

  function start() {
    if (here) onStart(here)
  }

  // Capture phase, ahead of the list's own Enter, which would open the highlighted folder instead.
  function handleKeyDownCapture(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey) && !naming) {
      event.preventDefault()
      start()
    } else if (event.key === "Backspace" && event.target === filterRef.current && filter === "" && listing?.parent && !busy) {
      event.preventDefault()
      open(listing.parent)
    }
  }

  function stopNaming() {
    setNaming(false)
    setNewName("")
    setCreateError(null)
    filterRef.current?.focus()
  }

  async function submitNewFolder(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const name = newName.trim()
    const problem = folderNameProblem(name)
    if (problem) {
      setCreateError(problem)
      return
    }
    if (!here || creating) return
    setCreating(true)
    try {
      const path = await createFolder(here, name)
      open(path)
      filterRef.current?.focus()
    } catch (failure) {
      setCreateError(messageOf(failure, "The folder could not be made"))
    } finally {
      setCreating(false)
    }
  }

  const title = hostName ? `Folders on ${hostName}` : "Folders"

  return (
    <div ref={rootRef} onKeyDownCapture={handleKeyDownCapture} className="flex min-h-0 flex-col bg-popover text-popover-foreground">
      {/* Outside the Command: its Enter handling would take the buttons' Enter for the highlighted folder.
          In a dialog, the right padding keeps clear of the dialog's close button. */}
      <div className="flex items-center gap-1 border-b px-2 py-1.5 in-data-[slot=dialog-content]:pr-12">
        <Button type="button" variant="ghost" size="icon-sm" onClick={onBack} aria-label="Back to projects">
          <ArrowLeft />
        </Button>
        <span className="min-w-0 flex-1 truncate text-sm font-medium">{title}</span>
        {listing && listing.path !== listing.root && (
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            onClick={() => open(null)}
            aria-label="Go to the projects root"
            title={listing.root}
          >
            <House />
          </Button>
        )}
      </div>
      {listing && (
        <FolderCrumbs path={listing.path} top={listing.confined ? listing.root : null} listRef={crumbsRef} onOpen={open} />
      )}
      <Command
        shouldFilter={false}
        label="Filter folders"
        value={highlight}
        onValueChange={setHighlighted}
        className="rounded-none p-0"
      >
        <CommandInput
          ref={filterRef}
          autoFocus
          placeholder="Filter folders..."
          value={filter}
          onValueChange={setFilter}
        />
        <CommandList className="box-content max-h-72 p-1" aria-busy={busy}>
          {error !== null ? (
            <FolderProblem
              message={error}
              onRetry={() => open(target.path)}
              onRoot={target.path === null ? undefined : () => open(null)}
            />
          ) : listing === null ? (
            <div role="status" className="flex items-center justify-center gap-2 py-8 text-sm text-muted-foreground">
              <Spinner className="size-4" />
              Loading folders…
            </div>
          ) : folders.length === 0 ? (
            <Empty className="border-0 py-8">
              <EmptyHeader>
                <EmptyMedia variant="icon"><FolderOpen /></EmptyMedia>
                <EmptyTitle>{query ? "No folder matches" : "No folders here"}</EmptyTitle>
                <EmptyDescription>
                  {query ? "Try another name." : "Start a session right here, or make a new folder."}
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : (
            <CommandGroup className={cn("p-0 transition-opacity", busy && "opacity-50")}>
              {folders.map((folder) => (
                <CommandItem
                  key={folder.path}
                  value={folder.path}
                  onSelect={() => open(folder.path)}
                  // A click keeps the filter focused, so typing and Backspace go on working.
                  onMouseDown={(event) => event.preventDefault()}
                  className="motion-list-item h-auto gap-3 px-3 py-2"
                >
                  <Folder className="size-4 shrink-0 text-muted-foreground" />
                  <span className="min-w-0 flex-1 truncate">{folder.name}</span>
                  {projectPaths.has(folder.path) && <Badge variant="secondary">Project</Badge>}
                  <ChevronRight className="size-4 shrink-0 text-muted-foreground" />
                </CommandItem>
              ))}
              {listing.truncated && (
                <p className="px-3 py-2 text-xs text-muted-foreground">
                  Showing the first {FOLDER_LISTING_LIMIT.toLocaleString()} folders.
                </p>
              )}
            </CommandGroup>
          )}
        </CommandList>
      </Command>
      <div className="flex flex-col gap-1.5 border-t p-2">
        {naming ? (
          <form onSubmit={(event) => void submitNewFolder(event)} className="flex items-center gap-2">
            <Input
              autoFocus
              aria-label="New folder name"
              placeholder="New folder name"
              value={newName}
              disabled={creating}
              aria-invalid={createError ? true : undefined}
              onChange={(event) => {
                setNewName(event.target.value)
                setCreateError(null)
              }}
              onKeyDown={(event) => {
                if (event.key !== "Escape") return
                event.preventDefault()
                event.stopPropagation()
                stopNaming()
              }}
            />
            <Button type="submit" size="sm" disabled={creating || !here || newName.trim() === ""}>
              {creating && <Spinner data-icon="inline-start" className="size-4" />}
              Create
            </Button>
            <Button type="button" variant="ghost" size="sm" onClick={stopNaming}>
              Cancel
            </Button>
          </form>
        ) : (
          <div className="flex items-center gap-2">
            <Button type="button" variant="ghost" size="sm" disabled={!here} onClick={() => setNaming(true)}>
              <FolderPlus data-icon="inline-start" />
              New folder
            </Button>
            <Button
              type="button"
              size="sm"
              className="ml-auto"
              disabled={!here}
              onClick={start}
              aria-keyshortcuts="Meta+Enter Control+Enter"
            >
              Start session here
            </Button>
          </div>
        )}
        {createError && <p role="alert" className="px-1 text-xs text-destructive">{createError}</p>}
      </div>
    </div>
  )
}

/** The listed folder's path, each folder above it a link. Scrolled to its end, where the user is. */
function FolderCrumbs({
  path,
  top,
  listRef,
  onOpen,
}: {
  path: string
  top: string | null
  listRef: RefObject<HTMLOListElement | null>
  onOpen: (path: string) => void
}) {
  const crumbs = pathCrumbs(path, top)
  return (
    <Breadcrumb className="border-b px-3 py-1.5">
      <BreadcrumbList ref={listRef} className="no-scrollbar flex-nowrap gap-1 overflow-x-auto text-xs">
        {crumbs.map((crumb, index) => (
          <Fragment key={crumb.path}>
            {index > 0 && <BreadcrumbSeparator />}
            <BreadcrumbItem className="shrink-0">
              {index === crumbs.length - 1 ? (
                <BreadcrumbPage>{crumb.label}</BreadcrumbPage>
              ) : (
                <BreadcrumbLink render={<button type="button" onClick={() => onOpen(crumb.path)} />}>
                  {crumb.label}
                </BreadcrumbLink>
              )}
            </BreadcrumbItem>
          </Fragment>
        ))}
      </BreadcrumbList>
    </Breadcrumb>
  )
}

function FolderProblem({ message, onRetry, onRoot }: { message: string; onRetry: () => void; onRoot?: () => void }) {
  return (
    <Empty className="border-0 py-8">
      <EmptyHeader>
        <EmptyMedia variant="icon"><AlertCircle /></EmptyMedia>
        <EmptyTitle>This folder could not be opened</EmptyTitle>
        <EmptyDescription>{message}</EmptyDescription>
      </EmptyHeader>
      <div className="flex gap-2">
        <Button type="button" variant="outline" size="sm" onClick={onRetry}>Try again</Button>
        {onRoot && <Button type="button" variant="ghost" size="sm" onClick={onRoot}>Go to the projects root</Button>}
      </div>
    </Empty>
  )
}
