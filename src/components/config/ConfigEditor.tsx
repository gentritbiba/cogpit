import { useState, useEffect, useCallback } from "react"
import { Lock, Save, Undo2, Trash2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { cn } from "@/lib/utils"
import { authFetch } from "@/lib/auth"
import type { ConfigItem } from "./config-types"
import { BADGE_COLORS } from "./config-types"
import { ScopeBadge } from "./ScopeBadge"
import { HighlightedEditor } from "./HighlightedEditor"

interface ConfigEditorProps {
  file: ConfigItem
  onDeleted: () => void
}

export function ConfigEditor({
  file,
  onDeleted,
}: ConfigEditorProps) {
  const [content, setContent] = useState<string | null>(null)
  const [originalContent, setOriginalContent] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)

  const hasChanges = content !== null && content !== originalContent

  // Load file content
  useEffect(() => {
    setLoading(true)
    setContent(null)
    setOriginalContent(null)
    setSaved(false)
    setConfirmDelete(false)

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
    if (!hasChanges || file.readOnly) return
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
  }, [content, file.path, file.readOnly, hasChanges])

  const handleDiscard = useCallback(() => {
    setContent(originalContent)
    setConfirmDelete(false)
  }, [originalContent])

  const handleDelete = useCallback(async () => {
    if (!confirmDelete) {
      setConfirmDelete(true)
      return
    }
    try {
      const res = await authFetch(`/api/config-browser/file?path=${encodeURIComponent(file.path)}`, {
        method: "DELETE",
      })
      if (res.ok) onDeleted()
    } catch { /* ignore */ }
  }, [confirmDelete, file.path, onDeleted])

  // Ctrl+S / Cmd+S to save
  useEffect(() => {
    function handler(e: KeyboardEvent): void {
      if ((e.metaKey || e.ctrlKey) && e.key === "s") {
        e.preventDefault()
        handleSave()
      }
    }
    window.addEventListener("keydown", handler)
    return () => window.removeEventListener("keydown", handler)
  }, [handleSave])

  function getSaveLabel(): string {
    if (saved) return "Saved!"
    if (saving) return "Saving..."
    return "Save"
  }

  return (
    <div className="flex flex-1 flex-col min-h-0 min-w-0">
      {/* Metadata bar */}
      <div className="flex items-center gap-2 px-4 py-2 border-b border-border/50 bg-elevation-1 shrink-0">
        <Badge variant="outline" className={cn("text-[10px] h-5", BADGE_COLORS[file.fileType] || "bg-zinc-500/20 text-zinc-300 border-zinc-500/30")}>
          {file.fileType}
        </Badge>
        <ScopeBadge scope={file.scope} pluginName={file.pluginName} />
        {file.readOnly && (
          <Badge variant="outline" className="text-[10px] h-5 bg-zinc-500/20 text-zinc-400 border-zinc-500/30">
            <Lock className="size-2.5 mr-0.5" /> read-only
          </Badge>
        )}
        {hasChanges && (
          <span className="size-2 rounded-full bg-amber-400 shrink-0" title="Unsaved changes" />
        )}
        <span className="text-[11px] font-mono text-muted-foreground/50 truncate ml-auto" title={file.path}>
          {file.path}
        </span>
      </div>

      {/* Editor */}
      {loading ? (
        <div className="flex-1 flex items-center justify-center text-muted-foreground text-sm">
          Loading...
        </div>
      ) : (
        <div className="flex-1 min-h-0 overflow-hidden flex flex-col">
          <HighlightedEditor
            value={content ?? ""}
            onChange={setContent}
            readOnly={file.readOnly}
            filePath={file.path}
          />

          {/* Action bar */}
          {!file.readOnly && (
            <div className="flex items-center gap-2 px-4 py-2 border-t border-border/50 bg-elevation-1 shrink-0">
              <Button
                variant="ghost"
                size="sm"
                className={cn(
                  "h-7 px-3 text-xs gap-1.5",
                  hasChanges ? "text-green-400 hover:text-green-300 hover:bg-green-500/10" : "text-muted-foreground",
                )}
                onClick={handleSave}
                disabled={!hasChanges || saving}
              >
                <Save className="size-3" />
                {getSaveLabel()}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className="h-7 px-3 text-xs gap-1.5 text-muted-foreground hover:text-foreground"
                onClick={handleDiscard}
                disabled={!hasChanges}
              >
                <Undo2 className="size-3" />
                Discard
              </Button>
              <div className="flex-1" />
              <Button
                variant="ghost"
                size="sm"
                className={cn(
                  "h-7 px-3 text-xs gap-1.5",
                  confirmDelete ? "text-red-400 bg-red-500/10 hover:bg-red-500/20" : "text-muted-foreground hover:text-red-400 hover:bg-red-500/10",
                )}
                onClick={handleDelete}
              >
                <Trash2 className="size-3" />
                {confirmDelete ? "Confirm delete?" : "Delete"}
              </Button>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
