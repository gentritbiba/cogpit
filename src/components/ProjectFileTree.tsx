import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { AlertTriangle, ChevronRight, Folder, FolderOpen, FolderTree, type LucideIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty"
import { Spinner } from "@/components/ui/Spinner"
import { authFetch } from "@/lib/auth"
import { fileTypeIcon } from "@/lib/fileTypeColors"
import { cn } from "@/lib/utils"
import type { ProjectTreeEntry } from "../../shared/contracts/projectTools"

export interface FileStatusMark {
  code: string
  label: string
  className: string
}

interface ProjectFileTreeProps {
  cwd: string
  selectedPath: string | null
  onSelect: (path: string) => void
  /** Git status for a file, if it is changed. */
  fileStatus: (path: string) => FileStatusMark | null
  /** Bumped by the parent to re-read every open directory, bypassing the server cache. */
  reloadToken: number
}

type DirectoryState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; entries: ProjectTreeEntry[]; scanLimited: boolean }

const INDENT_PX = 12
const ROW_CLASS = "h-6 w-full justify-start gap-1 rounded-none px-2 text-left font-normal"

/** Rows without a chevron of their own line up past where one would be. */
function indentStyle(depth: number, hasChevron: boolean) {
  return { paddingLeft: 8 + depth * INDENT_PX + (hasChevron ? 0 : 16) }
}

function isTreeEntry(value: unknown): value is ProjectTreeEntry {
  const entry = value as ProjectTreeEntry | null
  return typeof entry === "object" && entry !== null
    && typeof entry.name === "string"
    && (entry.type === "file" || entry.type === "directory")
}

function parseEntries(data: unknown): ProjectTreeEntry[] {
  const entries = (data as { entries?: unknown })?.entries
  return Array.isArray(entries) ? entries.filter(isTreeEntry) : []
}

async function fetchDirectory(cwd: string, directory: string, refresh: boolean): Promise<DirectoryState> {
  try {
    const response = await authFetch(
      `/api/project-files/tree?cwd=${encodeURIComponent(cwd)}&dir=${encodeURIComponent(directory)}${refresh ? "&refresh=1" : ""}`,
    )
    if (!response.ok) {
      const body: unknown = await response.json().catch(() => null)
      const message = (body as { error?: unknown } | null)?.error
      throw new Error(typeof message === "string" ? message : "Unable to list directory")
    }
    const data: unknown = await response.json()
    return {
      status: "ready",
      entries: parseEntries(data),
      scanLimited: (data as { scanLimited?: unknown }).scanLimited === true,
    }
  } catch (error) {
    return { status: "error", message: error instanceof Error ? error.message : "Unable to list directory" }
  }
}

/** Every directory prefix of `path`, shallowest first. */
function ancestorsOf(path: string): string[] {
  const segments = path.split("/")
  return segments.slice(0, -1).map((_, index) => segments.slice(0, index + 1).join("/"))
}

export function ProjectFileTree({ cwd, selectedPath, onSelect, fileStatus, reloadToken }: ProjectFileTreeProps) {
  const [directories, setDirectories] = useState<Map<string, DirectoryState>>(() => new Map())
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set())
  const inFlightRef = useRef<Set<string>>(new Set())
  const cwdRef = useRef(cwd)
  cwdRef.current = cwd

  const loadDirectory = useCallback(async (directory: string) => {
    if (inFlightRef.current.has(directory)) return
    inFlightRef.current.add(directory)
    setDirectories((current) => new Map(current).set(directory, { status: "loading" }))
    const result = await fetchDirectory(cwd, directory, false)
    inFlightRef.current.delete(directory)
    if (cwdRef.current !== cwd) return
    setDirectories((current) => new Map(current).set(directory, result))
  }, [cwd])

  // The root is (re)read here; children load themselves once it is ready, so a
  // refresh — which bypasses the server cache for the root read — never lets
  // an open directory re-read from the stale cache first.
  const loadedCwdRef = useRef<string | null>(null)
  useEffect(() => {
    const refresh = loadedCwdRef.current === cwd
    loadedCwdRef.current = cwd
    if (!refresh) setExpanded(new Set())
    setDirectories(new Map([["", { status: "loading" }]]))
    let cancelled = false
    void fetchDirectory(cwd, "", refresh).then((root) => {
      if (!cancelled) setDirectories(new Map([["", root]]))
    })
    return () => {
      cancelled = true
    }
  }, [cwd, reloadToken])

  // Keep the open file visible: expand every directory on its path.
  useEffect(() => {
    if (!selectedPath) return
    const ancestors = ancestorsOf(selectedPath)
    if (ancestors.length === 0) return
    setExpanded((current) => {
      if (ancestors.every((directory) => current.has(directory))) return current
      const next = new Set(current)
      for (const directory of ancestors) next.add(directory)
      return next
    })
  }, [selectedPath])

  const toggle = useCallback((directory: string) => {
    setExpanded((current) => {
      const next = new Set(current)
      if (next.has(directory)) next.delete(directory)
      else next.add(directory)
      return next
    })
  }, [])

  const root = directories.get("")
  const placeholder = rootPlaceholder(root)
  return (
    <div aria-label="Project file tree" className="flex flex-col py-1">
      {placeholder ? (
        <Empty className="min-h-48 rounded-none p-4">
          <EmptyHeader>
            <EmptyMedia variant="icon"><placeholder.Icon /></EmptyMedia>
            <EmptyTitle>{placeholder.title}</EmptyTitle>
            <EmptyDescription>{placeholder.description}</EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <DirectoryChildren
          directory=""
          depth={0}
          state={root}
          directories={directories}
          expanded={expanded}
          selectedPath={selectedPath}
          onSelect={onSelect}
          onToggle={toggle}
          onLoad={loadDirectory}
          fileStatus={fileStatus}
        />
      )}
      {root?.status === "ready" && root.scanLimited && (
        <p className="px-3 py-2 text-xs text-muted-foreground">This project is too large to scan completely.</p>
      )}
    </div>
  )
}

