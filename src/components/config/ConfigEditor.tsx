import { useState, useEffect, useCallback } from "react"
import { Lock, Save, Undo2, Trash2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog"
import { Spinner } from "@/components/ui/Spinner"
import { cn } from "@/lib/utils"
import { authFetch } from "@/lib/auth"
import type { ConfigItem } from "./config-types"
import { BADGE_COLORS } from "./config-types"
import { ScopeBadge } from "./ScopeBadge"
import { CliBadge } from "./CliBadge"
import { LinkIndicator } from "./LinkIndicator"
import { HighlightedEditor } from "@/components/shared/HighlightedEditor"

interface ConfigEditorProps {
  file: ConfigItem
  onDeleted: () => void
  readOnly?: boolean
}

export function ConfigEditor({
  file,
  onDeleted,
  readOnly = false,
}: ConfigEditorProps) {
  const [content, setContent] = useState<string | null>(null)
  const [originalContent, setOriginalContent] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false)
  const [deleting, setDeleting] = useState(false)

  const hasChanges = content !== null && content !== originalContent
  const isReadOnly = readOnly || file.readOnly

  // Load file content
  useEffect(() => {
    setLoading(true)
    setContent(null)
    setOriginalContent(null)
    setSaved(false)
    setDeleteDialogOpen(false)

    authFetch(`/api/config-browser/file?path=${encodeURIComponent(file.path)}`)
      .then((res) => res.json())
      .then((data) => {
        setContent(data.content ?? "")
        setOriginalContent(data.content ?? "")
      })
      .catch(() => {
        setContent("")
        setOriginalContent("")
      })
      .finally(() => setLoading(false))
  }, [file.path])

  const handleSave = useCallback(async () => {
    if (!hasChanges || isReadOnly) return
    setSaving(true)
    try {
      const res = await authFetch("/api/config-browser/file", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: file.path, content }),
      })
      if (res.ok) {
        setOriginalContent(content)
        setSaved(true)
        setTimeout(() => setSaved(false), 2000)
      }
    } finally {
      setSaving(false)
    }
  }, [content, file.path, hasChanges, isReadOnly])

  const handleDiscard = useCallback(() => {
    setContent(originalContent)
  }, [originalContent])

  const handleDelete = useCallback(async () => {
    if (isReadOnly) return
    setDeleting(true)
    try {
      const res = await authFetch(`/api/config-browser/file?path=${encodeURIComponent(file.path)}`, {
        method: "DELETE",
      })
      if (res.ok) {
        setDeleteDialogOpen(false)
        onDeleted()
      }
    } catch { /* ignore */ }
    finally {
      setDeleting(false)
    }
  }, [file.path, isReadOnly, onDeleted])

  // Ctrl+S / Cmd+S to save
  useEffect(() => {
    function handler(e: KeyboardEvent): void {
      if (!isReadOnly && (e.metaKey || e.ctrlKey) && e.key === "s") {
        e.preventDefault()
        handleSave()
      }
    }
    window.addEventListener("keydown", handler)
    return () => window.removeEventListener("keydown", handler)
  }, [handleSave, isReadOnly])

  function getSaveLabel(): string {
    if (saved) return "Saved!"
    if (saving) return "Saving..."
    return "Save"
  }

  return (
    <div className="flex flex-1 flex-col min-h-0 min-w-0">
      <div className="flex min-h-11 shrink-0 items-center gap-2 border-b bg-card px-4 py-2">
        <Badge variant="outline" className={cn("h-5 text-xs", BADGE_COLORS[file.fileType] || "bg-muted text-muted-foreground")}>
          {file.fileType}
        </Badge>
        <ScopeBadge scope={file.scope} pluginName={file.pluginName} />
        <CliBadge cli={file.cli} variant="full" />
        {isReadOnly && (
          <Badge variant="outline" className="h-5 bg-muted text-xs text-muted-foreground">
            <Lock data-icon="inline-start" className="size-3" /> read-only
          </Badge>
        )}
        {hasChanges && (
          <span className="size-2 shrink-0 rounded-full bg-warning" title="Unsaved changes" />
        )}
        <div className="flex items-center gap-2 ml-auto min-w-0">
          <LinkIndicator linkTarget={file.linkTarget} variant="full" />
          <span className="truncate font-mono text-xs text-muted-foreground" title={file.path}>
            {file.path}
          </span>
        </div>
      </div>

      {loading ? (
        <div className="flex-1 flex items-center justify-center text-muted-foreground text-sm">
          Loading...
        </div>
      ) : (
        <div className="flex-1 min-h-0 overflow-hidden flex flex-col">
          <HighlightedEditor
            value={content ?? ""}
            onChange={setContent}
            readOnly={isReadOnly}
            filePath={file.path}
          />

          {!isReadOnly && (
            <div className="flex shrink-0 items-center gap-2 border-t bg-card px-4 py-2">
              <Button
                size="xs"
                onClick={handleSave}
                disabled={!hasChanges || saving}
              >
                <Save data-icon="inline-start" />
                {getSaveLabel()}
              </Button>
              <Button
                variant="outline"
                size="xs"
                onClick={handleDiscard}
                disabled={!hasChanges}
              >
                <Undo2 data-icon="inline-start" />
                Discard
              </Button>
              <div className="flex-1" />
              <AlertDialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
                <AlertDialogTrigger render={<Button variant="outline" size="xs" />}>
                  <Trash2 data-icon="inline-start" />
                  Delete
                </AlertDialogTrigger>
                <AlertDialogContent size="sm">
                  <AlertDialogHeader>
                    <AlertDialogTitle>Delete configuration file?</AlertDialogTitle>
                    <AlertDialogDescription>
                      Delete "{file.name}" permanently? This action cannot be undone.
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel size="sm" disabled={deleting}>Cancel</AlertDialogCancel>
                    <AlertDialogAction
                      variant="destructive"
                      size="sm"
                      disabled={deleting}
                      onClick={() => void handleDelete()}
                    >
                      {deleting && <Spinner data-icon="inline-start" />}
                      {deleting ? "Deleting..." : "Delete file"}
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
