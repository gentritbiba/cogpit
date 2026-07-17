import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { AlertTriangle, FileCode2, FolderTree, GitBranch, MessageSquarePlus, RefreshCw, Save, X } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty"
import { Input } from "@/components/ui/input"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Separator } from "@/components/ui/separator"
import { Spinner } from "@/components/ui/Spinner"
import { Textarea } from "@/components/ui/textarea"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { authFetch } from "@/lib/auth"
import { matchesKeybinding } from "@/lib/keybindings"
import { cn } from "@/lib/utils"
import { parseProjectFilesResponse } from "@/hooks/useProjectFileSuggestions"

interface ProjectFilesPanelProps {
  cwd: string
  onClose: () => void
  onAddToPrompt?: (context: ProjectPromptContext) => void
}

export interface ProjectPromptContext {
  path: string
  text?: string
  startLine?: number
  endLine?: number
  comment?: string
}

interface ProjectFileData {
  content: string
  mtimeMs: number
  size: number
}

interface GitStatusFile {
  path: string
  originalPath?: string
  indexStatus: string
  workTreeStatus: string
}

interface GitStatusData {
  isRepository: boolean
  branch?: string | null
  upstream?: string | null
  ahead?: number
  behind?: number
  detached?: boolean
  files: GitStatusFile[]
}

const MIN_WIDTH = 520
const DEFAULT_WIDTH = 760
const WIDTH_KEY = "cogpit-project-files-width"

function loadWidth(): number {
  try {
    const stored = Number(localStorage.getItem(WIDTH_KEY))
    if (Number.isFinite(stored) && stored >= MIN_WIDTH) return stored
  } catch {
    // Use the default when storage is unavailable.
  }
  return DEFAULT_WIDTH
}

async function responseError(response: Response, fallback: string): Promise<string> {
  try {
    const data: unknown = await response.json()
    if (data && typeof data === "object" && typeof (data as { error?: unknown }).error === "string") {
      return (data as { error: string }).error
    }
  } catch {
    // Use the fallback for malformed error responses.
  }
  return fallback
}

function displayBytes(value: number): string {
  if (value < 1024) return `${value} B`
  return `${(value / 1024).toFixed(value < 10 * 1024 ? 1 : 0)} KB`
}