function rootPlaceholder(root: DirectoryState | undefined): { Icon: LucideIcon; title: string; description: string } | null {
  if (root?.status === "error") return { Icon: AlertTriangle, title: "Could not load files", description: root.message }
  if (root?.status === "ready" && root.entries.length === 0) {
    return { Icon: FolderTree, title: "No files", description: "This project has no files to show." }
  }
  return null
}

interface DirectoryChildrenProps {
  directory: string
  depth: number
  state: DirectoryState | undefined
  directories: Map<string, DirectoryState>
  expanded: Set<string>
  selectedPath: string | null
  onSelect: (path: string) => void
  onToggle: (directory: string) => void
  onLoad: (directory: string) => void
  fileStatus: (path: string) => FileStatusMark | null
}

function DirectoryChildren({ directory, depth, state, onLoad, ...rest }: DirectoryChildrenProps) {
  useEffect(() => {
    if (state === undefined && directory !== "") onLoad(directory)
  }, [directory, onLoad, state])

  if (!state || state.status === "loading") {
    return (
      <div
        role="status"
        className="flex h-6 items-center gap-2 text-xs text-muted-foreground"
        style={indentStyle(depth, false)}
      >
        <Spinner className="size-3" />
        {directory === "" && "Loading files…"}
      </div>
    )
  }
  if (state.status === "error") {
    return (
      <div
        role="alert"
        className="flex h-6 items-center gap-1.5 truncate text-xs text-destructive"
        style={indentStyle(depth, false)}
        title={state.message}
      >
        <AlertTriangle aria-hidden="true" className="size-3 shrink-0" />
        <span className="truncate">{state.message}</span>
      </div>
    )
  }
  return (
    <>
      {state.entries.map((entry) => {
        const path = directory ? `${directory}/${entry.name}` : entry.name
        return entry.type === "directory" ? (
          <DirectoryNode
            key={path}
            path={path}
            name={entry.name}
            depth={depth}
            onLoad={onLoad}
            {...rest}
          />
        ) : (
          <FileRow
            key={path}
            path={path}
            name={entry.name}
            depth={depth}
            selected={rest.selectedPath === path}
            status={rest.fileStatus(path)}
            onSelect={rest.onSelect}
          />
        )
      })}
    </>
  )
}

type DirectoryNodeProps = Omit<DirectoryChildrenProps, "directory" | "state"> & { path: string; name: string }

function DirectoryNode({ path, name, depth, ...rest }: DirectoryNodeProps) {
  const open = rest.expanded.has(path)
  const FolderIcon = open ? FolderOpen : Folder
  return (
    <div>
      <Button
        variant="ghost"
        size="sm"
        aria-expanded={open}
        className={ROW_CLASS}
        style={indentStyle(depth, true)}
        onClick={() => rest.onToggle(path)}
        title={path}
      >
        <ChevronRight
          aria-hidden="true"
          className={cn("size-3 shrink-0 text-muted-foreground transition-transform", open && "rotate-90")}
        />
        <FolderIcon aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate text-xs">{name}</span>
      </Button>
      {open && (
        <div>
          <DirectoryChildren
            directory={path}
            depth={depth + 1}
            state={rest.directories.get(path)}
            {...rest}
          />
        </div>
      )}
    </div>
  )
}

interface FileRowProps {
  path: string
  name: string
  depth: number
  selected: boolean
  status: FileStatusMark | null
  onSelect: (path: string) => void
}

function FileRow({ path, name, depth, selected, status, onSelect }: FileRowProps) {
  const ref = useRef<HTMLButtonElement>(null)
  const FileIcon = useMemo(() => fileTypeIcon(path), [path])

  useEffect(() => {
    if (selected) ref.current?.scrollIntoView?.({ block: "nearest" })
  }, [selected])

  return (
    <Button
      ref={ref}
      aria-current={selected || undefined}
      variant={selected ? "secondary" : "ghost"}
      size="sm"
      className={ROW_CLASS}
      style={indentStyle(depth, false)}
      onClick={() => onSelect(path)}
      title={path}
    >
      <FileIcon aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground" />
      <span className={cn("min-w-0 flex-1 truncate text-xs", status && status.className)}>{name}</span>
      {status && (
        <span className={cn("shrink-0 font-mono text-[10px]", status.className)} title={status.label}>
          {status.code}
        </span>
      )}
    </Button>
  )
}
