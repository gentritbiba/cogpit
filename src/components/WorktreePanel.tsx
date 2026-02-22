import { useState } from "react"
import {
  GitBranch,
  Trash2,
  GitPullRequest,
  ExternalLink,
  RefreshCw,
  Sparkles,
} from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { cn } from "@/lib/utils"
import { formatRelativeTime } from "@/lib/format"
import { authFetch } from "@/lib/auth"
import type { WorktreeInfo } from "../../server/helpers"

interface WorktreePanelProps {
  worktrees: WorktreeInfo[]
  loading: boolean
  dirName: string | null
  onRefetch: () => void
  onOpenSession: (sessionId: string) => void
}

export function WorktreePanel({
  worktrees,
  loading,
  dirName,
  onRefetch,
  onOpenSession,
}: WorktreePanelProps) {
  const [deleting, setDeleting] = useState<string | null>(null)
  const [creatingPr, setCreatingPr] = useState<string | null>(null)
  const [cleaningUp, setCleaningUp] = useState(false)

  const handleDelete = async (wt: WorktreeInfo) => {
    if (!dirName) return
    const force = wt.isDirty
    if (wt.isDirty && !confirm(`"${wt.name}" has uncommitted changes. Delete anyway?`)) return
    if (wt.commitsAhead > 0 && !confirm(`"${wt.name}" has ${wt.commitsAhead} unpushed commit(s). Delete anyway?`)) return

    setDeleting(wt.name)
    try {
      await authFetch(`/api/worktrees/${encodeURIComponent(dirName)}/${encodeURIComponent(wt.name)}`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ force }),
      })
      onRefetch()
    } catch { /* ignore */ }
    setDeleting(null)
  }

  const handleCreatePr = async (wt: WorktreeInfo) => {
    if (!dirName) return
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
        const { url } = await res.json()
        window.open(url, "_blank")
      }
    } catch { /* ignore */ }
    setCreatingPr(null)
  }

  const handleCleanup = async () => {
    if (!dirName) return
    setCleaningUp(true)
    try {
      const listRes = await authFetch(`/api/worktrees/${encodeURIComponent(dirName)}/cleanup`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      })
      if (listRes.ok) {
        const { stale } = await listRes.json()
        if (stale.length === 0) {
          alert("No stale worktrees found.")
        } else if (confirm(`Remove ${stale.length} stale worktree(s)?\n\n${stale.map((s: { name: string }) => s.name).join("\n")}`)) {
          await authFetch(`/api/worktrees/${encodeURIComponent(dirName)}/cleanup`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ confirm: true, names: stale.map((s: { name: string }) => s.name) }),
          })
          onRefetch()
        }
      }
    } catch { /* ignore */ }
    setCleaningUp(false)
  }

  if (!dirName) {
    return (
      <div className="flex items-center justify-center h-full text-sm text-muted-foreground">
        Select a project to view worktrees
      </div>
    )
  }

  return (
    <div className="flex flex-col h-full w-72 shrink-0 border-l border-border bg-elevation-0">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-border">
        <h2 className="text-sm font-medium flex items-center gap-2">
          <GitBranch className="size-4" />
          Worktrees
        </h2>
        <div className="flex items-center gap-1">
          <button
            onClick={handleCleanup}
            disabled={cleaningUp}
            className="rounded-md px-2 py-1 text-xs text-muted-foreground hover:text-foreground hover:bg-elevation-1 transition-colors"
            title="Cleanup stale worktrees"
          >
            <Sparkles className="size-3.5" />
          </button>
          <button
            onClick={onRefetch}
            disabled={loading}
            className="rounded-md px-2 py-1 text-xs text-muted-foreground hover:text-foreground hover:bg-elevation-1 transition-colors"
            title="Refresh"
          >
            <RefreshCw className={cn("size-3.5", loading && "animate-spin")} />
          </button>
        </div>
      </div>

      {/* List */}
      <div className="flex-1 overflow-y-auto p-2 space-y-1">
        {worktrees.length === 0 && !loading && (
          <div className="flex flex-col items-center justify-center py-12 text-muted-foreground">
            <GitBranch className="size-8 mb-2 opacity-40" />
            <p className="text-sm">No worktrees</p>
            <p className="text-xs mt-1 text-center px-4">Create a new session with "Isolate in worktree" enabled</p>
          </div>
        )}

        {worktrees.map((wt) => (
          <div
            key={wt.name}
            className="rounded-lg border border-border p-3 hover:bg-elevation-1 transition-colors"
          >
            <div className="flex items-center justify-between mb-1">
              <div className="flex items-center gap-2 min-w-0">
                <span className="text-sm font-medium text-foreground truncate">{wt.name}</span>
                {wt.isDirty && (
                  <span className="flex h-2 w-2 shrink-0 rounded-full bg-amber-400" title="Has uncommitted changes" />
                )}
                {wt.commitsAhead > 0 && (
                  <Badge variant="outline" className="h-4 px-1 text-[9px] shrink-0">
                    {wt.commitsAhead} ahead
                  </Badge>
                )}
              </div>
              <div className="flex items-center gap-1 shrink-0">
                {wt.linkedSessions.length > 0 && (
                  <button
                    onClick={() => onOpenSession(wt.linkedSessions[0])}
                    className="rounded p-1 text-muted-foreground hover:text-foreground hover:bg-elevation-2 transition-colors"
                    title="Open session"
                  >
                    <ExternalLink className="size-3.5" />
                  </button>
                )}
                <button
                  onClick={() => handleCreatePr(wt)}
                  disabled={creatingPr === wt.name || wt.commitsAhead === 0}
                  className="rounded p-1 text-muted-foreground hover:text-foreground hover:bg-elevation-2 transition-colors disabled:opacity-30"
                  title="Create PR"
                >
                  <GitPullRequest className="size-3.5" />
                </button>
                <button
                  onClick={() => handleDelete(wt)}
                  disabled={deleting === wt.name}
                  className="rounded p-1 text-muted-foreground hover:text-red-400 hover:bg-red-500/10 transition-colors"
                  title="Delete worktree"
                >
                  <Trash2 className="size-3.5" />
                </button>
              </div>
            </div>

            <div className="flex items-center gap-2 text-[10px] text-muted-foreground">
              <span className="font-mono shrink-0">{wt.head}</span>
              <span className="truncate">{wt.headMessage}</span>
            </div>

            {wt.createdAt && (
              <div className="text-[10px] text-muted-foreground mt-0.5">
                {formatRelativeTime(wt.createdAt)}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}
