import { useState } from "react"
import {
  GitBranch,
  Trash2,
  GitPullRequest,
  ExternalLink,
  RefreshCw,
  Sparkles,
  ChevronRight,
  FileCode2,
} from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogMedia,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty"
import { cn } from "@/lib/utils"
import { formatRelativeTime } from "@/lib/format"
import { authFetch } from "@/lib/auth"
import { useCapability } from "@/hooks/useCapability"
import { toast } from "sonner"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import {
  Collapsible,
  CollapsibleTrigger,
  CollapsibleContent,
} from "@/components/ui/collapsible"
import type { WorktreeInfo } from "../../shared/contracts/worktrees"

interface WorktreePanelProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  worktrees: WorktreeInfo[]
  loading: boolean
  dirName: string | null
  onRefetch: () => void
  onOpenSession: (sessionId: string) => void
}

const statusColors: Record<string, string> = {
  M: "text-warning",
  A: "text-success",
  D: "text-destructive",
  R: "text-info",
}

interface DeleteConfirmation {
  worktree: WorktreeInfo
  reason: "dirty" | "unpushed"
}

export function WorktreePanel({
  open,
  onOpenChange,
  worktrees,
  loading,
  dirName,
  onRefetch,
  onOpenSession,
}: WorktreePanelProps) {
  const canManageHostFiles = useCapability("hostFiles")
  const [deleting, setDeleting] = useState<string | null>(null)
  const [creatingPr, setCreatingPr] = useState<string | null>(null)
  const [cleaningUp, setCleaningUp] = useState(false)
  const [deleteConfirmation, setDeleteConfirmation] = useState<DeleteConfirmation | null>(null)
  const [cleanupCandidates, setCleanupCandidates] = useState<string[] | null>(null)

  const deleteWorktree = async (wt: WorktreeInfo) => {
    if (!canManageHostFiles || !dirName) return
    setDeleting(wt.name)
    try {
      await authFetch(`/api/worktrees/${encodeURIComponent(dirName)}/${encodeURIComponent(wt.name)}`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ force: wt.isDirty }),
      })
      onRefetch()
    } catch (err) {
      toast.error(`Failed to delete worktree: ${err instanceof Error ? err.message : "Unknown error"}`)
    } finally {
      setDeleting(null)
    }
  }

  const handleDelete = (wt: WorktreeInfo) => {
    if (!canManageHostFiles || !dirName) return
    if (wt.isDirty) {
      setDeleteConfirmation({ worktree: wt, reason: "dirty" })
      return
    }
    if (wt.commitsAhead > 0) {
      setDeleteConfirmation({ worktree: wt, reason: "unpushed" })
      return
    }
    void deleteWorktree(wt)
  }

  const confirmDelete = () => {
    if (!deleteConfirmation) return
    const { worktree, reason } = deleteConfirmation
    if (reason === "dirty" && worktree.commitsAhead > 0) {
      setDeleteConfirmation({ worktree, reason: "unpushed" })
      return
    }
    setDeleteConfirmation(null)
    void deleteWorktree(worktree)
  }

  const handleCreatePr = async (wt: WorktreeInfo) => {
    if (!canManageHostFiles || !dirName) return
    setCreatingPr(wt.name)
    try {
      const res = await authFetch(`/api/worktrees/${encodeURIComponent(dirName)}/create-pr`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          worktreeName: wt.name,
          title: wt.name.replace(/-/g, " "),
        }),
      })
      if (res.ok) {
        const data = await res.json()
        if (data.url) {
          window.open(data.url, "_blank", "noopener,noreferrer")
        } else {
          toast.warning("PR created but no URL was returned")
        }
      } else {
        const error = await res.json().catch(() => ({ error: "Unknown error" }))
        toast.error(`Failed to create PR: ${error.error || "Unknown error"}`)
      }
    } catch (err) {
      toast.error(`Error creating PR: ${err instanceof Error ? err.message : "Unknown error"}`)
    } finally {
      setCreatingPr(null)
    }
  }

  const handleCleanup = async () => {
    if (!canManageHostFiles || !dirName) return
    setCleaningUp(true)
    try {
      const listRes = await authFetch(`/api/worktrees/${encodeURIComponent(dirName)}/cleanup`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      })
      if (listRes.ok) {
        const { stale } = await listRes.json() as { stale: Array<{ name: string }> }
        if (stale.length === 0) {
          toast.info("No stale worktrees found")
        } else {
          setCleanupCandidates(stale.map((item) => item.name))
        }
      }
    } catch (err) {
      toast.error(`Cleanup failed: ${err instanceof Error ? err.message : "Unknown error"}`)
    } finally {
      setCleaningUp(false)
    }
  }

  const confirmCleanup = async () => {
    if (!canManageHostFiles || !dirName || !cleanupCandidates) return
    const names = cleanupCandidates
    setCleanupCandidates(null)
    setCleaningUp(true)
    try {
      await authFetch(`/api/worktrees/${encodeURIComponent(dirName)}/cleanup`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ confirm: true, names }),
      })
      onRefetch()
    } catch (err) {
      toast.error(`Cleanup failed: ${err instanceof Error ? err.message : "Unknown error"}`)
    } finally {
      setCleaningUp(false)
    }
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent>
        <SheetHeader>
          <div className="flex items-center justify-between pr-8">
            <SheetTitle className="flex items-center gap-2">
              <GitBranch data-icon="inline-start" className="size-4" />
              Worktrees
            </SheetTitle>
            <div className="flex items-center gap-1">
              {canManageHostFiles && (
                <Button
                  variant="ghost"
                  size="icon-xs"
                  onClick={handleCleanup}
                  disabled={cleaningUp}
                  aria-label="Cleanup stale worktrees"
                >
                  <Sparkles data-icon="inline-start" />
                </Button>
              )}
              <Button
                variant="ghost"
                size="icon-xs"
                onClick={onRefetch}
                disabled={loading}
                aria-label="Refresh worktrees"
              >
                <RefreshCw data-icon="inline-start" className={cn(loading && "animate-spin")} />
              </Button>
            </div>
          </div>
          <SheetDescription>Review isolated branches and their file changes.</SheetDescription>
        </SheetHeader>

        <div className="flex flex-1 flex-col gap-2 overflow-y-auto p-3">
          {!dirName && (
            <div className="flex items-center justify-center h-full text-sm text-muted-foreground">
              Select a project to view worktrees
            </div>
          )}

          {dirName && worktrees.length === 0 && !loading && (
            <Empty className="border-0 py-16">
              <EmptyHeader>
                <EmptyMedia variant="icon"><GitBranch /></EmptyMedia>
                <EmptyTitle>No worktrees</EmptyTitle>
                <EmptyDescription>
                Create a new session with &ldquo;Isolate in worktree&rdquo; enabled
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          )}

          {worktrees.map((wt) => {
            const totalAdded = wt.changedFiles?.reduce((s, f) => s + f.additions, 0) ?? 0
            const totalDeleted = wt.changedFiles?.reduce((s, f) => s + f.deletions, 0) ?? 0
            const fileCount = wt.changedFiles?.length ?? 0

            return (
              <div
                key={wt.name}
                className="rounded-lg border bg-card p-3 transition-colors hover:bg-accent/40"
              >
                {/* Header row */}
                <div className="flex items-center justify-between mb-1.5">
                  <div className="flex items-center gap-2 min-w-0">
                    <span className="text-sm font-medium text-foreground truncate">{wt.name}</span>
                    {wt.isDirty && (
                      <span className="flex size-2 shrink-0 rounded-full bg-warning" title="Uncommitted changes" />
                    )}
                    {wt.commitsAhead > 0 && (
                      <Badge variant="outline" className="h-5 shrink-0 px-1.5 text-xs">
                        {wt.commitsAhead} ahead
                      </Badge>
                    )}
                  </div>
                  <div className="flex items-center gap-0.5 shrink-0">
                    {wt.linkedSessions.length > 0 && (
                      <Button
                        variant="ghost"
                        size="icon-xs"
                        onClick={() => onOpenSession(wt.linkedSessions[0])}
                        aria-label="Open session"
                      >
                        <ExternalLink data-icon="inline-start" />
                      </Button>
                    )}
                    {canManageHostFiles && (
                      <>
                        <Button
                          variant="ghost"
                          size="icon-xs"
                          onClick={() => handleCreatePr(wt)}
                          disabled={creatingPr === wt.name || wt.commitsAhead === 0}
                          aria-label="Create PR"
                        >
                          <GitPullRequest data-icon="inline-start" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon-xs"
                          onClick={() => handleDelete(wt)}
                          disabled={deleting === wt.name}
                          className="text-destructive hover:bg-destructive/10 hover:text-destructive"
                          aria-label="Delete worktree"
                        >
                          <Trash2 data-icon="inline-start" />
                        </Button>
                      </>
                    )}
                  </div>
                </div>

                {/* Commit info */}
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  <span className="font-mono shrink-0">{wt.head}</span>
                  <span className="truncate">{wt.headMessage}</span>
                </div>

                {wt.createdAt && (
                  <div className="mt-0.5 text-xs text-muted-foreground">
                    {formatRelativeTime(wt.createdAt)}
                  </div>
                )}

                {/* File changes accordion */}
                {fileCount > 0 && (
                  <Collapsible className="mt-2">
                    <CollapsibleTrigger className="group flex w-full items-center gap-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground">
                      <ChevronRight data-icon="inline-start" className="size-3 transition-transform group-data-open:rotate-90" />
                      <FileCode2 data-icon="inline-start" className="size-3" />
                      <span>
                        {fileCount} file{fileCount !== 1 ? "s" : ""} changed
                      </span>
                      <span className="ml-1">
                        <span className="text-success">+{totalAdded}</span>
                        {" "}
                        <span className="text-destructive">-{totalDeleted}</span>
                      </span>
                    </CollapsibleTrigger>
                    <CollapsibleContent>
                      <div className="mt-1.5 flex flex-col gap-px rounded-md bg-muted/40 p-1.5">
                        {wt.changedFiles.map((f) => (
                          <div key={f.path} className="flex items-center gap-2 px-1 py-0.5 font-mono text-xs">
                            <span className={cn("shrink-0 w-3 text-center", statusColors[f.status] ?? "text-muted-foreground")}>
                              {f.status}
                            </span>
                            <span className="truncate text-foreground/80">{f.path}</span>
                            <span className="ml-auto shrink-0 text-muted-foreground">
                              <span className="text-success">+{f.additions}</span>
                              {" "}
                              <span className="text-destructive">-{f.deletions}</span>
                            </span>
                          </div>
                        ))}
                      </div>
                    </CollapsibleContent>
                  </Collapsible>
                )}
              </div>
            )
          })}
        </div>
      </SheetContent>

      <AlertDialog
        open={deleteConfirmation !== null}
        onOpenChange={(nextOpen) => {
          if (!nextOpen) setDeleteConfirmation(null)
        }}
      >
        <AlertDialogContent size="sm">
          <AlertDialogHeader>
            <AlertDialogMedia className="bg-destructive/10 text-destructive">
              <Trash2 />
            </AlertDialogMedia>
            <AlertDialogTitle>
              {deleteConfirmation?.reason === "dirty"
                ? "Delete worktree with uncommitted changes?"
                : "Delete worktree with unpushed commits?"}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {deleteConfirmation?.reason === "dirty"
                ? `"${deleteConfirmation.worktree.name}" has uncommitted changes.`
                : `"${deleteConfirmation?.worktree.name}" has ${deleteConfirmation?.worktree.commitsAhead} unpushed commit(s).`} {" "}
              Deleting it cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel size="sm">Cancel</AlertDialogCancel>
            <AlertDialogAction variant="destructive" size="sm" onClick={confirmDelete}>
              {deleteConfirmation?.reason === "dirty" && deleteConfirmation.worktree.commitsAhead > 0
                ? "Continue"
                : "Delete worktree"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog
        open={cleanupCandidates !== null}
        onOpenChange={(nextOpen) => {
          if (!nextOpen) setCleanupCandidates(null)
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove stale worktrees?</AlertDialogTitle>
            <AlertDialogDescription>
              {cleanupCandidates?.length} stale worktree{cleanupCandidates?.length === 1 ? "" : "s"} will be removed: {cleanupCandidates?.join(", ")}.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel size="sm">Cancel</AlertDialogCancel>
            <AlertDialogAction variant="destructive" size="sm" onClick={() => void confirmCleanup()}>
              Remove worktrees
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Sheet>
  )
}
