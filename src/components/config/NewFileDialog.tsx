import { useEffect, useId, useRef, useState } from "react"
import { Globe, FolderCode, Save, X } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
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
  const nameId = useId()

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
    <FieldGroup className="gap-3 px-3 py-2">
      {hasBothScopes && (
        <Field>
          <FieldLabel>Scope</FieldLabel>
          <ToggleGroup
            aria-label="File scope"
            value={[scope]}
            onValueChange={(values) => {
              const nextScope = values[0]
              if (nextScope === "global" || nextScope === "project") {
                setScope(nextScope)
              }
            }}
            variant="outline"
            size="sm"
            spacing={0}
            className="w-full"
          >
            <ToggleGroupItem value="global" className="flex-1">
              <Globe data-icon="inline-start" />
              Global
            </ToggleGroupItem>
            <ToggleGroupItem value="project" className="flex-1">
              <FolderCode data-icon="inline-start" />
              Project
            </ToggleGroupItem>
          </ToggleGroup>
        </Field>
      )}
      <Field>
        <FieldLabel htmlFor={nameId}>
          {fileType.charAt(0).toUpperCase() + fileType.slice(1)} name
        </FieldLabel>
        <div className="flex items-center gap-1">
          <Input
            id={nameId}
            ref={inputRef}
            type="text"
            value={name}
            onChange={(event) => setName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") void handleCreate()
              if (event.key === "Escape") onCancel()
            }}
            placeholder={`${fileType} name...`}
            className="h-7 min-w-0 flex-1 text-xs"
            disabled={creating}
          />
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label={`Create ${fileType}`}
            onClick={() => void handleCreate()}
            disabled={creating || !name.trim() || !targetDir}
          >
            <Save data-icon="inline-start" />
          </Button>
          <Button variant="ghost" size="icon-xs" aria-label="Cancel create" onClick={onCancel}>
            <X data-icon="inline-start" />
          </Button>
        </div>
      </Field>
    </FieldGroup>
  )
}
