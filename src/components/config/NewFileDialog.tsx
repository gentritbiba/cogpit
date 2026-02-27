import { useState, useEffect, useRef } from "react"
import { Globe, FolderCode, Save, X } from "lucide-react"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { authFetch } from "@/lib/auth"

interface NewFileDialogProps {
  globalDir: string | null
  projectDir: string | null
  fileType: "command" | "skill" | "agent"
  onCreated: (path: string, fileType: string, scope: string) => void
  onCancel: () => void
}

export function NewFileDialog({
  globalDir,
  projectDir,
  fileType,
  onCreated,
  onCancel,
}: NewFileDialogProps) {
  const [name, setName] = useState("")
  const [scope, setScope] = useState<"global" | "project">(projectDir ? "project" : "global")
  const [creating, setCreating] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => { inputRef.current?.focus() }, [])

  const targetDir = scope === "project" && projectDir ? projectDir : globalDir
  const hasBothScopes = !!globalDir && !!projectDir

  async function handleCreate(): Promise<void> {
    if (!name.trim() || !targetDir) return
    setCreating(true)
    try {
      const res = await authFetch("/api/config-browser/create", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ dir: targetDir, fileType, name: name.trim() }),
      })
      if (res.ok) {
        const data = await res.json()
        onCreated(data.path, fileType, scope)
      }
    } finally {
      setCreating(false)
    }
  }

  return (
    <div className="px-3 py-1.5 space-y-1.5">
      {hasBothScopes && (
        <div className="flex items-center gap-1 rounded-md bg-elevation-0 p-0.5">
          <button
            className={cn(
              "flex-1 flex items-center justify-center gap-1 rounded px-2 py-0.5 text-[10px] font-medium transition-colors",
              scope === "global" ? "bg-blue-500/20 text-blue-400" : "text-muted-foreground hover:text-foreground",
            )}
            onClick={() => setScope("global")}
          >
            <Globe className="size-2.5" />
            Global
          </button>
          <button
            className={cn(
              "flex-1 flex items-center justify-center gap-1 rounded px-2 py-0.5 text-[10px] font-medium transition-colors",
              scope === "project" ? "bg-green-500/20 text-green-400" : "text-muted-foreground hover:text-foreground",
            )}
            onClick={() => setScope("project")}
          >
            <FolderCode className="size-2.5" />
            Project
          </button>
        </div>
      )}
      <div className="flex items-center gap-1">
        <input
          ref={inputRef}
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") handleCreate()
            if (e.key === "Escape") onCancel()
          }}
          placeholder={`${fileType} name...`}
          className="flex-1 bg-elevation-0 border border-border rounded px-2 py-1 text-xs text-foreground placeholder:text-muted-foreground/50 outline-none focus:border-blue-500/50 min-w-0"
          disabled={creating}
        />
        <Button variant="ghost" size="sm" className="h-6 w-6 p-0" onClick={handleCreate} disabled={creating || !name.trim()}>
          <Save className="size-3 text-green-400" />
        </Button>
        <Button variant="ghost" size="sm" className="h-6 w-6 p-0" onClick={onCancel}>
          <X className="size-3" />
        </Button>
      </div>
    </div>
  )
}