export function ProjectFilesPanel({ cwd, onClose, onAddToPrompt }: ProjectFilesPanelProps) {
  const panelRef = useRef<HTMLElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const editorRef = useRef<HTMLTextAreaElement>(null)
  const dragRef = useRef<{ startX: number; startWidth: number } | null>(null)
  const [width, setWidth] = useState(loadWidth)
  const [query, setQuery] = useState("")
  const [files, setFiles] = useState<string[]>([])
  const [filesLoading, setFilesLoading] = useState(true)
  const [filesError, setFilesError] = useState<string | null>(null)
  const [truncated, setTruncated] = useState(false)
  const [selectedPath, setSelectedPath] = useState<string | null>(null)
  const [content, setContent] = useState("")
  const [savedContent, setSavedContent] = useState("")
  const [mtimeMs, setMtimeMs] = useState<number | null>(null)
  const [size, setSize] = useState(0)
  const [fileLoading, setFileLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [fileError, setFileError] = useState<string | null>(null)
  const [savedNotice, setSavedNotice] = useState(false)
  const [fileScope, setFileScope] = useState<"all" | "changes">("all")
  const [gitStatus, setGitStatus] = useState<GitStatusData | null>(null)
  const [gitLoading, setGitLoading] = useState(false)
  const [gitError, setGitError] = useState<string | null>(null)
  const [selectedExcerpt, setSelectedExcerpt] = useState<Omit<ProjectPromptContext, "path"> | null>(null)
  const [reviewDraft, setReviewDraft] = useState<Omit<ProjectPromptContext, "path"> | null>(null)
  const [reviewComment, setReviewComment] = useState("")
  const dirty = selectedPath !== null && content !== savedContent

  const loadGitStatus = useCallback(async () => {
    setGitLoading(true)
    setGitError(null)
    try {
      const response = await authFetch(`/api/git-status?cwd=${encodeURIComponent(cwd)}`)
      if (!response.ok) throw new Error(await responseError(response, "Unable to read git status"))
      const data = await response.json() as GitStatusData
      setGitStatus(data)
      if (!data.isRepository) setFileScope("all")
    } catch (error) {
      setGitStatus(null)
      setFileScope("all")
      setGitError(error instanceof Error ? error.message : "Unable to read git status")
    } finally {
      setGitLoading(false)
    }
  }, [cwd])

  useEffect(() => {
    void loadGitStatus()
  }, [loadGitStatus])

  useEffect(() => {
    const controller = new AbortController()
    const timer = window.setTimeout(async () => {
      setFilesLoading(true)
      setFilesError(null)
      try {
        const response = await authFetch(
          `/api/project-files?cwd=${encodeURIComponent(cwd)}&q=${encodeURIComponent(query)}&limit=100`,
          { signal: controller.signal },
        )
        if (!response.ok) throw new Error(await responseError(response, "Unable to list project files"))
        const data: unknown = await response.json()
        if (controller.signal.aborted) return
        setFiles(parseProjectFilesResponse(data))
        setTruncated((data as { truncated?: unknown }).truncated === true)
      } catch (error) {
        if (!controller.signal.aborted) {
          setFiles([])
          setFilesError(error instanceof Error ? error.message : "Unable to list project files")
        }
      } finally {
        if (!controller.signal.aborted) setFilesLoading(false)
      }
    }, 120)

    return () => {
      window.clearTimeout(timer)
      controller.abort()
    }
  }, [cwd, query])

  useEffect(() => {
    setSelectedPath(null)
    setContent("")
    setSavedContent("")
    setMtimeMs(null)
    setFileError(null)
    setSelectedExcerpt(null)
  }, [cwd])

  useEffect(() => {
    if (!dirty) return
    const warn = (event: BeforeUnloadEvent) => event.preventDefault()
    window.addEventListener("beforeunload", warn)
    return () => window.removeEventListener("beforeunload", warn)
  }, [dirty])

  const loadFile = useCallback(async (path: string) => {
    setSelectedPath(path)
    setFileLoading(true)
    setFileError(null)
    setSavedNotice(false)
    setSelectedExcerpt(null)
    try {
      const response = await authFetch(
        `/api/project-file?cwd=${encodeURIComponent(cwd)}&path=${encodeURIComponent(path)}`,
      )
      if (!response.ok) throw new Error(await responseError(response, "Unable to open file"))
      const data = await response.json() as ProjectFileData
      setContent(data.content)
      setSavedContent(data.content)
      setMtimeMs(data.mtimeMs)
      setSize(data.size)
      requestAnimationFrame(() => editorRef.current?.focus())
    } catch (error) {
      setContent("")
      setSavedContent("")
      setMtimeMs(null)
      setFileError(error instanceof Error ? error.message : "Unable to open file")
    } finally {
      setFileLoading(false)
    }
  }, [cwd])

  const selectFile = useCallback((path: string) => {
    if (path === selectedPath) return
    if (dirty && !window.confirm("Discard unsaved changes and open another file?")) return
    void loadFile(path)
  }, [dirty, loadFile, selectedPath])

  const saveFile = useCallback(async () => {
    if (!selectedPath || mtimeMs === null || !dirty || saving) return
    setSaving(true)
    setFileError(null)
    setSavedNotice(false)
    try {
      const response = await authFetch("/api/project-file", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cwd, path: selectedPath, content, expectedMtimeMs: mtimeMs }),
      })
      if (!response.ok) throw new Error(await responseError(response, "Unable to save file"))
      const data = await response.json() as { mtimeMs: number; size: number }
      setSavedContent(content)
      setMtimeMs(data.mtimeMs)
      setSize(data.size)
      setSavedNotice(true)
      void loadGitStatus()
    } catch (error) {
      setFileError(error instanceof Error ? error.message : "Unable to save file")
    } finally {
      setSaving(false)
    }
  }, [content, cwd, dirty, loadGitStatus, mtimeMs, saving, selectedPath])

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (!panelRef.current?.contains(document.activeElement)) return
      if (matchesKeybinding("projectFileSave", event)) {
        event.preventDefault()
        void saveFile()
      }
    }
    window.addEventListener("keydown", handleKeyDown)
    return () => window.removeEventListener("keydown", handleKeyDown)
  }, [saveFile])

  const closePanel = useCallback(() => {
    if (dirty && !window.confirm("Close the file workspace and discard unsaved changes?")) return
    onClose()
  }, [dirty, onClose])

  const handleEditorKeyDown = useCallback((event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== "Tab") return
    event.preventDefault()
    const target = event.currentTarget
    const start = target.selectionStart
    const end = target.selectionEnd
    const next = `${content.slice(0, start)}  ${content.slice(end)}`
    setContent(next)
    setSavedNotice(false)
    setSelectedExcerpt(null)
    requestAnimationFrame(() => {
      target.selectionStart = start + 2
      target.selectionEnd = start + 2
    })
  }, [content])

  const captureEditorSelection = useCallback((event: React.SyntheticEvent<HTMLTextAreaElement>) => {
    const target = event.currentTarget
    if (target.selectionStart === target.selectionEnd) {
      setSelectedExcerpt(null)
      return
    }
    const text = content.slice(target.selectionStart, target.selectionEnd)
    const startLine = content.slice(0, target.selectionStart).split("\n").length
    const endLine = startLine + text.split("\n").length - 1
    setSelectedExcerpt({ text, startLine, endLine })
  }, [content])

  const handlePointerDown = useCallback((event: React.PointerEvent) => {
    event.preventDefault()
    dragRef.current = { startX: event.clientX, startWidth: width }
    event.currentTarget.setPointerCapture(event.pointerId)
  }, [width])

  const handlePointerMove = useCallback((event: React.PointerEvent) => {
    if (!dragRef.current) return
    const maxWidth = Math.max(MIN_WIDTH, window.innerWidth * 0.9)
    const next = dragRef.current.startWidth + (dragRef.current.startX - event.clientX)
    setWidth(Math.min(maxWidth, Math.max(MIN_WIDTH, next)))
  }, [])

  const handlePointerUp = useCallback(() => {
    if (!dragRef.current) return
    dragRef.current = null
    setWidth((current) => {
      try {
        localStorage.setItem(WIDTH_KEY, String(current))
      } catch {
        // Ignore persistence failures.
      }
      return current
    })
  }, [])

  const selectedName = useMemo(() => selectedPath?.split("/").at(-1) ?? null, [selectedPath])
  const changedFiles = useMemo(() => new Map(
    (gitStatus?.files ?? []).flatMap((file) => [
      [file.path, file] as const,
      ...(file.originalPath ? [[file.originalPath, file] as const] : []),
    ]),
  ), [gitStatus?.files])
  const displayedFiles = useMemo(() => {
    if (fileScope === "all") return files
    const normalizedQuery = query.trim().toLowerCase()
    return (gitStatus?.files ?? [])
      .map((file) => file.path)
      .filter((path, index, values) => values.indexOf(path) === index)
      .filter((path) => !normalizedQuery || path.toLowerCase().includes(normalizedQuery))
      .sort((a, b) => a.localeCompare(b))
  }, [fileScope, files, gitStatus?.files, query])
  const listLoading = fileScope === "changes" ? gitLoading : filesLoading
  const listError = fileScope === "changes" ? gitError : filesError

  return (
    <aside
      ref={panelRef}
      aria-label="Project files"
      className="relative flex min-h-0 shrink-0 flex-col border-l border-border bg-elevation-0"
      style={{ width }}
    >
      <div
        aria-hidden="true"
        className="absolute inset-y-0 left-0 w-1 cursor-col-resize hover:bg-primary/30"
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
      />

      <div className="flex h-10 shrink-0 items-center gap-2 px-3">
        <FolderTree aria-hidden="true" className="size-4 text-muted-foreground" />
        <h2 className="text-sm font-medium">Project files</h2>
        <span className="min-w-0 flex-1 truncate font-mono text-[10px] text-muted-foreground" title={cwd}>
          {cwd}
        </span>
        <Button variant="ghost" size="icon-sm" onClick={closePanel} aria-label="Close project files">
          <X data-icon="inline-start" />
        </Button>
      </div>

      <Separator />

      {gitStatus?.isRepository && (
        <>
          <div className="flex h-8 shrink-0 items-center gap-2 px-3 text-[10px] text-muted-foreground">
            <GitBranch aria-hidden="true" className="size-3.5" />
            <span className="max-w-40 truncate font-mono text-foreground" title={gitStatus.branch ?? "Detached HEAD"}>
              {gitStatus.branch ?? "detached HEAD"}
            </span>
            {gitStatus.upstream && <span className="truncate">tracks {gitStatus.upstream}</span>}
            {(gitStatus.ahead ?? 0) > 0 && <Badge variant="outline">↑ {gitStatus.ahead}</Badge>}
            {(gitStatus.behind ?? 0) > 0 && <Badge variant="outline">↓ {gitStatus.behind}</Badge>}
            <span className="flex-1" />
            <span>{gitStatus.files.length} changed</span>
            <Button
              variant="ghost"
              size="icon-sm"
              disabled={gitLoading}
              onClick={() => void loadGitStatus()}
              aria-label="Refresh git status"
              title="Refresh git status"
            >
              <RefreshCw data-icon="inline-start" className={gitLoading ? "animate-spin" : undefined} />
            </Button>
          </div>
          <Separator />
        </>
      )}

      <div className="flex min-h-0 flex-1">
        <section aria-label="File browser" className="flex w-56 shrink-0 flex-col">
          <div className="flex flex-col gap-2 p-2">
            <Input
              ref={searchRef}
              aria-label="Search project files"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Filter files…"
              spellCheck={false}
            />
            {gitStatus?.isRepository && (
              <ToggleGroup
                aria-label="File scope"
                value={[fileScope]}
                onValueChange={(values) => {
                  const next = values[0]
                  if (next === "all" || next === "changes") setFileScope(next)
                }}
                variant="outline"
                size="sm"
                spacing={0}
                className="w-full"
              >
                <ToggleGroupItem value="all" className="flex-1">All files</ToggleGroupItem>
                <ToggleGroupItem value="changes" className="flex-1">Changes</ToggleGroupItem>
              </ToggleGroup>
            )}
          </div>
          <Separator />
          <ScrollArea className="min-h-0 flex-1">
            {listLoading ? (
              <div className="flex items-center justify-center gap-2 p-6 text-xs text-muted-foreground" role="status">
                <Spinner />
                Loading files…
              </div>
            ) : listError ? (
              <Empty className="min-h-48 rounded-none p-4">
                <EmptyHeader>
                  <EmptyMedia variant="icon"><AlertTriangle /></EmptyMedia>
                  <EmptyTitle>Could not load files</EmptyTitle>
                  <EmptyDescription>{listError}</EmptyDescription>
                </EmptyHeader>
              </Empty>
            ) : displayedFiles.length === 0 ? (
              <Empty className="min-h-48 rounded-none p-4">
                <EmptyHeader>
                  <EmptyMedia variant="icon"><FolderTree /></EmptyMedia>
                  <EmptyTitle>{fileScope === "changes" ? "No working-tree changes" : "No matching files"}</EmptyTitle>
                  <EmptyDescription>
                    {fileScope === "changes" ? "This project has no changed files matching the filter." : "Try a different path or filename."}
                  </EmptyDescription>
                </EmptyHeader>
              </Empty>
            ) : (
              <div className="flex flex-col py-1">
                {displayedFiles.map((path) => {
                  const name = path.split("/").at(-1) ?? path
                  const directory = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : ""
                  const gitFile = changedFiles.get(path)
                  const status = gitFile ? `${gitFile.indexStatus}${gitFile.workTreeStatus}`.trim() || "?" : null
                  return (
                    <Button
                      key={path}
                      variant={selectedPath === path ? "secondary" : "ghost"}
                      size="sm"
                      className="h-auto w-full justify-start rounded-none px-2 py-1.5 text-left"
                      onClick={() => selectFile(path)}
                      title={path}
                    >
                      <FileCode2 data-icon="inline-start" />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-xs">{name}</span>
                        {directory && <span className="block truncate font-mono text-[9px] text-muted-foreground">{directory}</span>}
                      </span>
                      {status && <Badge variant="outline" className="font-mono">{status}</Badge>}
                    </Button>
                  )
                })}
                {fileScope === "all" && truncated && (
                  <p className="px-3 py-2 text-[10px] text-muted-foreground">
                    Showing the first 100 results. Type to narrow the list.
                  </p>
                )}
              </div>
            )}
          </ScrollArea>
        </section>

        <Separator orientation="vertical" />

        <section aria-label="File editor" className="flex min-w-0 flex-1 flex-col">
          {selectedPath ? (
            <>
              <div className="flex h-10 shrink-0 items-center gap-2 px-3">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-xs font-medium" title={selectedPath}>{selectedName}</p>
                  <p className="truncate font-mono text-[9px] text-muted-foreground">{selectedPath}</p>
                </div>
                {dirty && <Badge variant="outline">Unsaved</Badge>}
                {!dirty && savedNotice && <Badge variant="secondary">Saved</Badge>}
                {mtimeMs !== null && <span className="text-[10px] text-muted-foreground">{displayBytes(size)}</span>}
                {onAddToPrompt && (
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={fileLoading || mtimeMs === null}
                    onClick={() => {
                      if (selectedExcerpt) {
                        setReviewComment("")
                        setReviewDraft(selectedExcerpt)
                      } else {
                        onAddToPrompt({ path: selectedPath })
                      }
                    }}
                    aria-label={selectedExcerpt ? "Add selected lines to prompt" : "Reference file in prompt"}
                    title={selectedExcerpt ? "Add selected lines to prompt" : "Reference file in prompt"}
                  >
                    <MessageSquarePlus data-icon="inline-start" />
                    {selectedExcerpt ? "Add selection" : "Reference"}
                  </Button>
                )}
                <Button
                  variant="ghost"
                  size="icon-sm"
                  disabled={fileLoading || saving}
                  onClick={() => void loadFile(selectedPath)}
                  aria-label="Reload file"
                  title="Reload file"
                >
                  <RefreshCw data-icon="inline-start" />
                </Button>
                <Button size="sm" disabled={!dirty || fileLoading || saving || mtimeMs === null} onClick={() => void saveFile()}>
                  {saving ? <Spinner data-icon="inline-start" /> : <Save data-icon="inline-start" />}
                  {saving ? "Saving…" : "Save"}
                </Button>
              </div>
              <Separator />
              {fileError && (
                <div role="alert" className="flex items-center gap-2 px-3 py-2 text-xs text-destructive">
                  <AlertTriangle aria-hidden="true" className="size-4 shrink-0" />
                  <span>{fileError}</span>
                </div>
              )}
              <div className="min-h-0 flex-1">
                {fileLoading ? (
                  <div className="flex size-full items-center justify-center gap-2 text-xs text-muted-foreground" role="status">
                    <Spinner />
                    Opening file…
                  </div>
                ) : mtimeMs !== null ? (
                  <Textarea
                    ref={editorRef}
                    aria-label={`Editing ${selectedPath}`}
                    value={content}
                    onChange={(event) => {
                      setContent(event.target.value)
                      setSavedNotice(false)
                      setSelectedExcerpt(null)
                    }}
                    onKeyDown={handleEditorKeyDown}
                    onSelect={captureEditorSelection}
                    spellCheck={false}
                    className={cn(
                      "size-full min-h-0 resize-none rounded-none border-0 font-mono text-xs leading-relaxed",
                      "focus-visible:border-transparent focus-visible:ring-0",
                    )}
                  />
                ) : null}
              </div>
            </>
          ) : (
            <Empty className="rounded-none">
              <EmptyHeader>
                <EmptyMedia variant="icon"><FileCode2 /></EmptyMedia>
                <EmptyTitle>Select a file</EmptyTitle>
                <EmptyDescription>Browse or filter project files, then open one to inspect and edit it.</EmptyDescription>
              </EmptyHeader>
            </Empty>
          )}
        </section>
      </div>

      <Dialog
        open={reviewDraft !== null}
        onOpenChange={(open) => {
          if (!open) setReviewDraft(null)
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Comment on selected lines</DialogTitle>
            <DialogDescription>
              Add a review instruction for {selectedPath} lines {reviewDraft?.startLine}-{reviewDraft?.endLine}.
            </DialogDescription>
          </DialogHeader>
          <form
            className="flex flex-col gap-4"
            onSubmit={(event) => {
              event.preventDefault()
              const comment = reviewComment.trim()
              if (!selectedPath || !reviewDraft || !comment || !onAddToPrompt) return
              onAddToPrompt({ path: selectedPath, ...reviewDraft, comment })
              setReviewDraft(null)
              setReviewComment("")
            }}
          >
            <Textarea
              autoFocus
              aria-label="Review comment"
              value={reviewComment}
              onChange={(event) => setReviewComment(event.target.value)}
              placeholder="Describe the change you want…"
              onKeyDown={(event) => {
                if ((event.metaKey || event.ctrlKey) && event.key === "Enter" && reviewComment.trim()) {
                  event.preventDefault()
                  event.currentTarget.form?.requestSubmit()
                }
              }}
            />
            <DialogFooter>
              <Button type="button" variant="ghost" onClick={() => setReviewDraft(null)}>Cancel</Button>
              <Button type="submit" disabled={!reviewComment.trim()}>
                <MessageSquarePlus data-icon="inline-start" />
                Add to prompt
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </aside>
  )
}
